// 観光プランナーのエージェント定義（Strands Agents TypeScript 版）。
//
// 旅行アシスタント（../strands）との違いは、ツールの持ち方です。
//   get_weather          … 自分のコードの中にあるツール（いつもどおり tool() で書く）
//   search_spots など     … MCP サーバーにあるツール（McpClient を tools に入れるだけ）
// Claude からはどちらも同じ「ツール」に見えます。

import { Agent, tool } from "@strands-agents/sdk";
import { z } from "zod";
import { createMcpClient } from "./mcp.js";
import { createModel, resolveProvider } from "./model.js";
import { INSTRUCTIONS, getWeather } from "./weather.js";

export const provider = resolveProvider();
const { model, modelId } = createModel(provider);
export { modelId };

const getWeatherTool = tool({
  name: "get_weather",
  description: "指定した都市の今日の天気を調べる",
  inputSchema: z.object({ city: z.string().describe("都市名（例: 東京）") }),
  callback: ({ city }) => getWeather(city),
});

/** 3 サンプル共通のイベントの形 */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "result"; result: string };

/** エージェントを 1 回動かし、途中経過を共通のイベントの形で流す */
export async function* streamAgent(prompt: string): AsyncGenerator<AgentEvent> {
  const mcp = createMcpClient();
  // Agent は会話履歴を持つので、リクエストごとに作り直す（MCP の接続も同じく使い捨て）
  const agent = new Agent({
    model,
    systemPrompt: INSTRUCTIONS,
    tools: [getWeatherTool, mcp], // ← MCP サーバーのツールがまとめて追加される
    printer: false,
  });

  try {
    for await (const event of agent.stream(prompt)) {
      if (event.type === "modelStreamUpdateEvent") {
        const ev = event.event;
        if (ev.type === "modelContentBlockDeltaEvent" && ev.delta.type === "textDelta") yield { type: "text", text: ev.delta.text };
      } else if (event.type === "beforeToolCallEvent") {
        yield { type: "tool_call", name: event.toolUse.name, input: event.toolUse.input };
      } else if (event.type === "agentResultEvent") {
        yield { type: "result", result: event.result.toString().trim() };
      }
    }
  } finally {
    await mcp.disconnect();
  }
}

/** 最後まで実行して、答えとツール呼び出しの一覧を返す */
export async function runAgent(prompt: string) {
  const toolCalls: { name: string; input: unknown }[] = [];
  let result = "";
  for await (const ev of streamAgent(prompt)) {
    if (ev.type === "tool_call") toolCalls.push({ name: ev.name, input: ev.input });
    if (ev.type === "result") result = ev.result;
  }
  return { result, toolCalls };
}
