import type { AgentId, CallPattern, ChatEvent, WireMessage } from "../../shared/protocol";

/** 1 回のエージェント呼び出し（トレースの木の 1 ノード） */
export interface CallNode {
  callId: string;
  parentCallId: string | null;
  agent: AgentId;
  label: string;
  model: string;
  task: string;
  depth: number;
  /** どの方式で呼び出されたか */
  via: CallPattern;
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

export interface Trace {
  pattern: CallPattern;
  rootId: string | null;
  calls: Record<string, CallNode>;
  /** エージェント間でやり取りされたメッセージ（時系列） */
  wires: WireEntry[];
  startedAt: number;
}

export const emptyTrace = (pattern: CallPattern): Trace => ({
  pattern,
  rootId: null,
  calls: {},
  wires: [],
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
        parentTurn: parent ? parent.turns.length - 1 : 0,
        turns: [],
        children: [],
        status: "running",
        startedAt: Date.now(),
      };
      const calls = { ...trace.calls, [ev.callId]: node };
      if (parent) calls[parent.callId] = { ...parent, children: [...parent.children, ev.callId] };
      return { ...trace, rootId: trace.rootId ?? ev.callId, calls };
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
