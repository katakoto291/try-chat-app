import type { AgentId } from "../../shared/protocol.js";
import type { BetaTool } from "../llm/types.js";

/**
 * あるエージェントから見た「呼び出せる相手」への接続。
 * 3 つのパターン（direct / mcp / a2a）はすべてこの形に揃えてあるので、
 * runAgent のループはパターンを意識せずに済む。
 */
export interface PeerConnection {
  /** モデルに渡すツール定義（どこから来るかがパターンごとに違う） */
  tools: BetaTool[];
  /** 相手エージェントに task を渡して実行し、結果のテキストを受け取る */
  call(target: AgentId, task: string): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

/** A2A と direct で使う、共通のツール入力スキーマ */
export const TASK_INPUT_SCHEMA: BetaTool["input_schema"] = {
  type: "object",
  properties: {
    task: { type: "string", description: "依頼内容。相手はこれまでの会話を知らないので、前提も含めて具体的に書く" },
  },
  required: ["task"],
  additionalProperties: false,
};
