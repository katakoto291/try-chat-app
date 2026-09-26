import { EventType, type BaseEvent } from "@ag-ui/core";
import type { ChatEvent } from "../shared/protocol.js";

/**
 * このアプリ独自のイベント（ChatEvent）を、AG-UI の標準イベントに変換する。
 *
 * AG-UI は「エージェント ↔ フロントエンド」をつなぐプロトコル。
 * どんなエージェント実装でも、このイベント列さえ出せば同じ UI で表示できる。
 *
 *   ChatEvent                   → AG-UI イベント
 *   ─────────────────────────────────────────────────────────────
 *   (開始)                       → RUN_STARTED
 *   agent_start（最上位）        → STEP_STARTED
 *   agent_start（サブエージェント） → SUBAGENT_STARTED
 *   turn_start / text            → TEXT_MESSAGE_START / TEXT_MESSAGE_CONTENT / TEXT_MESSAGE_END
 *   tool_call                    → TOOL_CALL_START / TOOL_CALL_ARGS / TOOL_CALL_END
 *   tool_result                  → TOOL_CALL_RESULT
 *   agent_end                    → SUBAGENT_FINISHED / SUBAGENT_ERROR / STEP_FINISHED
 *   wire（通信ログ）             → CUSTOM（name: "wire"）
 *   done / error                 → RUN_FINISHED / RUN_ERROR
 *
 * 標準イベントにない情報（callId やモデル名など）は、各イベントの metadata に載せている。
 */
export function createAguiTranslator(threadId: string, runId: string, send: (event: BaseEvent) => void) {
  const roots = new Set<string>();
  const labels = new Map<string, string>();
  /** callId ごとに、いま開いているテキストメッセージ */
  const openMessage = new Map<string, string>();
  /** callId ごとに、最後に開いたテキストメッセージ（ツール呼び出しの親） */
  const lastMessage = new Map<string, string>();
  let finalText = "";

  const scope = (callId: string) => (roots.has(callId) ? {} : { subagentRunId: callId });

  const closeMessage = (callId: string) => {
    const messageId = openMessage.get(callId);
    if (!messageId) return;
    send({ type: EventType.TEXT_MESSAGE_END, messageId, ...scope(callId) } as BaseEvent);
    openMessage.delete(callId);
  };

  return {
    start() {
      send({ type: EventType.RUN_STARTED, threadId, runId } as BaseEvent);
    },

    handle(ev: ChatEvent) {
      switch (ev.type) {
        case "agent_start": {
          labels.set(ev.callId, ev.label);
          const metadata = {
            callId: ev.callId,
            parentCallId: ev.parentCallId,
            agent: ev.agent,
            model: ev.model,
            task: ev.task,
            depth: ev.depth,
            via: ev.via,
            handoffFrom: ev.handoffFrom,
          };
          if (ev.parentCallId === null) {
            roots.add(ev.callId);
            send({ type: EventType.STEP_STARTED, stepName: ev.label, metadata } as BaseEvent);
          } else {
            send({
              type: EventType.SUBAGENT_STARTED,
              subagentRunId: ev.callId,
              name: ev.label,
              description: ev.task,
              parentSubagentRunId: roots.has(ev.parentCallId) ? undefined : ev.parentCallId,
              metadata,
            } as BaseEvent);
          }
          return;
        }
        case "turn_start": {
          closeMessage(ev.callId);
          const messageId = `${ev.callId}:${ev.turn}`;
          openMessage.set(ev.callId, messageId);
          lastMessage.set(ev.callId, messageId);
          send({
            type: EventType.TEXT_MESSAGE_START,
            messageId,
            role: "assistant",
            name: labels.get(ev.callId),
            metadata: { callId: ev.callId, turn: ev.turn },
            ...scope(ev.callId),
          } as BaseEvent);
          return;
        }
        case "text": {
          const messageId = openMessage.get(ev.callId);
          if (messageId) send({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: ev.delta, ...scope(ev.callId) } as BaseEvent);
          return;
        }
        case "tool_call": {
          // ツールを呼ぶ時点で、そのターンの文章は書き終わっている
          closeMessage(ev.callId);
          const parentMessageId = lastMessage.get(ev.callId);
          const s = scope(ev.callId);
          send({ type: EventType.TOOL_CALL_START, toolCallId: ev.toolUseId, toolCallName: ev.name, parentMessageId, ...s } as BaseEvent);
          send({ type: EventType.TOOL_CALL_ARGS, toolCallId: ev.toolUseId, delta: JSON.stringify(ev.input), ...s } as BaseEvent);
          send({ type: EventType.TOOL_CALL_END, toolCallId: ev.toolUseId, ...s } as BaseEvent);
          return;
        }
        case "tool_result":
          send({
            type: EventType.TOOL_CALL_RESULT,
            messageId: `${ev.toolUseId}:result`,
            toolCallId: ev.toolUseId,
            content: ev.content,
            role: "tool",
            ...scope(ev.callId),
          } as BaseEvent);
          return;
        case "agent_end": {
          closeMessage(ev.callId);
          const metadata = { callId: ev.callId, usage: ev.usage };
          if (roots.has(ev.callId)) {
            finalText = ev.output;
            send({ type: EventType.STEP_FINISHED, stepName: labels.get(ev.callId), metadata: { ...metadata, output: ev.output, isError: ev.isError } } as BaseEvent);
          } else if (ev.isError) {
            send({ type: EventType.SUBAGENT_ERROR, subagentRunId: ev.callId, message: ev.output, metadata } as BaseEvent);
          } else {
            send({ type: EventType.SUBAGENT_FINISHED, subagentRunId: ev.callId, result: ev.output, outcome: { type: "success" }, metadata } as BaseEvent);
          }
          return;
        }
        case "wire": {
          const { type: _type, ...wire } = ev;
          send({ type: EventType.CUSTOM, name: "wire", value: wire } as BaseEvent);
          return;
        }
        case "done":
          send({ type: EventType.RUN_FINISHED, threadId, runId, result: finalText, outcome: { type: "success" } } as BaseEvent);
          return;
        case "error":
          send({ type: EventType.RUN_ERROR, message: ev.message } as BaseEvent);
          return;
      }
    },
  };
}
