import type { CallPattern } from "../../shared/protocol";

export interface PatternInfo {
  id: CallPattern;
  label: string;
  /** セレクターの下に出す一言説明 */
  summary: string;
  /** 通信ログの上に出す「流れ」 */
  steps: string[];
  /** 呼ばれる側が何として扱われるか */
  calleeIs: string;
}

export const PATTERNS: PatternInfo[] = [
  {
    id: "direct",
    label: "直接呼び出し",
    summary: "同じプロセス内で、サブエージェントを関数として呼ぶ",
    steps: [
      "ツール定義は呼び出し側が自分のコードから作る",
      "runAgent() を関数として呼ぶだけ（ネットワーク通信なし）",
    ],
    calleeIs: "関数",
  },
  {
    id: "mcp",
    label: "MCP",
    summary: "サブエージェントを MCP サーバーの「ツール」として公開し、MCP クライアントから呼ぶ",
    steps: [
      "initialize: クライアントとサーバーがバージョンと能力を交換する",
      "tools/list: サーバーが公開するツール一覧（名前・説明・JSON Schema）を取得する",
      "tools/call: ツールを実行し、結果（content）を受け取る",
    ],
    calleeIs: "ツール（入力スキーマ付きの関数）",
  },
  {
    id: "a2a",
    label: "A2A",
    summary: "各エージェントを独立した A2A サーバーとして公開し、対等な相手としてタスクを依頼する",
    steps: [
      "Agent Card を GET して、相手の名前・説明・スキル・対応機能を知る（ディスカバリー）",
      "SendStreamingMessage: 自然言語のメッセージを送ると、相手が Task を作る",
      "Task の状態（SUBMITTED → WORKING → COMPLETED）と成果物（Artifact）がストリームで届く",
    ],
    calleeIs: "エージェント（状態を持つタスクの担当者）",
  },
];

export const patternInfo = (id: CallPattern) => PATTERNS.find((p) => p.id === id) ?? PATTERNS[0];
