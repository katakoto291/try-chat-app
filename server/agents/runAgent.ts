import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { Via } from "../../shared/protocol.js";
import type { BetaMessage, BetaMessageParam, BetaTool, ModelClient } from "../llm/types.js";
import { connectPeers } from "../patterns/index.js";
import type { RunContext } from "../runs.js";
import { AGENTS, MAX_DEPTH, agentIdFromToolName, modelFor, systemFor, type AgentId } from "./definitions.js";

/** 1 つのエージェントがモデルを呼ぶ最大回数（ツール呼び出しのループ上限） */
const MAX_TURNS = 8;

type ToolUse = Anthropic.Beta.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

/**
 * エージェントに持たせる道具箱。連携パターンごとに中身が違う。
 * - 呼び出し: call_<id>（相手エージェントを実行して結果を返す）
 * - ハンドオフ: transfer_to_<id>（引き継ぎ先を記録して、ループを止める）
 * - Pub/Sub:   publish_event（イベントを発行するだけ。誰が処理するかは知らない）
 */
export interface Toolbox {
  tools: BetaTool[];
  run(toolUse: ToolUse): Promise<{ content: string; isError?: boolean }>;
  /** true を返したら、このターンでループを終える（ハンドオフ用） */
  shouldStop?(): boolean;
  close?(): Promise<void>;
}

export interface RunOptions {
  /** 起動のされ方（トレース表示用）。省略時は ctx から決める */
  via?: Via;
  /** ハンドオフで引き継いだ場合の、前の担当者の callId */
  handoffFrom?: string;
  /** 道具箱を作る関数。省略時は「呼び出し」パターンの道具箱（ctx.pattern で接続） */
  toolbox?: (callId: string) => Promise<Toolbox | undefined>;
}

export interface AgentResult {
  callId: string;
  text: string;
}

/**
 * エージェントを 1 回実行し、最終回答のテキストを返す。
 *
 * ループの中身:
 *   0. 道具箱を用意する（呼び出しパターンなら direct / MCP / A2A で相手に接続）
 *   1. モデルを呼ぶ
 *   2. 返答に tool_use があれば、道具箱で実行する（同じターンに複数あれば並列）
 *   3. 結果を tool_result として会話に追加し、1 に戻る
 *   4. tool_use がなくなったら（またはハンドオフしたら）、そのテキストが最終回答
 */
export async function runAgent(
  agentId: AgentId,
  messages: BetaMessageParam[],
  ctx: RunContext,
  options: RunOptions = {},
): Promise<AgentResult> {
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
    via: options.via ?? (ctx.depth === 0 ? "direct" : ctx.pattern),
    handoffFrom: options.handoffFrom,
  });

  const history = [...messages];
  let finalText = "";
  let isError = false;
  let toolbox: Toolbox | undefined;

  try {
    toolbox = await (options.toolbox ?? ((id) => callToolbox(agentId, id, ctx)))(callId);

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      ctx.emit({ type: "turn_start", callId, turn });
      const message = await callWithRetry(ctx, {
        model,
        system: systemFor(def, ctx.topology),
        messages: history,
        tools: toolbox?.tools ?? [],
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
      const toolUses = content.filter((b): b is ToolUse => b.type === "tool_use");

      if (toolUses.length === 0 || !toolbox) break;
      // 途中で切れたツール入力は信用できないので実行しない
      if (message.stop_reason === "max_tokens") throw new Error("出力が max_tokens で打ち切られました");

      history.push({ role: "assistant", content });

      // ★ ツールの実行。呼び出しパターンでは、ここで別のエージェントが動く
      const results = await Promise.all(toolUses.map((toolUse) => runTool(toolbox!, toolUse, callId, ctx)));
      history.push({ role: "user", content: results });

      if (toolbox.shouldStop?.()) break;
      if (turn === MAX_TURNS - 1) finalText ||= "（ターン数の上限に達しました）";
    }
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    finalText = `エラー: ${err instanceof Error ? err.message : String(err)}`;
    isError = true;
  } finally {
    await toolbox?.close?.().catch(() => {});
  }

  ctx.emit({ type: "agent_end", callId, output: finalText, isError, usage });
  if (isError && ctx.depth === 0) throw new Error(finalText);
  return { callId, text: finalText };
}

async function runTool(toolbox: Toolbox, toolUse: ToolUse, callId: string, ctx: RunContext): Promise<ToolResult> {
  ctx.emit({ type: "tool_call", callId, toolUseId: toolUse.id, name: toolUse.name, input: toolUse.input });
  let result: { content: string; isError?: boolean };
  try {
    result = await toolbox.run(toolUse);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    result = { content: String(err), isError: true };
  }
  ctx.emit({ type: "tool_result", callId, toolUseId: toolUse.id, content: result.content, isError: !!result.isError });
  return { type: "tool_result", tool_use_id: toolUse.id, is_error: result.isError || undefined, content: result.content };
}

/**
 * 「呼び出し」パターンの道具箱。
 * 呼べる相手に direct / MCP / A2A で接続し、call_<id> ツールとして見せる。
 */
async function callToolbox(agentId: AgentId, callId: string, ctx: RunContext): Promise<Toolbox | undefined> {
  const def = AGENTS[agentId];
  // 深さの上限に達したら、それ以上他のエージェントを呼べないようにする
  if (def.call.canCall.length === 0 || ctx.depth >= MAX_DEPTH) return undefined;
  const peers = await connectPeers(def, callId, ctx);

  return {
    tools: peers.tools,
    async run(toolUse) {
      const target = agentIdFromToolName(toolUse.name);
      const input = toolUse.input as { task?: unknown };
      if (!target || typeof input?.task !== "string" || input.task.trim() === "") {
        return { content: `不正な呼び出しです: ${JSON.stringify(toolUse.input)}`, isError: true };
      }
      // サブエージェントは呼び出し元の会話履歴を知らない。渡すのは task だけ
      const { text, isError } = await peers.call(target, input.task);
      return { content: text || "（空の応答）", isError };
    },
    close: () => peers.close(),
  };
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
