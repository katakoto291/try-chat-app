// Claude Agent SDK でのエージェント定義。
//
// Claude Agent SDK は「Claude Code をライブラリとして使う」ものです。
// query() を呼ぶと裏で Claude Code（エージェントの実行エンジン）が起動し、
// ツール実行・会話の管理・コンテキストの圧縮などを全部やってくれます。
// 本来はファイル操作や Bash などの組み込みツールが強みですが、
// このサンプルでは安全のため組み込みツールを全部外し、自作の 2 つのツールだけを渡しています。

import { createSdkMcpServer, query, tool, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { INSTRUCTIONS, getLocalTime, getWeather } from "./tools.js";

// --- 自作ツール --------------------------------------------------------------
// Agent SDK では、自作ツールを「プロセス内で動く MCP サーバー」にまとめて渡します
const asText = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

const travelServer = createSdkMcpServer({
  name: "travel",
  version: "1.0.0",
  alwaysLoad: true, // ツールの説明を最初から Claude に見せる（ツール検索で後から読み込ませない）
  tools: [
    tool(
      "get_weather",
      "指定した都市の今日の天気を調べる",
      { city: z.string().describe("都市名（例: 東京、ロンドン）") },
      async ({ city }) => asText(getWeather(city)),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      "get_local_time",
      "指定した都市の現在の現地時刻を調べる",
      { city: z.string().describe("都市名（例: 東京、ロンドン）") },
      async ({ city }) => asText(getLocalTime(city)),
      { annotations: { readOnlyHint: true } },
    ),
  ],
});

// --- どこの Claude を使うか ----------------------------------------------------
// Agent SDK（= Claude Code）は、環境変数でつなぎ先を切り替えます。
//   Bedrock : CLAUDE_CODE_USE_BEDROCK=1 （AWS の認証情報・AWS_REGION を使う）
//   Foundry : CLAUDE_CODE_USE_FOUNDRY=1 （ANTHROPIC_FOUNDRY_RESOURCE と API キー or Entra ID）
// ほかの 2 サンプルとそろえるため、ここでは MODEL_PROVIDER からその環境変数を組み立てます。
export type Provider = "anthropic" | "bedrock" | "foundry";

export const provider = ((): Provider => {
  const p = (process.env.MODEL_PROVIDER ?? "anthropic").toLowerCase();
  if (p === "anthropic" || p === "bedrock" || p === "foundry") return p;
  throw new Error(`MODEL_PROVIDER は anthropic / bedrock / foundry のどれかにしてください（今: ${p}）`);
})();

const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "claude-opus-5-5",
  bedrock: "us.anthropic.claude-opus-5-5", // 推論プロファイル ID（リージョンに合わせて us./eu./apac./global.）
  foundry: "claude-opus-5-5", // Foundry の「デプロイ名」
};
export const modelId = process.env.MODEL_ID ?? DEFAULT_MODEL[provider];

// Foundry hosted agents の中では FOUNDRY_PROJECT_ENDPOINT が自動で入るので、そこからリソース名を取り出せます
const foundryResource =
  process.env.ANTHROPIC_FOUNDRY_RESOURCE ??
  (process.env.FOUNDRY_PROJECT_ENDPOINT ? new URL(process.env.FOUNDRY_PROJECT_ENDPOINT).hostname.split(".")[0] : undefined);

const providerEnv: Record<Provider, Record<string, string>> = {
  anthropic: {},
  bedrock: { CLAUDE_CODE_USE_BEDROCK: "1" },
  foundry: {
    CLAUDE_CODE_USE_FOUNDRY: "1",
    ...(foundryResource && !process.env.ANTHROPIC_FOUNDRY_BASE_URL ? { ANTHROPIC_FOUNDRY_RESOURCE: foundryResource } : {}),
  },
};

const options: Options = {
  model: modelId,
  systemPrompt: INSTRUCTIONS,
  env: { ...process.env, ...providerEnv[provider] } as Record<string, string>,
  mcpServers: { travel: travelServer },
  tools: [], // 組み込みツール（Read / Bash / WebSearch など）は使わない
  allowedTools: ["mcp__travel__get_weather", "mcp__travel__get_local_time"], // 確認なしで実行してよいツール
  permissionMode: "dontAsk", // 許可リストにないツールは聞かずに拒否（サーバーには確認する人がいないため）
  settingSources: [], // ~/.claude や CLAUDE.md の設定を読み込まない（どこで動かしても同じ動きにする）
  persistSession: false, // 会話の記録をディスクに残さない
  maxTurns: 8, // ループの上限
  includePartialMessages: true, // 文章を少しずつ受け取る（ストリーミング用）
};

/** エージェントを 1 回実行し、SDK のメッセージをそのまま流す */
export function runAgent(prompt: string): AsyncGenerator<SDKMessage> {
  return query({ prompt, options });
}

/** SDK のメッセージを、3 サンプル共通のイベントの形に変換する */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "result"; result: string; turns: number; costUsd: number }
  | { type: "error"; error: string };

export function toEvents(message: SDKMessage): AgentEvent[] {
  switch (message.type) {
    case "stream_event": {
      const ev = message.event;
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") return [{ type: "text", text: ev.delta.text }];
      return [];
    }
    case "assistant":
      return message.message.content.flatMap((block) =>
        block.type === "tool_use" ? [{ type: "tool_call" as const, name: block.name, input: block.input }] : [],
      );
    case "result":
      return message.subtype === "success"
        ? [{ type: "result", result: message.result, turns: message.num_turns, costUsd: message.total_cost_usd }]
        : [{ type: "error", error: `${message.subtype}: ${message.errors?.join(" / ") ?? ""}` }];
    default:
      return [];
  }
}

/** エージェントを 1 回動かし、途中経過を 4 つのサンプル共通の形で流す（A2A の窓口が使う） */
export async function* streamAgent(prompt: string): AsyncGenerator<AgentEvent> {
  for await (const message of runAgent(prompt)) yield* toEvents(message);
}
