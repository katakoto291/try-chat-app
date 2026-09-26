import { AGENTS, toolNameFor, type AgentDefinition } from "../agents/definitions.js";
import { runAgent } from "../agents/runAgent.js";
import type { RunContext } from "../runs.js";
import { TASK_INPUT_SCHEMA, type PeerConnection } from "./types.js";

/**
 * パターン 1: 直接呼び出し
 *
 * - ツール定義: 呼び出し側が自分のコード（definitions.ts）から組み立てる
 * - 呼び出し:   同じプロセス内で runAgent() を関数として呼ぶだけ
 *
 * ネットワークもプロトコルもないので最速・最小。ただし全エージェントが
 * 同じコードベース・同じプロセスにいることが前提になる。
 */
export async function connectDirect(caller: AgentDefinition, callerCallId: string, ctx: RunContext): Promise<PeerConnection> {
  return {
    tools: caller.canCall.map((id) => ({
      name: toolNameFor(id),
      description: `${AGENTS[id].label}エージェントに仕事を依頼する。${AGENTS[id].description}`,
      input_schema: TASK_INPUT_SCHEMA,
      eager_input_streaming: true,
    })),

    async call(target, task) {
      const log = (direction: "request" | "response", label: string, body: string) =>
        ctx.emit({ type: "wire", callId: callerCallId, protocol: "direct", direction, label, url: "(同一プロセス内)", body });

      log("request", `runAgent("${target}", task)`, task);
      const text = await runAgent(target, [{ role: "user", content: task }], {
        ...ctx,
        depth: ctx.depth + 1,
        parentCallId: callerCallId,
      });
      log("response", `return (${text.length} 文字)`, text);
      return { text, isError: false };
    },

    async close() {},
  };
}
