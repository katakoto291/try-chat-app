/**
 * サーバー → ブラウザへストリーミングで送るイベントの型。
 * サーバー（server/）とフロントエンド（web/）の両方から参照する。
 *
 * 1 回のエージェント実行（= 1 回の呼び出し）には一意な callId が振られ、
 * parentCallId をたどると「誰が誰を呼んだか」の木構造が復元できる。
 */

export type AgentId = "orchestrator" | "researcher" | "writer" | "coder" | "reviewer";

/**
 * エージェント同士をどうつなぐか。
 * - direct: 同じプロセス内の関数呼び出し（いちばん単純）
 * - mcp:    サブエージェントを MCP サーバーの「ツール」として公開し、MCP クライアントから呼ぶ
 * - a2a:    各エージェントを独立した A2A サーバーとして公開し、Agent Card で発見してメッセージを送る
 */
export type CallPattern = "direct" | "mcp" | "a2a";

/** 通信ログ 1 件（エージェント間でやり取りされた実際のメッセージ） */
export interface WireMessage {
  protocol: CallPattern;
  /** request: 送信 / response: 応答 / event: ストリーミングで届いたイベント */
  direction: "request" | "response" | "event";
  /** JSON-RPC のメソッド名や HTTP のパスなど、一覧に出す短い名前 */
  label: string;
  url: string;
  /** 整形済みの本文（長いものは省略） */
  body: string;
}

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
      /** どの方式で呼び出されたか */
      via: CallPattern;
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
  /** callId のエージェントが（呼び出し側として）送受信したメッセージ */
  | ({ type: "wire"; callId: string } & WireMessage)
  | { type: "error"; message: string }
  | { type: "done" };

/** ブラウザ → サーバーに送る会話履歴 */
export interface ChatRequest {
  pattern: CallPattern;
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
