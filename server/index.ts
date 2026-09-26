import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { Hono } from "hono";
import { stream, streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import type { CallPattern, ChatEvent, ChatRequest, ConfigResponse, Topology } from "../shared/protocol.js";
import { AGENTS, modelFor } from "./agents/definitions.js";
import { createAguiTranslator } from "./agui.js";
import { AnthropicModelClient } from "./llm/anthropic.js";
import { MockModelClient } from "./llm/mock.js";
import type { ModelClient } from "./llm/types.js";
import { a2aServerFor, handleA2aRpc } from "./patterns/a2a.js";
import { handleMcpRequest } from "./patterns/mcp.js";
import { registerRun } from "./runs.js";
import { executeChat } from "./topologies/index.js";

const mode =
  process.env.LLM_MODE === "mock" || process.env.LLM_MODE === "anthropic"
    ? process.env.LLM_MODE
    : process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
      ? "anthropic"
      : "mock";
const client: ModelClient = mode === "anthropic" ? new AnthropicModelClient() : new MockModelClient();

const port = Number(process.env.PORT ?? 3000);
/** MCP / A2A のクライアントが接続しに行く、このサーバー自身の URL */
const baseUrl = process.env.SELF_URL ?? `http://localhost:${port}`;
const TOPOLOGIES: Topology[] = ["call", "handoff", "pubsub"];
const PATTERNS: CallPattern[] = ["direct", "mcp", "a2a"];

type ChatMessages = ChatRequest["messages"];

const app = new Hono();

app.get("/api/config", (c) =>
  c.json<ConfigResponse>({
    mode: client.mode,
    agents: Object.values(AGENTS).map((a) => ({
      id: a.id,
      label: a.label,
      description: a.description,
      canCall: a.call.canCall,
      handoffTo: a.handoff.to,
      subscribes: a.pubsub.subscribes,
      publishes: a.pubsub.publishes,
      model: modelFor(a.id),
    })),
  }),
);

function validMessages(messages: unknown): messages is ChatMessages {
  return (
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages[messages.length - 1].role === "user" &&
    messages.every((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
  );
}

/**
 * 1 回のチャットを実行する（独自 SSE と AG-UI の両方から使う共通部分）。
 * 途中経過は ChatEvent として emit に流れる。
 */
async function runChat(
  req: { topology: Topology; pattern: CallPattern; messages: ChatMessages },
  emit: (event: ChatEvent) => void,
  signal: AbortSignal,
) {
  const run = { runId: randomUUID(), ...req, client, emit, signal, baseUrl };
  const unregister = registerRun(run);
  try {
    await executeChat(req.messages, { ...run, depth: 0, parentCallId: null });
    emit({ type: "done" });
  } catch (err) {
    if (!signal.aborted) {
      console.error(err);
      emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    unregister();
  }
}

/** 書き込みを 1 本の Promise チェーンに並べて、イベントの順番を保つ */
function orderedWriter(write: (data: string) => Promise<unknown>) {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    push: (data: string) => void (queue = queue.then(() => write(data)).catch(() => {})),
    flush: () => queue,
  };
}

// ───────── ブラウザとの通信 (1): このアプリ独自の SSE ─────────
app.post("/api/chat", async (c) => {
  const body = (await c.req.json().catch(() => null)) as ChatRequest | null;
  const topology = body?.topology ?? "call";
  const pattern = body?.pattern ?? "direct";
  if (!TOPOLOGIES.includes(topology) || !PATTERNS.includes(pattern) || !validMessages(body?.messages)) {
    return c.json({ error: "リクエストが不正です" }, 400);
  }
  const messages = body.messages;

  return streamSSE(c, async (sse) => {
    // ブラウザが接続を切ったら（停止ボタンなど）、実行中のエージェントもすべて止める
    const controller = new AbortController();
    sse.onAbort(() => controller.abort());
    const out = orderedWriter((data) => sse.writeSSE({ data }));

    await runChat({ topology, pattern, messages }, (event) => out.push(JSON.stringify(event)), controller.signal);
    await out.flush();
  });
});

// ───────── ブラウザとの通信 (2): AG-UI プロトコル ─────────
// リクエストは AG-UI の RunAgentInput、レスポンスは AG-UI イベントのストリーム
app.post("/api/agui", async (c) => {
  const input = (await c.req.json().catch(() => null)) as RunAgentInput | null;
  const props = (input?.forwardedProps ?? {}) as { topology?: Topology; pattern?: CallPattern };
  const topology = props.topology ?? "call";
  const pattern = props.pattern ?? "direct";
  // AG-UI のメッセージ（role + content）を、このアプリの形に変換する
  const messages = (input?.messages ?? [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : "" }));
  if (!input || !TOPOLOGIES.includes(topology) || !PATTERNS.includes(pattern) || !validMessages(messages)) {
    return c.json({ error: "リクエストが不正です" }, 400);
  }

  const encoder = new EventEncoder({ accept: c.req.header("accept") });
  c.header("Content-Type", encoder.getContentType());
  c.header("Cache-Control", "no-cache");

  return stream(c, async (s) => {
    const controller = new AbortController();
    s.onAbort(() => controller.abort());
    const out = orderedWriter((data) => s.write(data));

    const agui = createAguiTranslator(input.threadId, input.runId, (event: BaseEvent) => out.push(encoder.encode(event)));
    agui.start();
    await runChat({ topology, pattern, messages }, agui.handle, controller.signal);
    await out.flush();
  });
});

// ───────── パターン 2: MCP サーバー（サブエージェントを「ツール」として公開） ─────────
app.all("/mcp", (c) => handleMcpRequest(c.req.raw));

// ───────── パターン 3: A2A サーバー（エージェントごとに Agent Card と JSON-RPC 窓口） ─────────
app.get("/a2a/:agent/.well-known/agent-card.json", (c) => {
  const server = a2aServerFor(c.req.param("agent"), baseUrl);
  return server ? c.json(server.card) : c.notFound();
});

app.post("/a2a/:agent", async (c) => {
  const server = a2aServerFor(c.req.param("agent"), baseUrl);
  if (!server) return c.notFound();
  const body = await c.req.json().catch(() => null);
  const result = await handleA2aRpc(server.rpc, body, c.req.raw.headers);

  // SendStreamingMessage などは、イベント列を SSE で返す
  if (Symbol.asyncIterator in result) {
    return streamSSE(c, async (stream) => {
      for await (const event of result) await stream.writeSSE({ data: JSON.stringify(event) });
    });
  }
  return c.json(result);
});

// 本番（npm run build 後）はビルド済みのフロントエンドも配信する
app.use("/*", serveStatic({ root: "./dist" }));

serve({ fetch: app.fetch, port }, () => {
  console.log(`API server: http://localhost:${port}  (LLM_MODE=${client.mode})`);
  if (client.mode === "mock") {
    console.log("ANTHROPIC_API_KEY が未設定のため、モックモードで動作します。");
  }
});
