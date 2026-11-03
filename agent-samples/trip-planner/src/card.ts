// このエージェントの「自己紹介」（Agent Card）。
// 呼ぶ側（チャットアプリや agent-hub）は、これを読んで「誰が・何をできるか」を知ります。
// A2A の Agent Card を参考にした形ですが、呼び出しは A2A ではなく POST /invocations です。
//
// 取り方は 2 通り:
//   GET  /.well-known/agent-card.json      … ローカルや、パスがそのまま届く場所で
//   POST /invocations {"action":"describe"} … AgentCore / Foundry など、/invocations しか届かない場所で

import { modelId, provider } from "./agent.js";

export const AGENT_CARD = {
  id: "trip-planner",
  name: "観光プランナー",
  description: "天気と観光スポットを調べて、日帰りの観光プランを作る",
  version: "1.0.0",
  framework: "strands",
  provider,
  model: modelId,
  protocol: "invocations",
  input: { prompt: "string（依頼内容。相手はこれまでの会話を知らないので、前提も含めて書く）" },
  skills: [
    { id: "day-trip", name: "日帰りプラン", description: "天気と観光スポット（MCP サーバー）を調べて、時間つきの日帰り観光プランを作る", examples: ["雨でも楽しめる大阪の日帰りプランを作って"] },
  ],
};
