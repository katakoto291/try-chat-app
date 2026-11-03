// このエージェントを A2A（Agent2Agent Protocol）でも呼べるようにする部品。
// 4 つのエージェント（vercel-ai-sdk / strands / claude-agent-sdk / trip-planner）で同じファイルを使っています。
//
// A2A は「独立したエージェント同士が仕事を頼み合う」ための標準のプロトコルです。
//   GET  /.well-known/agent-card.json … 自己紹介（Agent Card）。誰が・何をできるか・どこで受け付けるか
//   POST /                            … JSON-RPC。SendStreamingMessage でメッセージを送ると「タスク」が始まる
//
// 呼ばれたときに流すイベント（A2A の「タスク」の進み方）:
//   task(SUBMITTED) → statusUpdate(WORKING) → [ツール呼び出しのたびに statusUpdate(WORKING, data パート)]
//   → artifactUpdate（回答の文章を少しずつ）→ statusUpdate(COMPLETED)
//
// /invocations（AgentCore / Foundry の独自の約束）と違い、A2A は標準なので、
// A2A に対応したどのクライアントからも同じように呼べます（AgentCore の GetAgentCard API もこの Agent Card を返します）。

import { randomUUID } from "node:crypto";
import { Role, TaskState, type AgentCard, type Message, type Part } from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  UnauthenticatedUser,
  defaultServerCallContextBuilder,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";

/** 各エージェントが流す、共通の途中経過イベント */
export interface StreamEvent {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  result?: string;
  error?: string;
}

export interface A2aOptions {
  /** 公開する URL を受け取って Agent Card を作る関数（src/card.ts） */
  card: (publicUrl: string) => AgentCard;
  /** エージェントを 1 回動かして、途中経過を流す関数（src/agent.ts） */
  stream: (prompt: string) => AsyncIterable<StreamEvent>;
}

const textPart = (text: string): Part => ({ content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "text/plain" });
const dataPart = (value: unknown): Part => ({ content: { $case: "data", value }, metadata: undefined, filename: "", mediaType: "application/json" });
const textOf = (parts: Part[]) => parts.flatMap((p) => (p.content?.$case === "text" ? [p.content.value] : [])).join("\n");

/** A2A の「タスク」を実行する部分。届いたメッセージでエージェントを動かし、イベントを発行する */
class Executor implements AgentExecutor {
  constructor(private readonly stream: A2aOptions["stream"]) {}

  async execute({ taskId, contextId, userMessage }: RequestContext, bus: ExecutionEventBus) {
    const now = () => new Date().toISOString();
    const message = (parts: Part[]): Message => ({
      messageId: randomUUID(), contextId, taskId, role: Role.ROLE_AGENT, parts, metadata: undefined, extensions: [], referenceTaskIds: [],
    });
    const status = (state: TaskState, parts?: Part[]) =>
      bus.publish(AgentEvent.statusUpdate({ taskId, contextId, status: { state, message: parts ? message(parts) : undefined, timestamp: now() }, metadata: undefined }));
    const artifactId = randomUUID();
    let sentText = false;
    const artifact = (text: string, lastChunk: boolean) => {
      bus.publish(
        AgentEvent.artifactUpdate({
          taskId, contextId,
          artifact: { artifactId, name: "answer", description: "エージェントの回答", parts: [textPart(text)], metadata: undefined, extensions: [] },
          append: sentText, // 2 回目以降は「続き」として足していく
          lastChunk,
          metadata: undefined,
        }),
      );
      sentText = true;
    };

    // 1) 受け付けた → 2) 作業中
    bus.publish(AgentEvent.task({ id: taskId, contextId, status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: now() }, artifacts: [], history: [userMessage], metadata: undefined }));
    status(TaskState.TASK_STATE_WORKING);

    try {
      let result: string | undefined;
      for await (const ev of this.stream(textOf(userMessage.parts))) {
        // ツール呼び出しは「作業中」の状態更新に、構造化データ（data パート）として載せる
        if (ev.type === "tool_call") status(TaskState.TASK_STATE_WORKING, [dataPart({ type: "tool_call", name: ev.name, input: ev.input })]);
        // 回答の文章は成果物（Artifact）として少しずつ送る
        else if (ev.type === "text" && ev.text) artifact(ev.text, false);
        else if (ev.type === "result") result = ev.result;
        else if (ev.type === "error") throw new Error(ev.error);
      }
      // 3) 成果物の締めくくり（文章を流していなければ、最終回答をまとめて送る）→ 4) 完了
      artifact(sentText ? "" : (result ?? ""), true);
      status(TaskState.TASK_STATE_COMPLETED);
    } catch (err) {
      status(TaskState.TASK_STATE_FAILED, [textPart(err instanceof Error ? err.message : String(err))]);
    }
    bus.finished();
  }

  async cancelTask() {}
}

/** A2A の JSON-RPC の窓口を作る。公開 URL ごとに Agent Card が変わるので、URL ごとに用意する */
export function createA2a(options: A2aOptions) {
  const handlers = new Map<string, JsonRpcTransportHandler>();
  const handlerFor = (publicUrl: string) => {
    let h = handlers.get(publicUrl);
    if (!h) {
      h = new JsonRpcTransportHandler(new DefaultRequestHandler(options.card(publicUrl), new InMemoryTaskStore(), new Executor(options.stream)));
      handlers.set(publicUrl, h);
    }
    return h;
  };

  return {
    /** JSON-RPC を処理する。戻り値は 1 つの応答か、SSE で流すイベント列 */
    handle(publicUrl: string, body: unknown, headers: Headers) {
      const context = defaultServerCallContextBuilder({
        extensions: undefined,
        user: new UnauthenticatedUser(),
        headers: Object.fromEntries(headers),
        requestedVersion: headers.get("A2A-Version") ?? undefined,
      });
      return handlerFor(publicUrl).handle(body as Record<string, unknown>, context);
    },
  };
}

/**
 * Agent Card に載せる「このエージェントの公開 URL」。
 * AgentCore などでは外から見た URL とコンテナの中の URL が違うので、AGENT_URL で教える。
 */
export function publicUrlOf(requestUrl: string): string {
  const fromEnv = process.env.AGENT_URL?.trim();
  if (fromEnv) return fromEnv.endsWith("/") ? fromEnv : `${fromEnv}/`;
  return `${new URL(requestUrl).origin}/`;
}
