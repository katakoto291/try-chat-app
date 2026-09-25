import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ChatEvent, ChatRequest, ConfigResponse } from "../shared/protocol.js";
import { AGENTS, modelFor } from "./agents/definitions.js";
import { runAgent } from "./agents/runAgent.js";
import { AnthropicModelClient } from "./llm/anthropic.js";
import { MockModelClient } from "./llm/mock.js";
import type { ModelClient } from "./llm/types.js";

const mode =
  process.env.LLM_MODE === "mock" || process.env.LLM_MODE === "anthropic"
    ? process.env.LLM_MODE
    : process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
      ? "anthropic"
      : "mock";
const client: ModelClient = mode === "anthropic" ? new AnthropicModelClient() : new MockModelClient();

const app = new Hono();

app.get("/api/config", (c) =>
  c.json<ConfigResponse>({
    mode: client.mode,
    agents: Object.values(AGENTS).map((a) => ({
      id: a.id,
      label: a.label,
      description: a.description,
      canCall: a.canCall,
      model: modelFor(a.id),
    })),
  }),
);

app.post("/api/chat", async (c) => {
  const body = (await c.req.json().catch(() => null)) as ChatRequest | null;
  const messages = body?.messages;
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages[messages.length - 1].role !== "user" ||
    !messages.every((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
  ) {
    return c.json({ error: "messages が不正です" }, 400);
  }

  return streamSSE(c, async (stream) => {
    // ブラウザが接続を切ったら（停止ボタンなど）、実行中のエージェントもすべて止める
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());

    // イベントは順番どおりに送りたいので、書き込みを 1 本の Promise チェーンに並べる
    let queue = Promise.resolve();
    const emit = (event: ChatEvent) => {
      queue = queue.then(() => stream.writeSSE({ data: JSON.stringify(event) })).catch(() => {});
    };

    try {
      await runAgent("orchestrator", messages, {
        client,
        emit,
        signal: controller.signal,
        depth: 0,
        parentCallId: null,
      });
      emit({ type: "done" });
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error(err);
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
    await queue;
  });
});

// 本番（npm run build 後）はビルド済みのフロントエンドも配信する
app.use("/*", serveStatic({ root: "./dist" }));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`API server: http://localhost:${port}  (LLM_MODE=${client.mode})`);
  if (client.mode === "mock") {
    console.log("ANTHROPIC_API_KEY が未設定のため、モックモードで動作します。");
  }
});
