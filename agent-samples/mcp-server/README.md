# MCP サーバー（観光スポット検索）

エージェントに「観光スポットを調べる道具」を提供する MCP サーバーです。
これを使うエージェントの例は [../trip-planner](../trip-planner)、全体の説明は [../README.md](../README.md) を見てください。

## MCP とは

**MCP（Model Context Protocol）は「AI に道具やデータを渡すための共通の形」** です。

ツールをエージェントのコードの中に書くと、そのエージェント専用になります。
MCP サーバーとして切り出すと、**どの SDK のエージェントからでも、URL を教えるだけで同じツールが使えます**。
Claude Code や Claude Desktop などの AI アプリからも使えます。

```
 エージェント（Strands / Vercel AI SDK / Claude Agent SDK / Claude Code …）
      │  ① tools/list   「どんな道具がある？」
      │  ② tools/call   「search_spots を {city: 東京} で実行して」
      ▼
 MCP サーバー（このフォルダ）── 本物なら DB や社内 API につなぐ
```

MCP サーバーが公開できるものは 3 種類あります。このサーバーは全部を 1 つずつ持っています。

| 種類 | このサーバーでの例 | 誰が使うか |
|---|---|---|
| ツール（tools） | `search_spots`、`get_spot_details` | AI が自分で判断して呼ぶ。**エージェントが使うのは主にこれ** |
| リソース（resources） | `spots://all`（全スポットの JSON） | アプリや利用者が選んで読み込む |
| プロンプト（prompts） | `plan_day_trip`（日帰りプランの頼み方のひな形） | 利用者がメニューから選んで使う |

## 読む順番

1. `src/spots.ts` — データと検索処理。MCP のことは何も知らない普通のコード
2. `src/mcpServer.ts` — **MCP サーバーとして何を公開するか**（`registerTool` / `registerResource` / `registerPrompt`）
3. `src/server.ts` — HTTP（Streamable HTTP）で公開する入り口。`POST /mcp`、ポート 8000
4. `src/client.ts` — 素の MCP クライアントでつないで、一覧を取ってツールを呼んでみる（SDK が裏でやっていること）

## 動かす

```bash
npm install
npm run dev              # http://localhost:8000/mcp
npm run inspect          # 別のターミナルで。ツール・リソース・プロンプトの一覧と、ツールの呼び出し結果を表示
```

公式の MCP Inspector（`npx @modelcontextprotocol/inspector`）で `http://localhost:8000/mcp` につなぐと、画面で試せます。

Claude Code から使うこともできます。

```bash
claude mcp add --transport http travel-spots http://localhost:8000/mcp
```

## 作りのポイント

- 公式 SDK の v2（`@modelcontextprotocol/server`）を使っています。
  `createMcpHandler()` は **リクエストごとにサーバーを作って 1 往復で返す（状態を持たない）** 作りです。
  新しい形式（2026-07-28 版）のクライアントにも、従来の形式（2025 年版）のクライアントにも答えます。
- 状態を持たないので、何台に増やしても、どのコンテナがリクエストを受けても同じ結果になります。これは AgentCore の約束でもあります。
- 見つからないときは `isError: true` を返しています。AI は「失敗した」と分かるので、別の ID で試すなど次の手を考えられます。
- `annotations: { readOnlyHint: true }` は「データを書き換えないツール」という目印です。使う側が並列に呼んだり、確認を省いたりする判断に使えます。

## どこに置くか

| 置き場所 | やり方 | 認証 |
|---|---|---|
| ローカル | `npm run dev` | なし |
| **Bedrock AgentCore Runtime** | `./scripts/agentcore-deploy.sh mcp-server`（プロトコルを `MCP` にして作成） | **IAM（SigV4）**。AgentCore が確認してくれる。OAuth（JWT）に切り替えることもできる |
| Azure Container Apps など | `az containerapp up --source . --target-port 8000 --ingress external ...` | URL が公開されるので、**`MCP_BEARER_TOKEN` を必ず設定**する |

Foundry の hosted agents は「エージェント」を載せる場所なので、MCP サーバーそのものは載せません。
Azure では Container Apps などに置き、エージェントにその URL を渡します（Foundry の Toolbox に MCP サーバーとして登録する方法もあります）。

`MCP_BEARER_TOKEN` は学習用の簡単な合言葉チェックです。本番では OAuth（Entra ID や Cognito のトークン）を使うのが普通です。
