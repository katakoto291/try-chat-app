import type { AgentId, ChatEvent } from "../../shared/protocol";

/** 1 回のエージェント呼び出し（トレースの木の 1 ノード） */
export interface CallNode {
  callId: string;
  parentCallId: string | null;
  agent: AgentId;
  label: string;
  model: string;
  task: string;
  depth: number;
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

export interface Trace {
  rootId: string | null;
  calls: Record<string, CallNode>;
}

export const emptyTrace = (): Trace => ({ rootId: null, calls: {} });

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
        parentTurn: parent ? parent.turns.length - 1 : 0,
        turns: [],
        children: [],
        status: "running",
        startedAt: Date.now(),
      };
      const calls = { ...trace.calls, [ev.callId]: node };
      if (parent) calls[parent.callId] = { ...parent, children: [...parent.children, ev.callId] };
      return { rootId: trace.rootId ?? ev.callId, calls };
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
    default:
      return trace;
  }
}

function update(trace: Trace, callId: string, fn: (n: CallNode) => CallNode): Trace {
  const node = trace.calls[callId];
  return node ? { ...trace, calls: { ...trace.calls, [callId]: fn(node) } } : trace;
}

/** チャット欄に表示する本文 = 司令塔の最新ターンのテキスト */
export function rootText(trace: Trace): string {
  const root = trace.rootId ? trace.calls[trace.rootId] : undefined;
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
