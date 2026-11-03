// このエージェントの「自己紹介」（A2A の Agent Card）。
// 呼ぶ側（チャットアプリ、agent-hub、ほかの A2A クライアント）は、これを読んで「誰が・何をできるか・どこで受け付けるか」を知ります。
//
// 取り方は 3 通り（中身は同じ）:
//   GET  /.well-known/agent-card.json        … A2A の標準の場所。AgentCore の GetAgentCard API もここを読む
//   POST /invocations {"action":"describe"}   … /invocations しか届かない場所（AgentCore の HTTP 方式、Foundry）向け
//   AgentCore に A2A 方式で載せた場合は、AWS の GetAgentCard API でも取れる
//
// 中身は A2A v1.0 の Agent Card です。id だけは、このサンプル集で使う追加の項目です
// （agent-hub やチャットアプリが、ツール名などに使う英数字の名前として読みます）。

import type { AgentCard, AgentSkill } from "@a2a-js/sdk";
import { modelId, provider } from "./agent.js";

export const AGENT_ID = "trip-planner";

const skill = (id: string, name: string, description: string, examples: string[]): AgentSkill => ({
  id, name, description, tags: [id], examples, inputModes: ["text/plain"], outputModes: ["text/plain"], securityRequirements: [],
});

/** publicUrl は、外から見たこのエージェントの URL（A2A の JSON-RPC はここに POST する） */
export function agentCard(publicUrl: string): AgentCard & { id: string } {
  return {
    id: AGENT_ID,
    name: "観光プランナー",
    description: "天気と観光スポットを調べて、日帰りの観光プランを作る",
    version: "1.0.0",
    // どこで受け付けるか。A2A v1.0 の JSON-RPC で、publicUrl に POST する
    supportedInterfaces: [{ url: publicUrl, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" }],
    // 誰が作ったか（ここでは、SDK と使っているモデルを書いておく）
    provider: { organization: `agent-samples / strands / ${provider}:${modelId}`, url: "https://github.com/katakoto291/try-chat-app" },
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
    skill("day-trip", "日帰りプラン", "天気と観光スポット（MCP サーバー）を調べて、時間つきの日帰り観光プランを作る", [
      "雨でも楽しめる大阪の日帰りプランを作って",
    ]),
    ],
    signatures: [],
  };
}
