/**
 * サーバー → ブラウザへストリーミングで送るイベントの型。
 * サーバー（server/）とフロントエンド（web/）の両方から参照する。
 *
 * 1 回のエージェント実行（= 1 回の呼び出し）には一意な callId が振られ、
 * parentCallId をたどると「誰が誰を呼んだか」の木構造が復元できる。
 */

export type AgentId = "orchestrator" | "researcher" | "writer" | "coder" | "reviewer";

export type ChatEvent =
  | {
      type: "agent_start";
      callId: string;
      parentCallId: string | null;
      agent: AgentId;
      label: string;
      model: string;
      /** 呼び出し元から渡された依頼内容 */
      task: string;
      depth: number;
    }
  /** エージェントがモデルを 1 回呼ぶたびに turn が 1 増える */
  | { type: "turn_start"; callId: string; turn: number }
  | { type: "text"; callId: string; turn: number; delta: string }
  | { type: "tool_call"; callId: string; toolUseId: string; target: AgentId; task: string }
  | {
      type: "agent_end";
      callId: string;
      output: string;
      isError: boolean;
      usage: { input_tokens: number; output_tokens: number };
    }
  | { type: "error"; message: string }
  | { type: "done" };

/** ブラウザ → サーバーに送る会話履歴 */
export interface ChatRequest {
  messages: { role: "user" | "assistant"; content: string }[];
}

export interface AgentInfo {
  id: AgentId;
  label: string;
  description: string;
  canCall: AgentId[];
  model: string;
}

export interface ConfigResponse {
  mode: "anthropic" | "mock";
  agents: AgentInfo[];
}
