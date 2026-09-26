import type { AgentId } from "../../shared/protocol.js";
import { AGENTS } from "../agents/definitions.js";
import { runAgent, type Toolbox } from "../agents/runAgent.js";
import type { BetaMessageParam } from "../llm/types.js";
import type { RunContext } from "../runs.js";

/** 引き継ぎの最大回数（引き継ぎ合いが止まらないのを防ぐ） */
const MAX_HANDOFFS = 5;

/**
 * 連携パターン: ハンドオフ（引き継ぎ）
 *
 *   ユーザー ─▶ 司令塔 ══引き継ぎ══▶ コーダー ══引き継ぎ══▶ レビュアー ─▶ ユーザーへ回答
 *
 * - 担当者は transfer_to_<id> ツールを呼ぶと、そこで自分の番を終える
 * - 次の担当者は「会話全体 + 引き継ぎメモ」を受け取り、ユーザーに直接答える
 * - 「呼び出し」と違って結果は戻ってこない。主導権そのものが移る
 *
 * 呼び出しパターンでは子に task 文字列だけを渡したが、ハンドオフでは会話ごと渡すのがポイント。
 */
export async function runHandoff(messages: BetaMessageParam[], ctx: RunContext): Promise<string> {
  let current: AgentId = "orchestrator";
  let previous: { callId: string; agent: AgentId; reason: string } | undefined;
  const transcript: { agent: AgentId; text: string }[] = [];

  for (let hop = 0; hop <= MAX_HANDOFFS; hop++) {
    // ツールの中で書き換わるので、入れ物に入れておく
    const decided: { next?: { to: AgentId; reason: string } } = {};
    const def = AGENTS[current];
    const canHandoff = hop < MAX_HANDOFFS;

    const { callId, text } = await runAgent(
      current,
      previous ? withHandoffNote(messages, previous, current, transcript) : messages,
      { ...ctx, depth: 0, parentCallId: null },
      {
        via: previous ? "handoff" : "direct",
        handoffFrom: previous?.callId,
        toolbox: async () =>
          canHandoff && def.handoff.to.length > 0 ? handoffToolbox(def.handoff.to, (to, reason) => (decided.next = { to, reason })) : undefined,
      },
    );
    transcript.push({ agent: current, text });

    if (!decided.next) return text;
    const { to, reason } = decided.next;

    ctx.emit({
      type: "wire",
      callId,
      protocol: "handoff",
      direction: "request",
      label: `TRANSFER ${def.label} ⇒ ${AGENTS[to].label}`,
      url: "(同一プロセス内)",
      body: `理由: ${reason}\n\n次の担当者には、会話全体と引き継ぎメモが渡されます。`,
    });
    previous = { callId, agent: current, reason };
    current = to;
  }
  return transcript[transcript.length - 1]?.text ?? "";
}

/** transfer_to_<id> ツール。呼ばれたら引き継ぎ先を記録し、ループを止める */
function handoffToolbox(targets: AgentId[], onTransfer: (to: AgentId, reason: string) => void): Toolbox {
  let transferred = false;
  return {
    tools: targets.map((id) => ({
      name: `transfer_to_${id}`,
      description: `会話を${AGENTS[id].label}に引き継ぐ。${AGENTS[id].description}。引き継ぐと、あなたの番はここで終わる。`,
      input_schema: {
        type: "object",
        properties: { reason: { type: "string", description: "引き継ぐ理由と、次の担当者へのメモ" } },
        required: ["reason"],
        additionalProperties: false,
      },
      eager_input_streaming: true,
    })),
    async run(toolUse) {
      const to = toolUse.name.replace(/^transfer_to_/, "") as AgentId;
      const reason = (toolUse.input as { reason?: unknown })?.reason;
      if (transferred) return { content: "すでに引き継ぎ済みです", isError: true };
      if (!targets.includes(to)) return { content: `${toolUse.name} には引き継げません`, isError: true };
      transferred = true;
      onTransfer(to, typeof reason === "string" ? reason : "");
      return { content: `${AGENTS[to].label}に引き継ぎました。` };
    },
    shouldStop: () => transferred,
  };
}

/**
 * 次の担当者に渡す会話。最後のユーザー発言の後ろに「引き継ぎメモ」を付ける。
 * （前の担当者のツール呼び出しなどは渡さず、発言内容だけを要約して渡す）
 */
function withHandoffNote(
  messages: BetaMessageParam[],
  previous: { agent: AgentId; reason: string },
  current: AgentId,
  transcript: { agent: AgentId; text: string }[],
): BetaMessageParam[] {
  const last = messages[messages.length - 1];
  const lastText = typeof last.content === "string" ? last.content : "";
  const history = transcript
    .filter((t) => t.text.trim())
    .map((t) => `【${AGENTS[t.agent].label}】\n${t.text}`)
    .join("\n\n");
  const note = [
    "---",
    `[引き継ぎメモ] ${AGENTS[previous.agent].label} から、あなた（${AGENTS[current].label}）に会話が引き継がれました。`,
    `理由: ${previous.reason || "（なし）"}`,
    history ? `\nこれまでの担当者の発言:\n${history}` : "",
  ].join("\n");
  return [...messages.slice(0, -1), { role: "user", content: `${lastText}\n\n${note}` }];
}
