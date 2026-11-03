// Strands Agents（TypeScript 版 @strands-agents/sdk）でのエージェント定義。
// Strands は AWS が公開しているオープンソースのエージェント SDK です。
// Agent({ model, tools, systemPrompt }) を作って呼ぶだけで、
// 「モデルを呼ぶ → ツールを実行 → 結果を渡してまた呼ぶ」のループを回してくれます。

import { Agent, tool } from "@strands-agents/sdk";
import { z } from "zod";
import { createModel, resolveProvider } from "./model.js";
import { INSTRUCTIONS, getLocalTime, getWeather } from "./tools.js";

export const provider = resolveProvider();
const { model, modelId } = createModel(provider);
export { modelId };

// --- ツール -----------------------------------------------------------------
// name・description・入力の型（Zod）・中身（callback）を 1 か所に書く
const getWeatherTool = tool({
  name: "get_weather",
  description: "指定した都市の今日の天気を調べる",
  inputSchema: z.object({ city: z.string().describe("都市名（例: 東京、ロンドン）") }),
  callback: ({ city }) => getWeather(city),
});

const getLocalTimeTool = tool({
  name: "get_local_time",
  description: "指定した都市の現在の現地時刻を調べる",
  inputSchema: z.object({ city: z.string().describe("都市名（例: 東京、ロンドン）") }),
  callback: ({ city }) => getLocalTime(city),
});

/**
 * リクエストごとに新しい Agent を作る。
 * Agent は会話履歴（agent.messages）を自分の中に持つので、使い回すと別の人の会話が混ざります。
 * 会話を続けたいときは、セッション ID ごとに Agent（または履歴）を保存して使い分けます。
 */
export function createAgent(): Agent {
  return new Agent({
    model,
    systemPrompt: INSTRUCTIONS,
    tools: [getWeatherTool, getLocalTimeTool],
    printer: false, // 既定では途中経過を標準出力に書くので、オフにする
  });
}

/** 3 サンプル共通のイベントの形 */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "result"; result: string };

/** Strands のイベントを、共通のイベントの形に変換して流す */
export async function* streamAgent(prompt: string): AsyncGenerator<AgentEvent> {
  const agent = createAgent();
  for await (const event of agent.stream(prompt)) {
    if (event.type === "modelStreamUpdateEvent") {
      // モデルから届く細かいイベントのうち、文章の断片だけを取り出す
      const ev = event.event;
      if (ev.type === "modelContentBlockDeltaEvent" && ev.delta.type === "textDelta") yield { type: "text", text: ev.delta.text };
    } else if (event.type === "beforeToolCallEvent") {
      yield { type: "tool_call", name: event.toolUse.name, input: event.toolUse.input };
    } else if (event.type === "agentResultEvent") {
      yield { type: "result", result: event.result.toString().trim() };
    }
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
