// MCP サーバーを HTTP（Streamable HTTP）で公開する入り口。
//
// Bedrock AgentCore Runtime に MCP サーバーとして載せるときの約束:
//   POST /mcp で MCP の JSON-RPC を受ける、ポート 8000、状態を持たない（stateless）
// createMcpHandler は「リクエストごとにサーバーを作って 1 往復で返す」作りなので、この約束にそのまま合います。

import { serve } from "@hono/node-server";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { createServer } from "./mcpServer.js";

const mcp = createMcpHandler(() => createServer());

// MCP_BEARER_TOKEN を設定すると、Authorization: Bearer <その値> が付いたリクエストだけを受け付けます。
// AgentCore に置く場合は AgentCore 側が IAM で認証してくれるので不要です。
// Azure Container Apps など、URL がそのまま公開される場所に置くときは必ず設定してください。
const token = process.env.MCP_BEARER_TOKEN;

const app = new Hono();
app.all("/mcp", async (c) => {
  if (token && c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);
  return mcp.fetch(c.req.raw); // MCP の通信はすべてここ
});
app.get("/ping", (c) => c.json({ status: "Healthy", time_of_last_update: Math.floor(Date.now() / 1000) }));
app.get("/", (c) => c.text("travel-spots MCP server: POST /mcp"));

const port = Number(process.env.PORT ?? 8000);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`[mcp-server] http://localhost:${port}/mcp`);
});
