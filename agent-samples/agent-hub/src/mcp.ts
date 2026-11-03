// ハブ自身を MCP サーバーとしても公開する。
// Claude Code や、各 SDK で作ったエージェントから「MCP の URL を 1 つ教えるだけ」で、
// ハブに登録された全エージェントを呼べるようになります。
//
//   list_agents                … 登録されているエージェントの一覧（名前・説明・できること・状態）
//   call_agent(agent_id, task) … エージェントに仕事を頼み、最終回答を返す

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getAgent, invoke, listAgents } from "./registry.js";

const text = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

export function createHubMcpServer(): McpServer {
  const server = new McpServer({ name: "agent-hub", version: "1.0.0" });

  server.registerTool(
    "list_agents",
    {
      title: "エージェント一覧",
      description: "agent-hub に登録されているエージェントの一覧（ID・名前・説明・できること・状態）を返す",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      text(
        listAgents().map((a) => ({
          id: a.id,
          name: a.card.name,
          description: a.card.description,
          skills: (a.card.skills ?? []).map((s) => s.name),
          status: a.status,
        })),
      ),
  );

  server.registerTool(
    "call_agent",
    {
      title: "エージェントに依頼",
      description: "agent-hub に登録されたエージェントに仕事を頼み、最終回答を返す。先に list_agents で ID を調べること",
      inputSchema: z.object({
        agent_id: z.string().describe("list_agents で得たエージェントの ID"),
        task: z.string().describe("依頼内容。相手はこれまでの会話を知らないので、前提も含めて書く"),
      }),
    },
    async ({ agent_id, task }) => {
      const agent = getAgent(agent_id);
      if (!agent) return text(`エージェント「${agent_id}」は登録されていません。list_agents で確認してください`, true);
      // MCP のツールは 1 往復なので、ストリーミングせずに最終回答だけを受け取る
      const res = await invoke(agent, JSON.stringify({ prompt: task, stream: false }));
      const body = (await res.json().catch(() => ({}))) as { result?: string; error?: string };
      return res.ok && body.result ? text(body.result) : text(`失敗しました: ${body.error ?? `HTTP ${res.status}`}`, true);
    },
  );

  return server;
}
