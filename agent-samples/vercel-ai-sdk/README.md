# Vercel AI SDK 版

[Vercel AI SDK](https://ai-sdk.dev/) の `ToolLoopAgent` で作った旅行アシスタントです。全体の説明は [../README.md](../README.md) を見てください。

## 読む順番

1. `src/tools.ts` — ツールの中身（天気・現地時刻）。どの SDK でも同じ普通の関数
2. `src/model.ts` — どこの Claude を使うか（`MODEL_PROVIDER`）。ここだけ差し替えれば Anthropic / Bedrock / Foundry を行き来できる
3. `src/agent.ts` — エージェント本体。`ToolLoopAgent` に model・instructions・tools・stopWhen を渡すだけ
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

- `tool({ description, inputSchema: z.object(...), execute })` で、ツールの説明・入力の型・中身を 1 か所に書けます。
  Zod の型から JSON Schema が作られ、`execute` の引数にも型が付きます。
- `stopWhen: stepCountIs(8)` が「ループの上限」です。上限がないと、ツールを呼び続けて止まらないことがあります。
- `agent.generate()` は最後まで実行して結果を返し、`agent.stream()` は途中経過（`fullStream`）を少しずつ返します。
- モデルの提供元ごとにプロバイダのパッケージが分かれています。
  - Anthropic API / Foundry: `@ai-sdk/anthropic`（Foundry は `baseURL` を `https://<リソース名>.services.ai.azure.com/anthropic/v1` にする）
  - Bedrock: `@ai-sdk/amazon-bedrock/anthropic`（AWS の認証情報は `fromNodeProviderChain()` で、AgentCore の実行ロールも自動で使われる）
- Next.js などの Web アプリに組み込むなら、`agent.stream()` の結果をそのまま `useChat` に流せるのがこの SDK の強みです。
