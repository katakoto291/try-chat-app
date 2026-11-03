// このエージェントの「自己紹介」（Agent Card）。
// 呼ぶ側（チャットアプリや agent-hub）は、これを読んで「誰が・何をできるか」を知ります。
// A2A の Agent Card を参考にした形ですが、呼び出しは A2A ではなく POST /invocations です。
//
// 取り方は 2 通り:
//   GET  /.well-known/agent-card.json      … ローカルや、パスがそのまま届く場所で
//   POST /invocations {"action":"describe"} … AgentCore / Foundry など、/invocations しか届かない場所で

import { modelId, provider } from "./agent.js";

export const AGENT_CARD = {
  id: "travel-claude-agent-sdk",
  name: "旅行アシスタント（Claude Agent SDK）",
  description: "都市の天気と現地時刻を調べて答える旅行の相談役",
  version: "1.0.0",
  framework: "claude-agent-sdk",
  provider,
  model: modelId,
  protocol: "invocations",
  input: { prompt: "string（依頼内容。相手はこれまでの会話を知らないので、前提も含めて書く）" },
  skills: [
    { id: "weather", name: "天気", description: "都市の今日の天気（学習用のダミーデータ）を調べて答える", examples: ["東京の天気は？"] },
    { id: "local-time", name: "現地時刻", description: "都市の現在の現地時刻を調べて答える", examples: ["ロンドンは今何時？"] },
  ],
};
