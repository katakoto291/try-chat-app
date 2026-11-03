# 観光プランナー（MCP を使うエージェント）

天気と観光スポットを調べて、日帰りの観光プランを作るエージェントです（Strands Agents の TypeScript 版）。
観光スポットの情報は自分では持たず、**MCP サーバー（[../mcp-server](../mcp-server)）のツールを使います**。
全体の説明は [../README.md](../README.md) を見てください。

## 旅行アシスタント（../strands）との違い

| | 旅行アシスタント | 観光プランナー |
|---|---|---|
| 自分で持つツール | `get_weather`、`get_local_time` | `get_weather` だけ |
| MCP サーバーのツール | なし | `search_spots`、`get_spot_details` |
| 指示（instructions） | 聞かれたことに答える | 天気 → スポット検索 → 詳細確認 → プラン作成の順に考える |

Claude からは、自分のツールも MCP のツールも同じ「ツール」に見えます。
コードの違いは、`tools` に MCP クライアントを 1 つ足しただけです（`src/agent.ts`）。

```ts
const mcp = new McpClient({ url: "http://localhost:8000/mcp" });
const agent = new Agent({ model, systemPrompt, tools: [getWeatherTool, mcp] });
```

## 読む順番

1. `src/weather.ts` — 自分で持つツール（天気）と、エージェントへの指示文
2. `src/mcp.ts` — **MCP サーバーへのつなぎ方**（認証なし / Bearer トークン / AWS の SigV4）
3. `src/agent.ts` — エージェント本体。自分のツールと MCP クライアントを並べて渡す
4. `src/model.ts`・`src/server.ts`・`src/cli.ts` — 旅行アシスタントと同じ

## 動かす

```bash
# ターミナル 1: MCP サーバー
cd ../mcp-server && npm install && npm run dev

# ターミナル 2: 観光プランナー
npm install
cp .env.example .env     # MODEL_PROVIDER と認証情報を記入（MCP_SERVER_URL はそのままで OK）
npm run ask -- "雨でも楽しめる大阪の日帰りプランを作って"
npm run dev              # http://localhost:8080 で HTTP サーバーとして起動
```

## MCP サーバーへの認証（`MCP_AUTH`）

MCP サーバーをどこに置いたかで変わります。

| `MCP_AUTH` | 使う場面 | 送るもの |
|---|---|---|
| `none` | ローカル、社内ネットワーク | なし |
| `bearer` | Azure Container Apps などに置いた MCP サーバー、OAuth で守られた MCP サーバー | `Authorization: Bearer <MCP_BEARER_TOKEN>` |
| `sigv4` | **AgentCore Runtime に置いた MCP サーバー** | AWS の署名（このエージェントの実行ロールの権限で呼ぶ） |

`sigv4` は、MCP の SDK に「送る前に AWS の署名を付ける fetch」を渡して実現しています（`src/mcp.ts` の `sigv4Fetch`）。
AgentCore の上で動かすときは、このエージェントの実行ロールに、MCP サーバーのランタイムを呼ぶ権限
（`bedrock-agentcore:InvokeAgentRuntime`）が必要です。`scripts/agentcore-deploy.sh` が付けます。

## デプロイ

```bash
# AgentCore: MCP サーバー → 観光プランナー の順に
./scripts/agentcore-deploy.sh mcp-server
MCP_SERVER_URL='<上で表示された URL>' ./scripts/agentcore-deploy.sh trip-planner
```

Foundry の場合は、MCP サーバーを Azure Container Apps などに置いてから、
`azd env set MCP_SERVER_URL ...` と `azd env set MCP_BEARER_TOKEN ...` を設定して `azd deploy trip-planner-agent` します。
