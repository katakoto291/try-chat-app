/**
 * エージェントの定義。
 *
 * 各エージェントは「システムプロンプト」と「呼び出せる他のエージェント（canCall）」を持つ。
 * canCall に書いたエージェントは、呼び出し元から見ると `call_<id>` という名前の
 * ツールとして見える。つまり「エージェント間の呼び出し」＝「ツール呼び出し」である。
 *
 *   orchestrator ─┬─ researcher
 *                 ├─ writer
 *                 └─ coder ── reviewer   ← サブエージェントがさらに別のエージェントを呼ぶ例
 */

import type { AgentId } from "../../shared/protocol.js";

export type { AgentId };

export interface AgentDefinition {
  id: AgentId;
  /** UI に表示する名前 */
  label: string;
  /** 呼び出し元エージェントに見せる説明（ツールの description になる） */
  description: string;
  system: string;
  /** このエージェントが呼び出せるエージェント */
  canCall: AgentId[];
  /** 思考の深さ。サブエージェントは軽めにしてコストと待ち時間を抑える */
  effort?: "low" | "medium" | "high";
}

const orchestratorModel = process.env.ORCHESTRATOR_MODEL || "claude-opus-5";
const subagentModel = process.env.SUBAGENT_MODEL || "claude-opus-5";

export function modelFor(id: AgentId): string {
  return id === "orchestrator" ? orchestratorModel : subagentModel;
}

export const AGENTS: Record<AgentId, AgentDefinition> = {
  orchestrator: {
    id: "orchestrator",
    label: "司令塔",
    description: "ユーザーと対話し、必要に応じて専門エージェントに仕事を振り分ける",
    system: [
      "あなたはチャットアプリの司令塔エージェントです。ユーザーと日本語で対話します。",
      "簡単な質問や雑談には自分で直接答えてください。",
      "調査・文章作成・コード作成など専門性が必要なときは、call_* ツールで専門エージェントに依頼してください。",
      "独立した依頼は同じターンで並列に呼び出して構いません。",
      "専門エージェントはこれまでの会話を知らないので、依頼文(task)には必要な前提をすべて書いてください。",
      "最後に、専門エージェントの結果を統合してユーザーへの回答をまとめてください。",
    ].join("\n"),
    canCall: ["researcher", "writer", "coder"],
  },
  researcher: {
    id: "researcher",
    label: "リサーチャー",
    description: "事実関係の整理・比較・分析を行い、要点を箇条書きで返す",
    system:
      "あなたはリサーチ担当のエージェントです。依頼されたテーマについて、知っている事実を整理し、要点を簡潔な箇条書きで返してください。不確かなことは不確かと明記してください。",
    canCall: [],
    effort: "medium",
  },
  writer: {
    id: "writer",
    label: "ライター",
    description: "与えられた材料をもとに、読みやすい日本語の文章に仕上げる",
    system:
      "あなたはライター担当のエージェントです。与えられた材料や要件をもとに、読みやすく自然な日本語の文章を書いてください。",
    canCall: [],
    effort: "medium",
  },
  coder: {
    id: "coder",
    label: "コーダー",
    description: "プログラムを書く。書いたコードはレビュアーに確認させてから返す",
    system: [
      "あなたはプログラミング担当のエージェントです。依頼されたコードを書いてください。",
      "コードを書いたら、必ず call_reviewer でレビューを依頼し、指摘を反映した最終版を返してください。",
      "最終回答にはコードブロックと短い説明を含めてください。",
    ].join("\n"),
    canCall: ["reviewer"],
    effort: "medium",
  },
  reviewer: {
    id: "reviewer",
    label: "レビュアー",
    description: "コードをレビューし、バグや改善点を指摘する",
    system:
      "あなたはコードレビュー担当のエージェントです。渡されたコードのバグ・読みやすさ・エッジケースを確認し、具体的な指摘を短く箇条書きで返してください。",
    canCall: [],
    effort: "low",
  },
};

/** エージェント呼び出しの最大の深さ（無限に呼び合うのを防ぐ） */
export const MAX_DEPTH = 3;

export const toolNameFor = (id: AgentId) => `call_${id}`;

export function agentIdFromToolName(name: string): AgentId | undefined {
  const id = name.replace(/^call_/, "") as AgentId;
  return id in AGENTS ? id : undefined;
}
