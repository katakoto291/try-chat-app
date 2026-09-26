import type { AgentId, Topic } from "../../shared/protocol.js";
import { AGENTS, REQUEST_TOPICS } from "../agents/definitions.js";
import { runAgent, type Toolbox } from "../agents/runAgent.js";
import type { BetaMessageParam } from "../llm/types.js";
import type { RunContext } from "../runs.js";

/** 1 回の実行で流せるイベントの上限（反応の連鎖が止まらないのを防ぐ） */
const MAX_EVENTS = 20;

/**
 * 連携パターン: Pub/Sub（イベント駆動）
 *
 *   司令塔 ──publish──▶ [research.requested] ──▶ リサーチャー
 *                                                    │ publish
 *                       [research.completed] ◀───────┘
 *                            │          │
 *                            ▼          ▼
 *                        ライター    司令塔（集約用に購読）
 *
 * - 発行者は「誰が処理するか」を知らない。トピックに投げるだけ
 * - 購読者は届いたイベントに反応して動き、結果を別のトピックに発行する（連鎖が起きる）
 * - 司令塔は結果のトピックを購読しておき、イベントが出尽くしたら（バスが静かになったら）まとめる
 *
 * 本物のシステムでは、ここは Redis / Kafka / NATS などのメッセージブローカーが担う。
 */

interface BusEvent {
  id: number;
  topic: Topic;
  content: string;
  /** 発行したエージェント */
  publisher: { callId: string; agent: AgentId; depth: number };
}

type Handler = (event: BusEvent) => Promise<void>;

/** 最小限のイベントバス（プロセス内） */
class EventBus {
  private subscribers = new Map<Topic, { name: string; handler: Handler }[]>();
  private pending = 0;
  private count = 0;
  private waiters: (() => void)[] = [];

  constructor(private readonly ctx: RunContext) {}

  subscribe(topic: Topic, name: string, handler: Handler) {
    this.subscribers.set(topic, [...(this.subscribers.get(topic) ?? []), { name, handler }]);
  }

  publish(topic: Topic, content: string, publisher: BusEvent["publisher"]) {
    const event: BusEvent = { id: ++this.count, topic, content, publisher };
    const subs = this.subscribers.get(topic) ?? [];

    this.ctx.emit({
      type: "wire",
      callId: publisher.callId,
      protocol: "pubsub",
      direction: "request",
      label: `PUBLISH ${topic}`,
      url: `topic: ${topic}`,
      body: content,
    });
    if (this.count > MAX_EVENTS) return;

    // 購読者ごとに非同期で配送する。発行者は配送の完了を待たない
    for (const sub of subs) {
      this.pending++;
      this.ctx.emit({
        type: "wire",
        callId: publisher.callId,
        protocol: "pubsub",
        direction: "event",
        label: `DELIVER ${topic} → ${sub.name}`,
        url: `topic: ${topic}`,
        body: `イベント #${event.id} を ${sub.name} に配送`,
      });
      void sub
        .handler(event)
        .catch(() => {})
        .finally(() => {
          if (--this.pending === 0) this.waiters.splice(0).forEach((resolve) => resolve());
        });
    }
  }

  /** 配送中のイベントがなくなる（バスが静かになる）まで待つ */
  idle(): Promise<void> {
    return this.pending === 0 ? Promise.resolve() : new Promise((resolve) => this.waiters.push(resolve));
  }
}

export async function runPubSub(messages: BetaMessageParam[], ctx: RunContext): Promise<string> {
  const root = { ...ctx, depth: 0, parentCallId: null };
  const bus = new EventBus(root);
  const collected: BusEvent[] = [];

  // 1) 各エージェントを、担当のトピックに購読させる
  for (const def of Object.values(AGENTS)) {
    if (def.id === "orchestrator") continue;
    for (const topic of def.pubsub.subscribes) {
      bus.subscribe(topic, def.label, async (event) => {
        const { callId, text } = await runAgent(
          def.id,
          [{ role: "user", content: `[イベント ${event.topic}]\n${event.content}` }],
          // トレース上は「イベントの発行者」の子として表示する
          { ...ctx, depth: event.publisher.depth + 1, parentCallId: event.publisher.callId },
          { via: "pubsub", toolbox: async () => undefined },
        );
        // 2) 処理結果を、自分の担当トピックに発行する（これにまた誰かが反応するかもしれない）
        for (const out of def.pubsub.publishes) {
          bus.publish(out, text, { callId, agent: def.id, depth: event.publisher.depth + 1 });
        }
      });
    }
  }

  // 司令塔は結果のトピックを購読して、届いたものを貯めておく
  for (const topic of AGENTS.orchestrator.pubsub.subscribes) {
    bus.subscribe(topic, "司令塔（集約）", async (event) => void collected.push(event));
  }

  // 3) 司令塔がユーザーの依頼を受け、必要ならイベントを発行する
  const first = await runAgent("orchestrator", messages, root, {
    toolbox: async (callId) => publishToolbox(bus, callId),
  });

  // 4) イベントの連鎖が落ち着くまで待つ
  await bus.idle();
  if (collected.length === 0) return first.text;

  // 5) 届いた結果をまとめて、司令塔がもう一度回答する
  const results = collected
    .map((e) => `### ${e.topic}（発行: ${AGENTS[e.publisher.agent].label}）\n${e.content}`)
    .join("\n\n");
  const final = await runAgent(
    "orchestrator",
    [
      ...messages,
      { role: "assistant", content: first.text || "（イベントを発行しました）" },
      { role: "user", content: `[購読していたイベントが届きました]\n\n${results}\n\nこれらを統合して、最初の質問への回答をまとめてください。` },
    ],
    root,
    { via: "pubsub", toolbox: async () => undefined },
  );
  return final.text;
}

/** publish_event ツール。発行したら即座に戻る（誰が処理するかは知らない） */
function publishToolbox(bus: EventBus, callId: string): Toolbox {
  return {
    tools: [
      {
        name: "publish_event",
        description:
          "イベントを発行する。そのトピックを購読しているエージェントが自動で処理する。誰が処理するかは指定できない。発行してもすぐには結果は返らない。",
        input_schema: {
          type: "object",
          properties: {
            topic: { type: "string", enum: REQUEST_TOPICS, description: "発行するトピック" },
            content: { type: "string", description: "処理に必要な前提をすべて含めた依頼内容" },
          },
          required: ["topic", "content"],
          additionalProperties: false,
        },
        eager_input_streaming: true,
      },
    ],
    async run(toolUse) {
      const { topic, content } = (toolUse.input ?? {}) as { topic?: unknown; content?: unknown };
      if (typeof topic !== "string" || !REQUEST_TOPICS.includes(topic as Topic) || typeof content !== "string") {
        return { content: `不正なイベントです: ${JSON.stringify(toolUse.input)}`, isError: true };
      }
      bus.publish(topic as Topic, content, { callId, agent: "orchestrator", depth: 0 });
      return { content: `${topic} を発行しました。結果は購読しているトピックに届きます。` };
    },
  };
}
