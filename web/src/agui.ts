import { HttpAgent } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
import type { CallPattern, ChatEvent, ChatRequest, Topology } from "../../shared/protocol";

/**
 * AG-UI プロトコルでサーバーと通信する。
 *
 * AG-UI の公式クライアント（HttpAgent）に会話を渡して実行すると、
 * RUN_STARTED / TEXT_MESSAGE_CONTENT / SUBAGENT_STARTED … といった標準イベントが届く。
 * 画面のトレース表示は独自形式（ChatEvent）で作っているので、ここで変換して渡す。
 * 変換前の生のイベントは onRaw に渡し、「AG-UI イベント」タブに表示する。
 */
export async function streamChatAgui(
  settings: { topology: Topology; pattern: CallPattern },
  messages: ChatRequest["messages"],
  onEvent: (event: ChatEvent) => void,
  onRaw: (event: BaseEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const agent = new HttpAgent({
    url: "/api/agui",
    // AG-UI のメッセージは id / role / content を持つ
    initialMessages: messages.map((m, i) => ({ id: `msg-${i}`, role: m.role, content: m.content })),
  });
  signal.addEventListener("abort", () => agent.abortRun());

  let failure: string | undefined;
  await agent.runAgent(
    // forwardedProps は、AG-UI の仕様外の設定をサーバーに渡すための入れ物
    { forwardedProps: settings },
    {
      onEvent({ event }) {
        onRaw(event);
        const translated = toChatEvent(event);
        if (translated) onEvent(translated);
      },
      onRunFailed({ error }) {
        failure = error.message;
      },
    },
  );
  if (signal.aborted) throw new Error("aborted");
  if (failure) throw new Error(failure);
}

/** AG-UI の標準イベントを、トレース表示用のイベントに戻す（追加情報は metadata から読む） */
function toChatEvent(event: BaseEvent): ChatEvent | undefined {
  const e = event as BaseEvent & Record<string, any>;
  const md = (e.metadata ?? {}) as Record<string, any>;

  switch (event.type) {
    case EventType.STEP_STARTED:
    case EventType.SUBAGENT_STARTED:
      return {
        type: "agent_start",
        callId: md.callId,
        parentCallId: md.parentCallId ?? null,
        agent: md.agent,
        label: e.stepName ?? e.name,
        model: md.model,
        task: md.task ?? "",
        depth: md.depth ?? 0,
        via: md.via ?? "direct",
        handoffFrom: md.handoffFrom,
      };
    case EventType.TEXT_MESSAGE_START:
      return { type: "turn_start", callId: md.callId, turn: md.turn };
    case EventType.TEXT_MESSAGE_CONTENT: {
      // messageId は "<callId>:<turn>" の形にしてある
      const [callId, turn] = String(e.messageId).split(":");
      return { type: "text", callId, turn: Number(turn), delta: e.delta };
    }
    case EventType.STEP_FINISHED:
      return { type: "agent_end", callId: md.callId, output: md.output ?? "", isError: !!md.isError, usage: md.usage };
    case EventType.SUBAGENT_FINISHED:
      return { type: "agent_end", callId: e.subagentRunId, output: String(e.result ?? ""), isError: false, usage: md.usage };
    case EventType.SUBAGENT_ERROR:
      return { type: "agent_end", callId: e.subagentRunId, output: e.message, isError: true, usage: md.usage };
    case EventType.CUSTOM:
      return e.name === "wire" ? { type: "wire", ...e.value } : undefined;
    case EventType.RUN_ERROR:
      return { type: "error", message: e.message };
    case EventType.RUN_FINISHED:
      return { type: "done" };
    default:
      return undefined;
  }
}
