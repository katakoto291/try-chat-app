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

export const AGENT_ID = "travel-strands";

const skill = (id: string, name: string, description: string, examples: string[]): AgentSkill => ({
  id, name, description, tags: [id], examples, inputModes: ["text/plain"], outputModes: ["text/plain"], securityRequirements: [],
});

/** publicUrl は、外から見たこのエージェントの URL（A2A の JSON-RPC はここに POST する） */
export function agentCard(publicUrl: string): AgentCard & { id: string } {
  return {
    id: AGENT_ID,
    name: "旅行アシスタント（Strands）",
    description: "都市の天気と現地時刻を調べて答える旅行の相談役",
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
    skill("weather", "天気", "都市の今日の天気（学習用のダミーデータ）を調べて答える", ["東京の天気は？"]),
    skill("local-time", "現地時刻", "都市の現在の現地時刻を調べて答える", ["ロンドンは今何時？"]),
    ],
    signatures: [],
  };
}
