// エージェントを HTTP で呼べるようにするサーバー（vercel-ai-sdk/src/server.ts と同じ約束）。
//   AgentCore Runtime … POST /invocations, GET /ping      , ポート 8080
//   Foundry hosted    … POST /invocations, GET /readiness , ポート 8088

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { AGENT_CARD } from "./card.js";
import { modelId, provider, runAgent, toEvents } from "./agent.js";

const app = new Hono();
const meta = { framework: "claude-agent-sdk", provider, model: modelId };

// 実行中は "HealthyBusy" を返すと、AgentCore はそのセッションを止めずに待ってくれます
let running = 0;
app.get("/ping", (c) =>
  c.json({ status: running > 0 ? "HealthyBusy" : "Healthy", time_of_last_update: Math.floor(Date.now() / 1000) }),
);
app.get("/readiness", (c) => c.text("OK"));

// 自己紹介（Agent Card）。呼ぶ側が「誰が・何をできるか」を知るために読む
app.get("/.well-known/agent-card.json", (c) => c.json(AGENT_CARD));

app.post("/invocations", async (c) => {
  const body = await c.req.json<{ prompt?: string; stream?: boolean; action?: string }>().catch(() => null);
  if (body?.action === "describe") return c.json(AGENT_CARD); // /invocations しか届かない場所向けの自己紹介
  const prompt = body?.prompt?.trim();
  if (!prompt) return c.json({ error: 'リクエストは {"prompt": "..."} の形で送ってください' }, 400);

  const sessionId =
    c.req.header("x-amzn-bedrock-agentcore-runtime-session-id") ?? c.req.query("agent_session_id") ?? "-";
  console.log(`[invoke] session=${sessionId} prompt=${JSON.stringify(prompt)}`);

  if (!body?.stream) {
    running++;
    try {
      const toolCalls: { name: string; input: unknown }[] = [];
      for await (const message of runAgent(prompt)) {
        for (const ev of toEvents(message)) {
          if (ev.type === "tool_call") toolCalls.push({ name: ev.name, input: ev.input });
          if (ev.type === "result") return c.json({ ...meta, result: ev.result, toolCalls, turns: ev.turns, costUsd: ev.costUsd });
          if (ev.type === "error") return c.json({ ...meta, error: ev.error }, 500);
        }
      }
      return c.json({ ...meta, error: "結果が返りませんでした" }, 500);
    } finally {
      running--;
    }
  }

  return streamSSE(c, async (sse) => {
    running++;
    try {
      for await (const message of runAgent(prompt)) {
        for (const ev of toEvents(message)) await sse.writeSSE({ data: JSON.stringify(ev) });
      }
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
  console.log(`[claude-agent-sdk] http://localhost:${port}  (provider=${provider}, model=${modelId})`);
});
