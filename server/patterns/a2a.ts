import { randomUUID } from "node:crypto";
import { Role, TaskState, type AgentCard, type Message, type Part } from "@a2a-js/sdk";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from "@a2a-js/sdk/client";
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
import type { AgentId } from "../../shared/protocol.js";
import { AGENTS, toolNameFor, type AgentDefinition } from "../agents/definitions.js";
import { runAgent } from "../agents/runAgent.js";
import { TRACE_META_KEY, contextFromMeta, type RunContext, type TraceMeta } from "../runs.js";
import { TASK_INPUT_SCHEMA, type PeerConnection } from "./types.js";
import { loggingFetch } from "./wireLog.js";

/**
 * パターン 3: A2A (Agent2Agent Protocol)
 *
 * A2A は「独立したエージェント同士が、対等な立場で仕事を頼み合う」ためのプロトコル。
 * 各エージェントが自分専用の A2A サーバー（/a2a/<id>）を持つ。
 *
 *   呼び出し側エージェント（A2A クライアント）          相手エージェント（A2A サーバー）
 *     GET /.well-known/agent-card.json ───────────▶  Agent Card（名前・説明・スキル・対応機能）
 *     SendStreamingMessage ───────────────────────▶  Task を作成し、状態の変化をストリームで返す
 *                           ◀─ task (SUBMITTED)
 *                           ◀─ statusUpdate (WORKING)
 *                           ◀─ artifactUpdate (成果物)
 *                           ◀─ statusUpdate (COMPLETED)
 *
 * ポイント:
 * - 相手の情報は Agent Card で "相手自身" が名乗る。入力スキーマはなく、自然言語のメッセージを送る
 * - 呼び出しは「タスク」として扱われ、SUBMITTED → WORKING → COMPLETED といった状態を持つ
 */

// ────────────────────────────── サーバー側 ──────────────────────────────

function textPart(text: string): Part {
  return { content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "text/plain" };
}

function textOf(parts: Part[]): string {
  return parts.flatMap((p) => (p.content?.$case === "text" ? [p.content.value] : [])).join("\n");
}

function agentCard(def: AgentDefinition, baseUrl: string): AgentCard {
  return {
    name: def.label,
    description: def.description,
    supportedInterfaces: [
      { url: `${baseUrl}/a2a/${def.id}`, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" },
    ],
    provider: undefined,
    version: "1.0.0",
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: def.id,
        name: def.label,
        description: def.description,
        tags: [def.id],
        examples: [],
        inputModes: ["text/plain"],
        outputModes: ["text/plain"],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };
}

/** A2A サーバーの中身。届いたメッセージを受けてエージェントを実行し、イベントを発行する */
class SubAgentExecutor implements AgentExecutor {
  constructor(private readonly agentId: AgentId) {}

  async execute(request: RequestContext, bus: ExecutionEventBus) {
    const { taskId, contextId, userMessage } = request;
    const status = (state: TaskState, text?: string) =>
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state,
          message: text ? agentMessage(text, taskId, contextId) : undefined,
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      });

    // 1) タスクを受け付けた
    bus.publish(
      AgentEvent.task({
        id: taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() },
        artifacts: [],
        history: [userMessage],
        metadata: undefined,
      }),
    );

    const ctx = contextFromMeta(userMessage.metadata?.[TRACE_META_KEY]);
    if (!ctx) {
      bus.publish(status(TaskState.TASK_STATE_FAILED, "トレース情報がありません"));
      bus.finished();
      return;
    }

    // 2) 作業中
    bus.publish(status(TaskState.TASK_STATE_WORKING));
    try {
      const { text: output } = await runAgent(this.agentId, [{ role: "user", content: textOf(userMessage.parts) }], ctx);
      // 3) 成果物（Artifact）を返す
      bus.publish(
        AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: {
            artifactId: randomUUID(),
            name: "result",
            description: `${AGENTS[this.agentId].label}の回答`,
            parts: [textPart(output)],
            metadata: undefined,
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: undefined,
        }),
      );
      // 4) 完了
      bus.publish(status(TaskState.TASK_STATE_COMPLETED));
    } catch (err) {
      bus.publish(status(TaskState.TASK_STATE_FAILED, String(err)));
    }
    bus.finished();
  }

  async cancelTask() {}
}

function agentMessage(text: string, taskId: string, contextId: string): Message {
  return {
    messageId: randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

const servers = new Map<string, { card: AgentCard; rpc: JsonRpcTransportHandler }>();

/** エージェントごとの A2A サーバー（Agent Card と JSON-RPC ハンドラ）を用意する */
export function a2aServerFor(agentId: string, baseUrl: string) {
  if (!(agentId in AGENTS) || agentId === "orchestrator") return undefined;
  let entry = servers.get(agentId);
  if (!entry) {
    const card = agentCard(AGENTS[agentId as AgentId], baseUrl);
    const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new SubAgentExecutor(agentId as AgentId));
    entry = { card, rpc: new JsonRpcTransportHandler(handler) };
    servers.set(agentId, entry);
  }
  return entry;
}

/** Hono から呼ばれる JSON-RPC ハンドラ。戻り値は 1 つの応答か、SSE で流すイベント列 */
export async function handleA2aRpc(rpc: JsonRpcTransportHandler, body: unknown, headers: Headers) {
  const context = defaultServerCallContextBuilder({
    extensions: undefined,
    user: new UnauthenticatedUser(),
    headers: Object.fromEntries(headers),
    requestedVersion: headers.get("A2A-Version") ?? undefined,
  });
  return rpc.handle(body as Record<string, unknown>, context);
}

// ────────────────────────────── クライアント側 ──────────────────────────────

export async function connectA2a(caller: AgentDefinition, callerCallId: string, ctx: RunContext): Promise<PeerConnection> {
  const fetchImpl = loggingFetch(ctx, callerCallId, "a2a");
  const resolver = new DefaultAgentCardResolver({ fetchImpl });
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory({ fetchImpl })],
      cardResolver: resolver,
    }),
  );

  // 相手ごとに Agent Card を取得し（ディスカバリー）、それをもとにツールを作る
  const peers = await Promise.all(
    caller.call.canCall.map(async (id) => {
      // 末尾の / がないと、相対パスの解決で最後の要素（id）が落ちてしまう
      const card = await resolver.resolve(`${ctx.baseUrl}/a2a/${id}/`);
      const client = await factory.createFromAgentCard(card);
      return { id, card, client };
    }),
  );

  return {
    tools: peers.map(({ id, card }) => ({
      name: toolNameFor(id),
      // A2A には入力スキーマがないので、Agent Card の説明とスキルからツールの説明を作る
      description: `${card.name}エージェント（A2A）に仕事を依頼する。${card.description} / スキル: ${card.skills
        .map((s) => s.name)
        .join("、")}`,
      input_schema: TASK_INPUT_SCHEMA,
      eager_input_streaming: true,
    })),

    async call(target, task) {
      const peer = peers.find((p) => p.id === target);
      if (!peer) return { text: `${target} は接続されていません`, isError: true };

      const meta: TraceMeta = { runId: ctx.runId, parentCallId: callerCallId, depth: ctx.depth + 1 };
      const stream = peer.client.sendMessageStream(
        {
          tenant: "",
          message: {
            messageId: randomUUID(),
            contextId: "",
            taskId: "",
            role: Role.ROLE_USER,
            parts: [textPart(task)],
            metadata: { [TRACE_META_KEY]: meta },
            extensions: [],
            referenceTaskIds: [],
          },
          configuration: undefined,
          metadata: undefined,
        },
        { signal: ctx.signal },
      );

      // ストリームで届くイベントから、成果物と最終状態を集める
      let text = "";
      let failed = false;
      for await (const event of stream) {
        const payload = event.payload;
        if (payload?.$case === "artifactUpdate" && payload.value.artifact) {
          text += textOf(payload.value.artifact.parts);
        } else if (payload?.$case === "statusUpdate") {
          const state = payload.value.status?.state;
          if (state === TaskState.TASK_STATE_FAILED) {
            failed = true;
            text ||= textOf(payload.value.status?.message?.parts ?? []);
          }
        } else if (payload?.$case === "message") {
          text += textOf(payload.value.parts);
        }
      }
      return { text, isError: failed };
    },

    async close() {},
  };
}
