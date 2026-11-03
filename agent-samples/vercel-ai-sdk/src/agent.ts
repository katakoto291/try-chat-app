// Vercel AI SDK でのエージェント定義。
// ToolLoopAgent は「モデルを呼ぶ → ツールを実行 → 結果を渡してまた呼ぶ」のループを自動で回してくれます。

import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { z } from "zod";
import { createModel, resolveProvider } from "./model.js";
import { INSTRUCTIONS, getLocalTime, getWeather } from "./tools.js";

export const provider = resolveProvider();
const { model, modelId } = createModel(provider);
export { modelId };

export const agent = new ToolLoopAgent({
  model,
  instructions: INSTRUCTIONS,
  tools: {
    get_weather: tool({
      description: "指定した都市の今日の天気を調べる",
      inputSchema: z.object({ city: z.string().describe("都市名（例: 東京、ロンドン）") }),
      execute: async ({ city }) => getWeather(city),
    }),
    get_local_time: tool({
      description: "指定した都市の現在の現地時刻を調べる",
      inputSchema: z.object({ city: z.string().describe("都市名（例: 東京、ロンドン）") }),
      execute: async ({ city }) => getLocalTime(city),
    }),
  },
  // ループの上限。ツールを呼び続けて止まらない事故を防ぐ
  stopWhen: stepCountIs(8),
});
