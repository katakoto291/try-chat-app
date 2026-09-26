import type { CallPattern, Topology } from "../../shared/protocol";

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

export interface TopologyInfo {
  id: Topology;
  label: string;
  summary: string;
  steps: string[];
}

export const TOPOLOGIES: TopologyInfo[] = [
  {
    id: "call",
    label: "呼び出し",
    summary: "司令塔が子エージェントを呼び、結果が戻ってくる（下のプロトコルで通信方式を選ぶ）",
    steps: [],
  },
  {
    id: "handoff",
    label: "ハンドオフ",
    summary: "担当者が会話ごと次の担当者に引き継ぐ。結果は戻らず、主導権が移る",
    steps: [
      "担当者は transfer_to_<相手> ツールを呼ぶと、その時点で自分の番を終える",
      "次の担当者には、会話全体と「引き継ぎメモ」が渡される（呼び出しは task だけだった）",
      "最後の担当者が、ユーザーに直接答える",
    ],
  },
  {
    id: "pubsub",
    label: "Pub/Sub",
    summary: "イベントを発行し、購読しているエージェントが反応する。発行者は処理する相手を知らない",
    steps: [
      "司令塔は publish_event でトピックにイベントを投げるだけ（宛先は指定しない）",
      "そのトピックを購読しているエージェントに配送され、結果がまた別のトピックに発行される（連鎖）",
      "司令塔は結果のトピックを購読しておき、イベントが出尽くしたらまとめて回答する",
    ],
  },
];

export const topologyInfo = (id: Topology) => TOPOLOGIES.find((t) => t.id === id) ?? TOPOLOGIES[0];

export type Transport = "sse" | "agui";

export const TRANSPORTS: { id: Transport; label: string; summary: string }[] = [
  { id: "sse", label: "独自 SSE", summary: "このアプリ専用の形式のイベントを SSE で受け取る" },
  {
    id: "agui",
    label: "AG-UI",
    summary: "AG-UI の標準イベント（TEXT_MESSAGE_* / SUBAGENT_* など）で受け取る。公式クライアント HttpAgent を使用",
  },
];
