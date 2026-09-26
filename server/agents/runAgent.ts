import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageParam, ModelClient } from "../llm/types.js";
import { connectPeers, type PeerConnection } from "../patterns/index.js";
import type { RunContext } from "../runs.js";
import { AGENTS, MAX_DEPTH, agentIdFromToolName, modelFor, type AgentId } from "./definitions.js";

/** 1 つのエージェントがモデルを呼ぶ最大回数（ツール呼び出しのループ上限） */
const MAX_TURNS = 8;

/**
 * エージェントを 1 回実行し、最終回答のテキストを返す。
 *
 * ループの中身:
 *   0. 呼び出せる相手に接続する（direct / MCP / A2A のどれで繋ぐかは ctx.pattern で決まる）
 *   1. モデルを呼ぶ（呼べる他エージェントを `call_<id>` ツールとして渡す）
 *   2. 返答に tool_use があれば、接続を通して相手エージェントを実行する
 *      （同じターンに複数あれば Promise.all で並列実行）
 *   3. 結果を tool_result として会話に追加し、1 に戻る
 *   4. tool_use がなくなったら、そのテキストが最終回答
 */
export async function runAgent(
  agentId: AgentId,
  messages: BetaMessageParam[],
  ctx: RunContext,
): Promise<string> {
  const def = AGENTS[agentId];
  const model = modelFor(agentId);
  const callId = randomUUID();
  const usage = { input_tokens: 0, output_tokens: 0 };

  ctx.emit({
    type: "agent_start",
    callId,
    parentCallId: ctx.parentCallId,
    agent: agentId,
    label: def.label,
    model,
    task: lastUserText(messages),
    depth: ctx.depth,
    via: ctx.depth === 0 ? "direct" : ctx.pattern,
  });

  const history = [...messages];
  let finalText = "";
  let isError = false;
  let peers: PeerConnection | undefined;

  try {
    // 深さの上限に達したら、それ以上他のエージェントを呼べないようにする
    if (def.canCall.length > 0 && ctx.depth < MAX_DEPTH) peers = await connectPeers(def, callId, ctx);
    const tools = peers?.tools ?? [];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      ctx.emit({ type: "turn_start", callId, turn });
      const message = await callWithRetry(ctx, {
        model,
        system: def.system,
        messages: history,
        tools,
        effort: def.effort,
        onText: (delta) => ctx.emit({ type: "text", callId, turn, delta }),
        signal: ctx.signal,
      });
      usage.input_tokens += message.usage.input_tokens;
      usage.output_tokens += message.usage.output_tokens;

      if (message.stop_reason === "refusal") {
        finalText = "（このリクエストはモデルに断られました）";
        isError = true;
        break;
      }

      const content = contentForHistory(message.content);
      finalText = content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const toolUses = content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");

      if (toolUses.length === 0) break;
      // 途中で切れたツール入力は信用できないので実行しない
      if (message.stop_reason === "max_tokens") throw new Error("出力が max_tokens で打ち切られました");

      history.push({ role: "assistant", content });

      // ★ ここがエージェント間の呼び出し。tool_use 1 つ = 別エージェント 1 回の実行
      const results = await Promise.all(toolUses.map((toolUse) => callSubAgent(toolUse, peers, callId, ctx)));
      history.push({ role: "user", content: results });

      if (turn === MAX_TURNS - 1) finalText ||= "（ターン数の上限に達しました）";
    }
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    finalText = `エラー: ${err instanceof Error ? err.message : String(err)}`;
    isError = true;
  } finally {
    await peers?.close().catch(() => {});
  }

  ctx.emit({ type: "agent_end", callId, output: finalText, isError, usage });
  if (isError && ctx.depth === 0) throw new Error(finalText);
  return finalText;
}

/** tool_use を受けて、接続を通して相手エージェントを実行し tool_result を返す */
async function callSubAgent(
  toolUse: Anthropic.Beta.BetaToolUseBlock,
  peers: PeerConnection | undefined,
  callerCallId: string,
  ctx: RunContext,
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const target = agentIdFromToolName(toolUse.name);
  const input = toolUse.input as { task?: unknown };
  if (!peers || !target || typeof input?.task !== "string" || input.task.trim() === "") {
    return { type: "tool_result", tool_use_id: toolUse.id, is_error: true, content: `不正な呼び出しです: ${JSON.stringify(toolUse.input)}` };
  }

  ctx.emit({ type: "tool_call", callId: callerCallId, toolUseId: toolUse.id, target, task: input.task });

  try {
    // サブエージェントは呼び出し元の会話履歴を知らない。渡すのは task だけ
    const { text, isError } = await peers.call(target, input.task);
    return { type: "tool_result", tool_use_id: toolUse.id, is_error: isError || undefined, content: text || "（空の応答）" };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    return { type: "tool_result", tool_use_id: toolUse.id, is_error: true, content: String(err) };
  }
}

/**
 * ストリーミング中にツール入力の JSON が壊れていた場合だけ再試行する。
 * API エラー（認証・レート制限など）はそのまま投げる。
 */
async function callWithRetry(ctx: RunContext, params: Parameters<ModelClient["call"]>[0]): Promise<BetaMessage> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ctx.client.call(params);
    } catch (err) {
      if (err instanceof Anthropic.APIError || ctx.signal.aborted || attempt >= 2) throw err;
    }
  }
}

/**
 * サーバー側フォールバックが途中で起きた場合、`fallback` ブロックより前の
 * thinking / tool_use などは履歴に戻せないので取り除く（text は残す）。
 */
function contentForHistory(content: Anthropic.Beta.BetaContentBlock[]): Anthropic.Beta.BetaContentBlock[] {
  const boundary = content.map((b) => b.type as string).lastIndexOf("fallback");
  if (boundary === -1) return content;
  return content.filter((b, i) => i > boundary || b.type === "text");
}

function lastUserText(messages: BetaMessageParam[]): string {
  const last = messages[messages.length - 1];
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return last.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
}
