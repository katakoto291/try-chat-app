# try-chat-app — エージェント間の呼び出しを学ぶチャットアプリ

ChatGPT 風のチャット UI の裏側で、**司令塔エージェントが専門エージェントを「ツール」として呼び出す**仕組みを動かして観察するための学習用アプリです。
右側の「エージェント呼び出しトレース」で、誰が誰をどんな依頼(task)で呼び、何を返したかがリアルタイムに見えます。

エージェント同士のつなぎ方は **直接呼び出し / MCP / A2A** の 3 パターンを画面上で切り替えられ、
「通信ログ」タブで実際にやり取りされた JSON-RPC メッセージをそのまま確認できます。

- フロントエンド: Vite + React + TypeScript
- サーバー: Hono（Node.js）+ Anthropic TypeScript SDK
- API キーがなくても **モックモード** で呼び出しの流れを体験できます

## 使い方

```bash
npm install
cp .env.example .env   # 本物の Claude を使う場合は ANTHROPIC_API_KEY を記入
npm run dev            # http://localhost:5173 を開く
```

| コマンド | 内容 |
|---|---|
| `npm run dev` | API サーバー(:3000) と Vite(:5173) を同時起動。`/api` は Vite が :3000 に転送 |
| `npm run build` | フロントエンドを `dist/` にビルド |
| `npm start` | API サーバーを起動し、`dist/` も配信（http://localhost:3000） |
| `npm run typecheck` | サーバー・フロント両方の型チェック |

`ANTHROPIC_API_KEY` が未設定なら自動でモックモードになります（`LLM_MODE=mock|anthropic` で明示指定も可）。

## エージェント構成

```
司令塔 (orchestrator) ─┬─ リサーチャー (researcher)
                        ├─ ライター (writer)
                        └─ コーダー (coder) ── レビュアー (reviewer)
```

- 司令塔は簡単な質問には自分で答え、必要なときだけ専門エージェントを呼びます
- 独立した依頼は **同じターンで並列に** 呼ばれます（例: リサーチャーとライター）
- コーダーは自分でさらにレビュアーを呼びます（**入れ子の呼び出し**）
- 呼び出しの深さは `MAX_DEPTH`（既定 3）で制限しています

## 3 つの呼び出しパターン

入力欄の上の「呼び出し方式」で切り替えます。同じ質問を方式を変えて送り、「通信ログ」タブを見比べるのがおすすめです。

| | 直接呼び出し | MCP | A2A |
|---|---|---|---|
| 実装 | `server/patterns/direct.ts` | `server/patterns/mcp.ts` | `server/patterns/a2a.ts` |
| 呼ばれる側は | 関数 | **ツール**（入力スキーマ付きの関数） | **エージェント**（状態を持つタスクの担当者） |
| 相手の知り方 | 自分のコードに書いてある | `tools/list` でサーバーに聞く（JSON Schema 付き） | Agent Card（`/.well-known/agent-card.json`）を読む |
| 呼び出し | `runAgent()` | `tools/call` → 結果の `content` | `SendStreamingMessage` → Task の状態変化と Artifact がストリームで届く |
| 入力 | `task` 文字列 | JSON Schema で決まった引数 | 自然言語のメッセージ（parts） |
| 通信 | なし（同一プロセス） | JSON-RPC over HTTP（Streamable HTTP） | JSON-RPC over HTTP + SSE |
| エンドポイント | — | `POST /mcp`（全サブエージェントを 1 つのサーバーで公開） | `POST /a2a/<id>`（エージェントごとに独立） |

- **MCP** は「LLM アプリに外部のツールやデータをつなぐ」ためのプロトコル。サブエージェントをツールとして包むと、呼び出し側からは普通のツールと区別がつきません。ツールの定義はサーバー側が決めます。
- **A2A** は「独立したエージェント同士が対等に仕事を頼み合う」ためのプロトコル。相手は自分で Agent Card を名乗り、依頼は `SUBMITTED → WORKING → COMPLETED` と状態が進む「タスク」として扱われます。
- どちらも公式 SDK を使っています（`@modelcontextprotocol/sdk`、`@a2a-js/sdk` v1.0）。Hono 上で動かすため、MCP は Web 標準の `WebStandardStreamableHTTPServerTransport`、A2A は `JsonRpcTransportHandler` を直接つないでいます。
- 通信ログは、SDK に「記録付きの fetch」（`server/patterns/wireLog.ts`）を渡して取っています。

### 学習用の近道について

すべてのサーバーは 1 つのプロセス（:3000）の中で動いています。MCP / A2A の先で動くサブエージェントの途中経過をブラウザに届けるため、
呼び出し時に `runId` を MCP の `_meta` / A2A の `metadata` に載せ、受け側がプロセス内の `Map`（`server/runs.ts`）から送信口を取り出しています。
本物の分散システムでは、この部分は OpenTelemetry などの分散トレーシングが担います。

## 仕組み（読む順番）

1. **`server/agents/definitions.ts`** — エージェントの定義。`canCall` に書いた相手が `call_<id>` というツールとして見える
2. **`server/agents/runAgent.ts`** — 中心となるループ
   0. 呼べる相手に接続する（`server/patterns/` の 3 パターンのどれか）
   1. モデルを呼ぶ（呼べる相手をツールとして渡す）
   2. 返答に `tool_use` があれば、接続を通して相手エージェントを実行（複数なら `Promise.all` で並列）
   3. 結果を `tool_result` として会話に足して 1 に戻る
   4. `tool_use` がなくなったらそのテキストが最終回答
3. **`server/patterns/`** — 直接呼び出し・MCP・A2A それぞれの接続方法（サーバー側とクライアント側の両方）
4. **`server/index.ts`** — `POST /api/chat` で司令塔を起動し、途中経過を SSE（Hono の `streamSSE`）で送る。`/mcp` と `/a2a/*` もここで公開
5. **`shared/protocol.ts`** — サーバー→ブラウザのイベント型（`agent_start` / `turn_start` / `text` / `tool_call` / `agent_end` …）。`callId` と `parentCallId` で呼び出しの木が復元できる
6. **`web/src/trace.ts`** と **`web/src/components/TracePanel.tsx`** — イベントから木を組み立てて表示

ポイント: サブエージェントは **呼び出し元の会話履歴を知りません**。渡されるのは `task` の文字列だけです。そのため司令塔のプロンプトで「前提をすべて task に書くこと」と指示しています。

## モデルについて

- 既定は全エージェント `claude-opus-5`。`.env` の `ORCHESTRATOR_MODEL` / `SUBAGENT_MODEL` で変更できます
- サブエージェントは `effort` を `medium` / `low` にして、待ち時間とコストを抑えています
- モデルがリクエストを断った場合に備え、サーバー側フォールバック（`fallbacks: "default"`）を有効にしています

## 試してみると面白い改造

- `definitions.ts` にエージェントを追加する（例: 翻訳担当）。`canCall` に入れるだけで呼べるようになります
- レビュアーにも `canCall: ["coder"]` を付けて、エージェント同士が呼び合う様子と `MAX_DEPTH` の効き方を見る
- `curl localhost:3000/a2a/coder/.well-known/agent-card.json` で Agent Card を直接見てみる
- MCP Inspector（`npx @modelcontextprotocol/inspector`）で `http://localhost:3000/mcp` に接続し、ツール一覧を見てみる
- `server/llm/mock.ts` を読んで、本物の API がどんな形のメッセージを返しているかを確認する
