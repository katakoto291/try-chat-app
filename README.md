# try-chat-app — エージェント間の呼び出しを学ぶチャットアプリ

ChatGPT 風のチャット UI の裏側で、**司令塔エージェントが専門エージェントを「ツール」として呼び出す**仕組みを動かして観察するための学習用アプリです。
右側の「エージェント呼び出しトレース」で、誰が誰をどんな依頼(task)で呼び、何を返したかがリアルタイムに見えます。

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

## 仕組み（読む順番）

1. **`server/agents/definitions.ts`** — エージェントの定義。`canCall` に書いた相手が `call_<id>` というツールとして見える
2. **`server/agents/runAgent.ts`** — 中心となるループ
   1. モデルを呼ぶ（呼べる相手をツールとして渡す）
   2. 返答に `tool_use` があれば、相手エージェントを `runAgent` で **再帰的に** 実行（複数なら `Promise.all` で並列）
   3. 結果を `tool_result` として会話に足して 1 に戻る
   4. `tool_use` がなくなったらそのテキストが最終回答
3. **`server/index.ts`** — `POST /api/chat` で司令塔を起動し、途中経過を SSE（Hono の `streamSSE`）で送る
4. **`shared/protocol.ts`** — サーバー→ブラウザのイベント型（`agent_start` / `turn_start` / `text` / `tool_call` / `agent_end` …）。`callId` と `parentCallId` で呼び出しの木が復元できる
5. **`web/src/trace.ts`** と **`web/src/components/TracePanel.tsx`** — イベントから木を組み立てて表示

ポイント: サブエージェントは **呼び出し元の会話履歴を知りません**。渡されるのは `task` の文字列だけです。そのため司令塔のプロンプトで「前提をすべて task に書くこと」と指示しています。

## モデルについて

- 既定は全エージェント `claude-opus-5`。`.env` の `ORCHESTRATOR_MODEL` / `SUBAGENT_MODEL` で変更できます
- サブエージェントは `effort` を `medium` / `low` にして、待ち時間とコストを抑えています
- モデルがリクエストを断った場合に備え、サーバー側フォールバック（`fallbacks: "default"`）を有効にしています

## 試してみると面白い改造

- `definitions.ts` にエージェントを追加する（例: 翻訳担当）。`canCall` に入れるだけで呼べるようになります
- レビュアーにも `canCall: ["coder"]` を付けて、エージェント同士が呼び合う様子と `MAX_DEPTH` の効き方を見る
- `server/llm/mock.ts` を読んで、本物の API がどんな形のメッセージを返しているかを確認する
