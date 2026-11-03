# Claude Agent SDK 版

[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) で作った旅行アシスタントです。全体の説明は [../README.md](../README.md) を見てください。

## 読む順番

1. `src/tools.ts` — ツールの中身（天気・現地時刻）。他のサンプルと同じ普通の関数
2. `src/agent.ts` — エージェント本体。ツールを「プロセス内 MCP サーバー」にまとめ、`query()` に渡す
3. `src/server.ts` — AgentCore / Foundry の約束どおりの HTTP サーバー（`/ping`・`/readiness`・`/invocations`）
4. `src/cli.ts` — ターミナルから 1 回だけ動かす
5. `src/card.ts`・`src/a2a.ts` — 自己紹介（A2A の Agent Card）と、A2A で呼ばれたときの窓口（4 つのサンプルで共通）

## 動かす

```bash
npm install
cp .env.example .env     # MODEL_PROVIDER と認証情報を記入
npm run ask -- "東京とロンドンの天気と時刻を教えて"
npm run dev              # http://localhost:8080
```

## この SDK のポイント

- Claude Agent SDK は **Claude Code をライブラリとして使う** ものです。`query()` を呼ぶと裏で Claude Code が起動し、
  ループ・会話の管理・長い会話の圧縮・権限チェックなどを全部やってくれます（npm パッケージに実行ファイルが同梱されています）。
- 自作ツールは `tool()` で定義して `createSdkMcpServer()` にまとめます。Claude からは `mcp__travel__get_weather` という名前で見えます。
- 本来の強みは **組み込みツール**（ファイルの読み書き・Bash・Grep・Web 検索など）です。このサンプルではサーバーに置く前提なので
  `tools: []` で全部外し、`permissionMode: "dontAsk"` と `allowedTools` で「許可したツールだけ、確認なしで実行」にしています。
  たとえば `tools: ["Read", "Grep"]` にすると、コンテナ内のファイルを読んで答えるエージェントになります。
- つなぎ先は環境変数で切り替えます（`src/agent.ts` で `MODEL_PROVIDER` から組み立てています）。
  - Bedrock: `CLAUDE_CODE_USE_BEDROCK=1` + `AWS_REGION`（AWS の認証情報・AgentCore の実行ロールを使う）
  - Foundry: `CLAUDE_CODE_USE_FOUNDRY=1` + `ANTHROPIC_FOUNDRY_RESOURCE`（API キーがなければ Entra ID を使う）
- 結果の `total_cost_usd` で、1 回の実行にかかったおおよその料金が分かります。
