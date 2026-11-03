# Strands Agents 版（TypeScript）

[Strands Agents](https://strandsagents.com/) の TypeScript 版（npm パッケージ `@strands-agents/sdk`）で作った旅行アシスタントです。
全体の説明は [../README.md](../README.md) を見てください。

## 読む順番

1. `src/tools.ts` — ツールの中身（天気・現地時刻）。他のサンプルと同じ普通の関数
2. `src/model.ts` — どこの Claude を使うか（`MODEL_PROVIDER`）。`BedrockModel` / `AnthropicModel` を差し替えるだけ
3. `src/agent.ts` — エージェント本体。`new Agent({ model, tools, systemPrompt })` と、イベントの受け取り方
4. `src/server.ts` — AgentCore / Foundry の約束どおりの HTTP サーバー（`/ping`・`/readiness`・`/invocations`）
5. `src/cli.ts` — ターミナルから 1 回だけ動かす

## 動かす

```bash
npm install
cp .env.example .env     # MODEL_PROVIDER と認証情報を記入
npm run ask -- "東京とロンドンの天気と時刻を教えて"
npm run dev              # http://localhost:8080
```

## この SDK のポイント

- ツールは `tool({ name, description, inputSchema: z.object(...), callback })` で書きます。Vercel AI SDK とよく似た形です。
- `new Agent({ model, tools, systemPrompt })` を作って `agent.invoke(prompt)`（最後まで実行）か `agent.stream(prompt)`（途中経過を受け取る）を呼ぶだけでループが回ります。
  `stream()` からは `modelStreamUpdateEvent`（文章の断片など）、`beforeToolCallEvent`（ツール呼び出しの直前）、`agentResultEvent`（最終結果）などのイベントが届きます。
- `Agent` は会話履歴（`agent.messages`）を自分の中に持つので、**リクエストごとに作り直しています**。使い回すと別の人の会話が混ざります。
- 既定では途中経過を標準出力に書く（`printer: true`）ので、サーバーでは `printer: false` にしています。
- モデルを指定しないと Bedrock の Claude を使います。このサンプルでは明示的に次のように切り替えています。
  - Bedrock: `BedrockModel`（中で AWS SDK を使うので、AgentCore の実行ロールも自動で使われる）
  - Anthropic API: `AnthropicModel`
  - Foundry: `AnthropicModel` に、つなぎ先を `https://<リソース名>.services.ai.azure.com/anthropic` にした Anthropic SDK のクライアントを渡す。
    API キーがなければ、リクエストのたびに Entra ID のトークンを `Authorization: Bearer` に付けます
- ファイル操作・シェル・HTTP リクエスト・サブエージェントなどの「すぐ使えるツール」（`@strands-agents/sdk/vended-tools/...`）も同梱されています。
- Python 版には AgentCore 用の公式ラッパー（`bedrock-agentcore` の `BedrockAgentCoreApp`）がありますが、TypeScript では `src/server.ts` のように約束どおりのサーバーを自分で書きます。
