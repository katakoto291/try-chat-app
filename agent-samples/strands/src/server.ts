// エージェントを HTTP で呼べるようにするサーバー（vercel-ai-sdk/src/server.ts と同じ約束）。
//   AgentCore Runtime … POST /invocations, GET /ping      , ポート 8080
//   Foundry hosted    … POST /invocations, GET /readiness , ポート 8088
//
// Strands の Python 版には AgentCore 用の公式ラッパー（bedrock-agentcore の BedrockAgentCoreApp）がありますが、
// TypeScript では自分で約束どおりのサーバーを書きます。といっても中身はこれだけです。

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { modelId, provider, runAgent, streamAgent } from "./agent.js";

const app = new Hono();
const meta = { framework: "strands", provider, model: modelId };

// 実行中は "HealthyBusy" を返すと、AgentCore はそのセッションを止めずに待ってくれます
let running = 0;
app.get("/ping", (c) =>
  c.json({ status: running > 0 ? "HealthyBusy" : "Healthy", time_of_last_update: Math.floor(Date.now() / 1000) }),
);
app.get("/readiness", (c) => c.text("OK"));

app.post("/invocations", async (c) => {
  const body = await c.req.json<{ prompt?: string; stream?: boolean }>().catch(() => null);
  const prompt = body?.prompt?.trim();
  if (!prompt) return c.json({ error: 'リクエストは {"prompt": "..."} の形で送ってください' }, 400);

  const sessionId =
    c.req.header("x-amzn-bedrock-agentcore-runtime-session-id") ?? c.req.query("agent_session_id") ?? "-";
  console.log(`[invoke] session=${sessionId} prompt=${JSON.stringify(prompt)}`);

  if (!body?.stream) {
    running++;
    try {
      return c.json({ ...meta, ...(await runAgent(prompt)) });
    } finally {
      running--;
    }
  }

  return streamSSE(c, async (sse) => {
    running++;
    try {
      for await (const ev of streamAgent(prompt)) await sse.writeSSE({ data: JSON.stringify(ev) });
      await sse.writeSSE({ data: JSON.stringify({ type: "done", ...meta }) });
    } catch (e) {
      await sse.writeSSE({ data: JSON.stringify({ type: "error", error: String(e) }) });
    } finally {
      running--;
    }
  });
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`[strands] http://localhost:${port}  (provider=${provider}, model=${modelId})`);
});
