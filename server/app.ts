import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { Hono } from "hono";
import { stream, streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import type { CallPattern, ChatEvent, ChatRequest, ConfigResponse, Topology } from "../shared/protocol.js";
import { AGENTS, modelFor } from "./agents/definitions.js";
import { authEnabled, login, logout, requireLogin } from "./auth.js";
import { createAguiTranslator } from "./agui.js";
import { AnthropicModelClient } from "./llm/anthropic.js";
import { MockModelClient } from "./llm/mock.js";
import type { ModelClient } from "./llm/types.js";
import { a2aServerFor, handleA2aRpc } from "./patterns/a2a.js";
import { handleMcpRequest } from "./patterns/mcp.js";
import { registerRun } from "./runs.js";
import { executeChat } from "./topologies/index.js";

/**
 * Hono アプリ本体。ローカル（server/index.ts）でも Vercel（api/index.ts）でも、これをそのまま使う。
 */

const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
let mode: "anthropic" | "mock" =
  process.env.LLM_MODE === "mock" || process.env.LLM_MODE === "anthropic" ? process.env.LLM_MODE : hasKey ? "anthropic" : "mock";

// 公開環境（Vercel）で合言葉なしに本物の API を使うと、誰でも料金を使えてしまうので止める
if (process.env.VERCEL && mode === "anthropic" && !authEnabled) {
  console.warn("APP_PASSWORD が未設定のため、安全のためモックモードで動作します。");
  mode = "mock";
}
export const client: ModelClient = mode === "anthropic" ? new AnthropicModelClient() : new MockModelClient();

const TOPOLOGIES: Topology[] = ["call", "handoff", "pubsub"];
const PATTERNS: CallPattern[] = ["direct", "mcp", "a2a"];

type ChatMessages = ChatRequest["messages"];

export const app = new Hono();

/**
 * MCP / A2A のクライアントが「自分自身のサーバー」に送るリクエストは、ネットワークに出さず
 * このアプリの fetch に直接渡す（ループバック）。やり取りされる HTTP リクエスト/レスポンスは同じ。
 * こうしておくと、Vercel のようにリクエストごとに別のインスタンスが動く環境でも、
 * 同じ実行（run）の中で完結する。
 */
const loopbackFetch: typeof fetch = (input, init) => Promise.resolve(app.fetch(new Request(input, init)));

// ───────── 合言葉ログイン（APP_PASSWORD を設定したときだけ有効） ─────────
app.post("/api/login", login);
app.post("/api/logout", logout);
app.use("/api/*", requireLogin);

app.get("/api/config", (c) =>
  c.json<ConfigResponse>({
    mode: client.mode,
    auth: authEnabled,
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
  baseUrl: string,
) {
  const run = { runId: randomUUID(), ...req, client, emit, signal, baseUrl, fetch: loopbackFetch };
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

    await runChat({ topology, pattern, messages }, (event) => out.push(JSON.stringify(event)), controller.signal, originOf(c.req.url));
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
    await runChat({ topology, pattern, messages }, agui.handle, controller.signal, originOf(c.req.url));
    await out.flush();
  });
});

// ───────── パターン 2: MCP サーバー（サブエージェントを「ツール」として公開） ─────────
app.all("/mcp", (c) => handleMcpRequest(c.req.raw));

// ───────── パターン 3: A2A サーバー（エージェントごとに Agent Card と JSON-RPC 窓口） ─────────
app.get("/a2a/:agent/.well-known/agent-card.json", (c) => {
  const server = a2aServerFor(c.req.param("agent"), originOf(c.req.url));
  return server ? c.json(server.card) : c.notFound();
});

app.post("/a2a/:agent", async (c) => {
  const server = a2aServerFor(c.req.param("agent"), originOf(c.req.url));
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

/**
 * Agent Card などに載せる、このサーバー自身の URL。
 * SELF_URL が空・不正なときは、アクセスされた URL から決める
 * （.env.example をそのまま使うと SELF_URL= が空文字で入るため）。
 */
function originOf(url: string): string {
  for (const candidate of [process.env.SELF_URL?.trim(), url]) {
    if (!candidate) continue;
    try {
      const origin = new URL(candidate).origin;
      if (origin !== "null") return origin;
    } catch {
      // 不正な URL は無視して次の候補へ
    }
  }
  return "http://localhost";
}
