# try-chat-app — エージェント間の呼び出しを学ぶチャットアプリ

ChatGPT 風のチャット UI の裏側で、**司令塔エージェントが専門エージェントを「ツール」として呼び出す**仕組みを動かして観察するための学習用アプリです。
右側の「エージェント呼び出しトレース」で、誰が誰をどんな依頼(task)で呼び、何を返したかがリアルタイムに見えます。

入力欄の上で、次の 3 つの軸を切り替えて見比べられます。

| 軸 | 選択肢 | 何が変わるか |
|---|---|---|
| **連携パターン** | 呼び出し / ハンドオフ / Pub/Sub | 誰が主導権を持ち、どう協力するか |
| **プロトコル**（呼び出しのときだけ） | 直接 / MCP / A2A | エージェント同士が何の形式で通信するか |
| **画面との通信** | 独自 SSE / AG-UI | エージェントから画面へ、途中経過をどう届けるか |

トレースの「通信ログ」タブでは実際にやり取りされたメッセージ（JSON-RPC など）を、
「AG-UI イベント」タブでは画面が受け取った AG-UI の標準イベントを、そのまま確認できます。

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

5 つのエージェント（司令塔・リサーチャー・ライター・コーダー・レビュアー）を、連携パターンごとに違うつなぎ方で動かします。
つながりはすべて `server/agents/definitions.ts` に書いてあります。

```
■ 呼び出し: 司令塔 ─┬─ リサーチャー
                    ├─ ライター
                    └─ コーダー ── レビュアー

■ ハンドオフ: 司令塔 ⇒ リサーチャー ⇒ ライター
              司令塔 ⇒ ライター
              司令塔 ⇒ コーダー ⇒ レビュアー

■ Pub/Sub: research.requested → リサーチャー → research.completed → ライター → writing.completed
           writing.requested  → ライター     → writing.completed
           code.requested     → コーダー     → code.written       → レビュアー → review.completed
```

- 司令塔は簡単な質問には自分で答え、必要なときだけ専門エージェントを使います
- 独立した依頼は **同じターンで並列に** 呼ばれます（例: リサーチャーとライター）
- コーダーは自分でさらにレビュアーを呼びます（**入れ子の呼び出し**）
- 呼び出しの深さは `MAX_DEPTH`（既定 3）で制限しています

## 3 つの連携パターン

| | 呼び出し | ハンドオフ | Pub/Sub |
|---|---|---|---|
| 実装 | `server/agents/runAgent.ts` | `server/topologies/handoff.ts` | `server/topologies/pubsub.ts` |
| 使うツール | `call_<id>` | `transfer_to_<id>` | `publish_event` |
| 相手の指定 | 呼ぶ相手を名指し | 引き継ぐ相手を名指し | **指定しない**（トピックに投げるだけ） |
| 相手に渡すもの | `task` の文字列だけ | **会話全体** + 引き継ぎメモ | イベントの内容 |
| 結果 | 呼んだ側に**戻ってくる** | 戻らない。**主導権が移る** | 別のトピックに発行される（連鎖する） |
| ユーザーに答える人 | 司令塔 | 最後に引き継がれた担当者 | 司令塔（届いた結果を集約） |
| トレースの形 | 木（親子） | 一本の鎖 | イベントの因果関係の木 |

- **ハンドオフ** は OpenAI の Swarm / Agents SDK で広まった形です。電話の取り次ぎのように、担当が変わっていきます。
- **Pub/Sub** は本来 Redis / Kafka / NATS などのメッセージブローカーを使います。ここではプロセス内の小さなイベントバスで代用しています。
  リサーチ結果（`research.completed`）にライターと司令塔の両方が反応する「ファンアウト」も見られます。

## 3 つのプロトコル（連携パターンが「呼び出し」のとき）

同じ質問をプロトコルを変えて送り、「通信ログ」タブを見比べるのがおすすめです。

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

## 画面との通信: 独自 SSE と AG-UI

エージェントの途中経過（文章の断片、サブエージェントの開始・終了など）を、サーバーから画面へ届ける方法です。

- **独自 SSE**（`POST /api/chat`）: このアプリ専用のイベント（`shared/protocol.ts` の `ChatEvent`）を SSE で送ります。
- **AG-UI**（`POST /api/agui`）: [AG-UI](https://docs.ag-ui.com/) は「エージェント ↔ フロントエンド」の標準プロトコルです。
  サーバーは `ChatEvent` を AG-UI の標準イベントに変換して送り（`server/agui.ts`、`@ag-ui/encoder`）、
  画面は公式クライアントの `HttpAgent`（`@ag-ui/client`）で受け取ります（`web/src/agui.ts`）。

| このアプリのイベント | AG-UI のイベント |
|---|---|
| 実行の開始・終了 | `RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR` |
| 最上位のエージェント | `STEP_STARTED` / `STEP_FINISHED` |
| サブエージェント | `SUBAGENT_STARTED` / `SUBAGENT_FINISHED` / `SUBAGENT_ERROR` |
| 文章のストリーミング | `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT` / `TEXT_MESSAGE_END` |
| ツール呼び出し | `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END` / `TOOL_CALL_RESULT` |
| 通信ログ | `CUSTOM`（`name: "wire"`） |

標準イベントにない情報（callId やモデル名など）は、各イベントの `metadata` に載せています。
AG-UI に対応したフロントエンド（CopilotKit など）なら、同じ `/api/agui` をそのまま表示に使えるのが標準化の利点です。

## 仕組み（読む順番）

1. **`server/agents/definitions.ts`** — エージェントの定義。連携パターンごとのつながり（`call` / `handoff` / `pubsub`）とプロンプト
2. **`server/agents/runAgent.ts`** — 中心となるループ。どのパターンでも同じコードで、持たせる「道具箱（Toolbox）」だけが違う
   0. 道具箱を用意する（呼び出しなら `server/patterns/` の direct / MCP / A2A で相手に接続）
   1. モデルを呼ぶ
   2. 返答に `tool_use` があれば道具箱で実行（複数なら `Promise.all` で並列）
   3. 結果を `tool_result` として会話に足して 1 に戻る
   4. `tool_use` がなくなったら（ハンドオフしたら）そのテキストが最終回答
3. **`server/topologies/`** — ハンドオフと Pub/Sub の進め方
4. **`server/patterns/`** — 直接呼び出し・MCP・A2A それぞれの接続方法（サーバー側とクライアント側の両方）
5. **`server/index.ts`** — `POST /api/chat`（独自 SSE）と `POST /api/agui`（AG-UI）。`/mcp` と `/a2a/*` もここで公開
6. **`shared/protocol.ts`** — サーバー→ブラウザのイベント型（`agent_start` / `turn_start` / `text` / `tool_call` / `agent_end` …）。`callId` と `parentCallId` で呼び出しの木が復元できる
7. **`server/agui.ts`** と **`web/src/agui.ts`** — 上のイベントと AG-UI イベントの相互変換
8. **`web/src/trace.ts`** と **`web/src/components/TracePanel.tsx`** — イベントから木を組み立てて表示

ポイント: 「呼び出し」のサブエージェントは **呼び出し元の会話履歴を知りません**。渡されるのは `task` の文字列だけです。
そのため司令塔のプロンプトで「前提をすべて task に書くこと」と指示しています。ハンドオフでは逆に、会話全体を渡します。

## モデルについて

- 既定は全エージェント `claude-opus-5`。`.env` の `ORCHESTRATOR_MODEL` / `SUBAGENT_MODEL` で変更できます
- サブエージェントは `effort` を `medium` / `low` にして、待ち時間とコストを抑えています
- モデルがリクエストを断った場合に備え、サーバー側フォールバック（`fallbacks: "default"`）を有効にしています

## 試してみると面白い改造

- `definitions.ts` にエージェントを追加する（例: 翻訳担当）。`canCall` に入れるだけで呼べるようになります
- ハンドオフで、レビュアーにも `handoff.to: ["coder"]` を付けて、引き継ぎが往復する様子と上限（`MAX_HANDOFFS`）を見る
- Pub/Sub で、新しいトピックを購読するエージェントを足す（発行側のコードは一切変えずに反応する相手を増やせるのが Pub/Sub の利点）
- レビュアーにも `call.canCall: ["coder"]` を付けて、エージェント同士が呼び合う様子と `MAX_DEPTH` の効き方を見る
- `curl localhost:3000/a2a/coder/.well-known/agent-card.json` で Agent Card を直接見てみる
- MCP Inspector（`npx @modelcontextprotocol/inspector`）で `http://localhost:3000/mcp` に接続し、ツール一覧を見てみる
- `server/llm/mock.ts` を読んで、本物の API がどんな形のメッセージを返しているかを確認する
