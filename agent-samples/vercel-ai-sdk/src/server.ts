// エージェントを HTTP で呼べるようにするサーバー。
// Bedrock AgentCore Runtime と Microsoft Foundry（hosted agents）は、どちらも
// 「コンテナの中で POST /invocations を受ける HTTP サーバー」を動かすだけの約束になっています。
//
//   AgentCore Runtime … POST /invocations, GET /ping       , ポート 8080
//   Foundry hosted    … POST /invocations, GET /readiness  , ポート 8088
//
// 違いはヘルスチェックのパスとポート番号くらいなので、両方に答えておけば同じコンテナがどちらでも動きます。

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { agent, modelId, provider } from "./agent.js";

const app = new Hono();
const meta = { framework: "vercel-ai-sdk", provider, model: modelId };

// --- ヘルスチェック ---------------------------------------------------------
// AgentCore: { status: "Healthy" | "HealthyBusy", time_of_last_update: UNIX 秒 }
app.get("/ping", (c) => c.json({ status: "Healthy", time_of_last_update: Math.floor(Date.now() / 1000) }));
// Foundry: 200 を返せば OK
app.get("/readiness", (c) => c.text("OK"));

// --- エージェントの呼び出し --------------------------------------------------
// リクエスト: { "prompt": "東京の天気は？", "stream": false }
app.post("/invocations", async (c) => {
  const body = await c.req.json<{ prompt?: string; stream?: boolean }>().catch(() => null);
  const prompt = body?.prompt?.trim();
  if (!prompt) return c.json({ error: 'リクエストは {"prompt": "..."} の形で送ってください' }, 400);

  // 実行基盤が付けてくるセッション ID（会話のまとまり）。このサンプルでは記録するだけ
  const sessionId =
    c.req.header("x-amzn-bedrock-agentcore-runtime-session-id") ?? c.req.query("agent_session_id") ?? "-";
  console.log(`[invoke] session=${sessionId} prompt=${JSON.stringify(prompt)}`);

  // ストリーミングなし: 最後まで実行して、答えだけを JSON で返す
  if (!body?.stream) {
    const result = await agent.generate({ prompt });
    const toolCalls = result.steps.flatMap((s) => s.toolCalls.map((t) => ({ name: t.toolName, input: t.input })));
    return c.json({ ...meta, result: result.text, toolCalls, usage: result.totalUsage });
  }

  // ストリーミングあり: 途中経過（文章の断片・ツール呼び出し）を SSE で順に送る
  return streamSSE(c, async (sse) => {
    const send = (data: unknown) => sse.writeSSE({ data: JSON.stringify(data) });
    const result = await agent.stream({ prompt });
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") await send({ type: "text", text: part.text });
      else if (part.type === "tool-call") await send({ type: "tool_call", name: part.toolName, input: part.input });
      else if (part.type === "tool-result") await send({ type: "tool_result", name: part.toolName, output: part.output });
      else if (part.type === "error") await send({ type: "error", error: String(part.error) });
    }
    await send({ type: "done", ...meta });
  });
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`[vercel-ai-sdk] http://localhost:${port}  (provider=${provider}, model=${modelId})`);
});
