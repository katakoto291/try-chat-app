// agent-hub: エージェントの登録所。
//
//   GET    /agents                    … 登録されているエージェントの一覧（自己紹介と状態つき）
//   GET    /agents/:id                … 1 つのエージェントの自己紹介（Agent Card）
//   POST   /agents                    … エージェントを登録 {"url"} / {"a2aUrl"} / {"agentCoreArn", "protocol"?}
//   DELETE /agents/:id                … 登録を外す
//   POST   /agents/:id/invocations    … エージェントを呼ぶ（本文と途中経過の SSE をそのまま中継する）
//   POST   /mcp                       … ハブ自身を MCP サーバーとして公開（list_agents / call_agent）
//
// 使う側（チャットアプリなど）は、ハブの URL だけ知っていればよく、
// 各エージェントの場所・認証方式（IAM の署名など）・生死の確認はハブが引き受けます。

import { serve } from "@hono/node-server";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { createHubMcpServer } from "./mcp.js";
import { checkHealth, getAgent, invoke, listAgents, register, removeAgent, type HubAgent, type Registration } from "./registry.js";

// HUB_TOKEN を設定すると、Authorization: Bearer <HUB_TOKEN> が付いたリクエストだけを受け付けます（/ping 以外）。
// ハブを通せば登録された全エージェントを呼べるので、ローカル以外に置くときは必ず設定してください。
const HUB_TOKEN = process.env.HUB_TOKEN;
const HEALTH_INTERVAL_MS = 30_000;

const app = new Hono();

app.get("/ping", (c) => c.json({ status: "Healthy", agents: listAgents().length }));

app.use("*", async (c, next) => {
  if (HUB_TOKEN && c.req.header("authorization") !== `Bearer ${HUB_TOKEN}`) return c.json({ error: "unauthorized" }, 401);
  await next();
});

const summary = (a: HubAgent) => ({
  id: a.id,
  name: a.card.name ?? a.id,
  description: a.card.description ?? "",
  skills: (a.card.skills ?? []).map((s) => s.name ?? "").filter(Boolean),
  status: a.status,
  lastSeen: a.lastSeen,
  lastError: a.lastError,
  // 呼ぶ側には、相手の本当の URL ではなく「ハブ経由の URL」を教える
  invokePath: `/agents/${a.id}/invocations`,
  // 相手の呼び方（ハブの外からは同じ形で呼べるが、中では invocations か A2A かで変換している）
  protocol: a.protocol,
  location: a.auth === "sigv4" ? "AgentCore Runtime" : (a.registration.url ?? a.registration.a2aUrl),
});

app.get("/agents", (c) => c.json({ agents: listAgents().map(summary) }));

app.get("/agents/:id", (c) => {
  const agent = getAgent(c.req.param("id"));
  return agent ? c.json(agent.card) : c.json({ error: "not found" }, 404);
});

app.post("/agents", async (c) => {
  const reg = (await c.req.json().catch(() => null)) as Registration | null;
  try {
    const agent = await register(reg ?? {});
    console.log(`[hub] 登録: ${agent.id}（${agent.protocol} ${agent.endpoint}）`);
    return c.json(summary(agent), 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.delete("/agents/:id", (c) => (removeAgent(c.req.param("id")) ? c.body(null, 204) : c.json({ error: "not found" }, 404)));

// 呼び出しの中継。本文もレスポンス（SSE の途中経過を含む）も、そのまま流す
app.post("/agents/:id/invocations", async (c) => {
  const agent = getAgent(c.req.param("id"));
  if (!agent) return c.json({ error: "not found" }, 404);
  if (agent.status === "unhealthy") return c.json({ error: `「${agent.id}」は今つながりません: ${agent.lastError ?? ""}` }, 503);

  const body = await c.req.text();
  const res = await invoke(agent, body, c.req.raw.signal);
  console.log(`[hub] 中継: ${agent.id} → HTTP ${res.status}`);
  return new Response(res.body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-cache" },
  });
});

// ハブ自身の MCP サーバー
const mcp = createMcpHandler(() => createHubMcpServer());
app.all("/mcp", (c) => mcp.fetch(c.req.raw));

// --- 起動時の登録と、定期的な生存確認 ------------------------------------------
// HUB_AGENTS=http://localhost:8080,a2a:http://localhost:8081/,arn:aws:bedrock-agentcore:...,a2a:arn:aws:bedrock-agentcore:...
//   a2a: を付けると A2A 方式で登録する
// まだ起動していないエージェントもあるので、登録できなかったものは定期的にやり直す
let pending: Registration[] = (process.env.HUB_AGENTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((item): Registration => {
    const a2a = item.startsWith("a2a:");
    const value = a2a ? item.slice(4) : item;
    if (value.startsWith("arn:")) return { agentCoreArn: value, protocol: a2a ? "a2a" : "invocations" };
    return a2a ? { a2aUrl: value } : { url: value };
  });

async function registerPending() {
  const failed: Registration[] = [];
  for (const reg of pending) {
    await register(reg)
      .then((a) => console.log(`[hub] 登録: ${a.id}（${a.protocol} ${a.endpoint}）`))
      .catch((err) => {
        failed.push(reg);
        console.warn(`[hub] まだ登録できません（あとで再試行）: ${reg.url ?? reg.a2aUrl ?? reg.agentCoreArn}（${err instanceof Error ? err.message : err}）`);
      });
  }
  pending = failed;
}

setInterval(() => void Promise.all([registerPending(), ...listAgents().map(checkHealth)]), HEALTH_INTERVAL_MS).unref();

const port = Number(process.env.PORT ?? 8090);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`[agent-hub] http://localhost:${port}  (GET /agents, POST /mcp)`);
  void registerPending();
});
