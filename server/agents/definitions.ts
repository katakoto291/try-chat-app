/**
 * エージェントの定義。
 *
 * 同じ 5 つのエージェントを、3 つの連携パターンで動かす。
 * パターンごとに「誰とつながるか」と「システムプロンプトの末尾の指示」が変わる。
 *
 * ■ 呼び出し (call) — canCall に書いた相手が `call_<id>` ツールとして見える
 *     司令塔 ─┬─ リサーチャー
 *             ├─ ライター
 *             └─ コーダー ── レビュアー
 *
 * ■ ハンドオフ (handoff) — handoffTo に書いた相手が `transfer_to_<id>` ツールとして見える
 *     司令塔 ⇒ リサーチャー ⇒ ライター
 *     司令塔 ⇒ ライター
 *     司令塔 ⇒ コーダー ⇒ レビュアー
 *
 * ■ Pub/Sub (pubsub) — subscribes のトピックにイベントが来たら反応し、結果を publishes に発行する
 *     research.requested → リサーチャー → research.completed → ライター → writing.completed
 *     writing.requested  → ライター     → writing.completed
 *     code.requested     → コーダー     → code.written       → レビュアー → review.completed
 */

import type { AgentId, Topic, Topology } from "../../shared/protocol.js";

export type { AgentId, Topic };

export interface AgentDefinition {
  id: AgentId;
  /** UI に表示する名前 */
  label: string;
  /** 他のエージェントに見せる説明（ツールの description や Agent Card になる） */
  description: string;
  /** 役割（どのパターンでも共通のシステムプロンプト） */
  role: string;
  /** 思考の深さ。サブエージェントは軽めにしてコストと待ち時間を抑える */
  effort?: "low" | "medium" | "high";

  /** 呼び出しパターン: 呼び出せる相手と、追加の指示 */
  call: { canCall: AgentId[]; instructions: string };
  /** ハンドオフパターン: 引き継げる相手と、追加の指示 */
  handoff: { to: AgentId[]; instructions: string };
  /** Pub/Sub パターン: 購読するトピックと、結果を発行するトピック */
  pubsub: { subscribes: Topic[]; publishes: Topic[]; instructions: string };
}

const orchestratorModel = process.env.ORCHESTRATOR_MODEL || "claude-opus-5";
const subagentModel = process.env.SUBAGENT_MODEL || "claude-opus-5";

export function modelFor(id: AgentId): string {
  return id === "orchestrator" ? orchestratorModel : subagentModel;
}

/** Pub/Sub で司令塔が発行できる「依頼」のトピック */
export const REQUEST_TOPICS: Topic[] = ["research.requested", "writing.requested", "code.requested"];

export const AGENTS: Record<AgentId, AgentDefinition> = {
  orchestrator: {
    id: "orchestrator",
    label: "司令塔",
    description: "ユーザーと対話し、必要に応じて専門エージェントに仕事を振り分ける",
    role: "あなたはチャットアプリの司令塔エージェントです。ユーザーと日本語で対話します。簡単な質問や雑談には自分で直接答えてください。",
    call: {
      canCall: ["researcher", "writer", "coder"],
      instructions: [
        "調査・文章作成・コード作成など専門性が必要なときは、call_* ツールで専門エージェントに依頼してください。",
        "独立した依頼は同じターンで並列に呼び出して構いません。",
        "専門エージェントはこれまでの会話を知らないので、依頼文(task)には必要な前提をすべて書いてください。",
        "最後に、専門エージェントの結果を統合してユーザーへの回答をまとめてください。",
      ].join("\n"),
    },
    handoff: {
      to: ["researcher", "writer", "coder"],
      instructions: [
        "あなたは受付係です。専門性が必要な依頼は、transfer_to_* ツールで担当者に会話ごと引き継いでください。",
        "調べて説明してほしい依頼はリサーチャーへ、文章だけ書いてほしい依頼はライターへ、コードの依頼はコーダーへ。",
        "引き継いだあとは、あなたはもう回答しません。引き継ぐときは一言だけ書いてツールを呼んでください。",
      ].join("\n"),
    },
    pubsub: {
      subscribes: ["research.completed", "writing.completed", "code.written", "review.completed"],
      publishes: REQUEST_TOPICS,
      instructions: [
        "専門性が必要なときは publish_event ツールでイベントを発行してください。誰が処理するかは気にしなくて構いません。",
        "調べて説明してほしい依頼は research.requested（調査結果には自動でライターが反応します）、",
        "文章だけ書いてほしい依頼は writing.requested、コードの依頼は code.requested（自動でレビューも行われます）。",
        "イベントの content には、処理に必要な前提をすべて書いてください。発行したら一言だけ書いて終えてください。",
        "購読していたイベントの結果が届いたら、それらを統合してユーザーへの回答をまとめてください。",
      ].join("\n"),
    },
  },
  researcher: {
    id: "researcher",
    label: "リサーチャー",
    description: "事実関係の整理・比較・分析を行い、要点を箇条書きで返す",
    role: "あなたはリサーチ担当のエージェントです。依頼されたテーマについて、知っている事実を整理し、要点を簡潔な箇条書きにしてください。不確かなことは不確かと明記してください。",
    effort: "medium",
    call: { canCall: [], instructions: "" },
    handoff: {
      to: ["writer"],
      instructions:
        "あなたはユーザーと直接会話しています。要点を箇条書きでまとめたら、transfer_to_writer でライターに引き継ぎ、読みやすい文章に仕上げてもらってください。",
    },
    pubsub: {
      subscribes: ["research.requested"],
      publishes: ["research.completed"],
      instructions: "受け取ったイベントの内容を調べ、要点だけを返してください。返した内容は research.completed として自動で発行されます。",
    },
  },
  writer: {
    id: "writer",
    label: "ライター",
    description: "与えられた材料をもとに、読みやすい日本語の文章に仕上げる",
    role: "あなたはライター担当のエージェントです。与えられた材料や要件をもとに、読みやすく自然な日本語の文章を書いてください。",
    effort: "medium",
    call: { canCall: [], instructions: "" },
    handoff: {
      to: [],
      instructions: "あなたはユーザーと直接会話しています。これまでの担当者の材料をもとに、ユーザーへの最終的な回答を書いてください。",
    },
    pubsub: {
      subscribes: ["writing.requested", "research.completed"],
      publishes: ["writing.completed"],
      instructions:
        "受け取ったイベントの内容（依頼、または調査結果）をもとに、初心者にもわかる説明文を書いて返してください。返した内容は writing.completed として自動で発行されます。",
    },
  },
  coder: {
    id: "coder",
    label: "コーダー",
    description: "プログラムを書く。書いたコードはレビュアーに確認させる",
    role: "あなたはプログラミング担当のエージェントです。依頼されたコードを書いてください。コードブロックと短い説明を含めてください。",
    effort: "medium",
    call: {
      canCall: ["reviewer"],
      instructions: "コードを書いたら、必ず call_reviewer でレビューを依頼し、指摘を反映した最終版を返してください。",
    },
    handoff: {
      to: ["reviewer"],
      instructions:
        "あなたはユーザーと直接会話しています。コードを書いたら、transfer_to_reviewer でレビュアーに引き継いでください。",
    },
    pubsub: {
      subscribes: ["code.requested"],
      publishes: ["code.written"],
      instructions: "受け取ったイベントの依頼どおりにコードを書いて返してください。返した内容は code.written として自動で発行されます。",
    },
  },
  reviewer: {
    id: "reviewer",
    label: "レビュアー",
    description: "コードをレビューし、バグや改善点を指摘する",
    role: "あなたはコードレビュー担当のエージェントです。コードのバグ・読みやすさ・エッジケースを確認し、具体的な指摘を短く箇条書きにしてください。",
    effort: "low",
    call: { canCall: [], instructions: "" },
    handoff: {
      to: [],
      instructions:
        "あなたはユーザーと直接会話しています。これまでの担当者が書いたコードをレビューし、指摘と、指摘を反映した最終版のコードをユーザーに返してください。",
    },
    pubsub: {
      subscribes: ["code.written"],
      publishes: ["review.completed"],
      instructions: "受け取ったイベントのコードをレビューして返してください。返した内容は review.completed として自動で発行されます。",
    },
  },
};

/** パターンに応じたシステムプロンプト */
export function systemFor(def: AgentDefinition, topology: Topology): string {
  const extra = def[topology === "call" ? "call" : topology].instructions;
  return extra ? `${def.role}\n\n${extra}` : def.role;
}

/** エージェント呼び出しの最大の深さ（無限に呼び合うのを防ぐ） */
export const MAX_DEPTH = 3;

export const toolNameFor = (id: AgentId) => `call_${id}`;

export function agentIdFromToolName(name: string): AgentId | undefined {
  const id = name.replace(/^(call_|transfer_to_)/, "") as AgentId;
  return id in AGENTS ? id : undefined;
}
