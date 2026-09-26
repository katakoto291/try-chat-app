import type { BaseEvent } from "@ag-ui/core";
import type { AgentId, CallPattern, ChatEvent, Topology, Via, WireMessage } from "../../shared/protocol";
import type { Transport } from "./patterns";

/** 1 回のエージェント呼び出し（トレースの木の 1 ノード） */
export interface CallNode {
  callId: string;
  parentCallId: string | null;
  agent: AgentId;
  label: string;
  model: string;
  task: string;
  depth: number;
  /** どの方式で起動されたか */
  via: Via;
  /** ハンドオフで引き継いだ場合の、前の担当者 */
  handoffFrom?: string;
  /** 親エージェントの何ターン目の呼び出しか */
  parentTurn: number;
  /** モデル呼び出しごとのテキスト */
  turns: string[];
  children: string[];
  status: "running" | "done" | "error";
  output?: string;
  usage?: { input_tokens: number; output_tokens: number };
  startedAt: number;
  endedAt?: number;
}

/** 通信ログ 1 件 */
export interface WireEntry extends WireMessage {
  seq: number;
  /** 実行開始からの経過ミリ秒 */
  at: number;
  /** 送受信したエージェント（呼び出し側）の callId */
  callId: string;
}

/** AG-UI の生イベント 1 件（連続する *_CONTENT / *_ARGS は 1 行にまとめる） */
export interface AguiEntry {
  seq: number;
  at: number;
  type: string;
  /** まとめた件数 */
  count: number;
  /** まとめる単位（messageId / toolCallId） */
  key?: string;
  event: Record<string, unknown>;
}

export interface Trace {
  topology: Topology;
  pattern: CallPattern;
  transport: Transport;
  /** 最上位のエージェント。ハンドオフや Pub/Sub の集約では複数になる */
  rootIds: string[];
  calls: Record<string, CallNode>;
  /** エージェント間でやり取りされたメッセージ（時系列） */
  wires: WireEntry[];
  /** AG-UI で受け取った生イベント（transport が agui のときだけ） */
  agui: AguiEntry[];
  startedAt: number;
}

export const emptyTrace = (settings: { topology: Topology; pattern: CallPattern; transport: Transport }): Trace => ({
  ...settings,
  rootIds: [],
  calls: {},
  wires: [],
  agui: [],
  startedAt: Date.now(),
});

/** サーバーから届いたイベントを 1 つ反映した新しいトレースを返す */
export function applyEvent(trace: Trace, ev: ChatEvent): Trace {
  switch (ev.type) {
    case "agent_start": {
      const parent = ev.parentCallId ? trace.calls[ev.parentCallId] : undefined;
      const node: CallNode = {
        callId: ev.callId,
        parentCallId: ev.parentCallId,
        agent: ev.agent,
        label: ev.label,
        model: ev.model,
        task: ev.task,
        depth: ev.depth,
        via: ev.via,
        handoffFrom: ev.handoffFrom,
        parentTurn: parent ? parent.turns.length - 1 : 0,
        turns: [],
        children: [],
        status: "running",
        startedAt: Date.now(),
      };
      const calls = { ...trace.calls, [ev.callId]: node };
      if (parent) calls[parent.callId] = { ...parent, children: [...parent.children, ev.callId] };
      const rootIds = ev.parentCallId === null ? [...trace.rootIds, ev.callId] : trace.rootIds;
      return { ...trace, rootIds, calls };
    }
    case "turn_start":
      return update(trace, ev.callId, (n) => ({ ...n, turns: [...n.turns, ""] }));
    case "text":
      return update(trace, ev.callId, (n) => {
        const turns = [...n.turns];
        turns[ev.turn] = (turns[ev.turn] ?? "") + ev.delta;
        return { ...n, turns };
      });
    case "agent_end":
      return update(trace, ev.callId, (n) => ({
        ...n,
        status: ev.isError ? "error" : "done",
        output: ev.output,
        usage: ev.usage,
        endedAt: Date.now(),
      }));
    case "wire": {
      const { type: _type, ...wire } = ev;
      const entry: WireEntry = { ...wire, seq: trace.wires.length, at: Date.now() - trace.startedAt };
      return { ...trace, wires: [...trace.wires, entry] };
    }
    default:
      return trace;
  }
}

/** AG-UI の生イベントを記録する。ストリーミングの断片は 1 行にまとめる */
export function applyAguiEvent(trace: Trace, event: BaseEvent): Trace {
  const e = event as unknown as Record<string, unknown>;
  const key = (e.messageId ?? e.toolCallId) as string | undefined;
  const last = trace.agui[trace.agui.length - 1];
  const mergeable = event.type === "TEXT_MESSAGE_CONTENT" || event.type === "TOOL_CALL_ARGS";

  if (mergeable && last && last.type === event.type && last.key === key) {
    const merged = { ...last.event, delta: `${last.event.delta ?? ""}${e.delta ?? ""}` };
    return { ...trace, agui: [...trace.agui.slice(0, -1), { ...last, count: last.count + 1, event: merged }] };
  }
  const entry: AguiEntry = { seq: trace.agui.length, at: Date.now() - trace.startedAt, type: event.type, count: 1, key, event: e };
  return { ...trace, agui: [...trace.agui, entry] };
}

function update(trace: Trace, callId: string, fn: (n: CallNode) => CallNode): Trace {
  const node = trace.calls[callId];
  return node ? { ...trace, calls: { ...trace.calls, [callId]: fn(node) } } : trace;
}

/** チャット欄に表示する本文 = 最後の最上位エージェントの、最新ターンのテキスト */
export function rootText(trace: Trace): string {
  const root = trace.calls[trace.rootIds[trace.rootIds.length - 1]];
  if (!root) return "";
  if (root.output !== undefined) return root.output;
  return root.turns[root.turns.length - 1] ?? "";
}

export function totalUsage(trace: Trace) {
  return Object.values(trace.calls).reduce(
    (acc, n) => ({
      input: acc.input + (n.usage?.input_tokens ?? 0),
      output: acc.output + (n.usage?.output_tokens ?? 0),
    }),
    { input: 0, output: 0 },
  );
}
