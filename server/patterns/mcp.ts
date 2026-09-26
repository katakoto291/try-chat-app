import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { AGENTS, toolNameFor, type AgentDefinition } from "../agents/definitions.js";
import { runAgent } from "../agents/runAgent.js";
import { TRACE_META_KEY, contextFromMeta, type RunContext, type TraceMeta } from "../runs.js";
import type { BetaTool } from "../llm/types.js";
import type { PeerConnection } from "./types.js";
import { loggingFetch } from "./wireLog.js";

/**
 * パターン 2: MCP (Model Context Protocol)
 *
 * MCP は「LLM アプリ（ホスト）に、外部のツールやデータをつなぐ」ためのプロトコル。
 * ここではサブエージェントを MCP サーバーの "ツール" として公開する。
 *
 *   呼び出し側エージェント（MCP クライアント）          MCP サーバー（/mcp）
 *     initialize  ─────────────────────────────▶   サーバー情報・能力を返す
 *     tools/list  ─────────────────────────────▶   call_researcher などのツール一覧（JSON Schema 付き）
 *     tools/call  ─────────────────────────────▶   ツールの中でサブエージェントを実行し、結果を返す
 *
 * ポイント:
 * - ツール定義（名前・説明・入力スキーマ）は "サーバー側" が決め、クライアントは tools/list で知る
 * - 呼ばれる側は「ツール」なので、1 回の呼び出し = 1 回の関数実行（入力 → 出力）
 */

// ────────────────────────────── サーバー側 ──────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "try-chat-app-agents", version: "1.0.0" });

  for (const def of Object.values(AGENTS)) {
    if (def.id === "orchestrator") continue;
    server.registerTool(
      toolNameFor(def.id),
      {
        title: def.label,
        description: `${def.label}エージェントに仕事を依頼する。${def.description}`,
        inputSchema: {
          task: z.string().describe("依頼内容。相手はこれまでの会話を知らないので、前提も含めて具体的に書く"),
        },
      },
      async ({ task }, extra) => {
        // クライアントが _meta に載せてきたトレース情報から、実行コンテキストを復元する
        const ctx = contextFromMeta(extra._meta?.[TRACE_META_KEY]);
        if (!ctx) return { isError: true, content: [{ type: "text", text: "トレース情報がありません" }] };

        const { text } = await runAgent(def.id, [{ role: "user", content: task }], ctx);
        return { content: [{ type: "text", text }] };
      },
    );
  }
  return server;
}

/**
 * Hono から呼ばれる /mcp のハンドラ。
 * ステートレスモード（セッションなし）なので、リクエストごとにサーバーを作る。
 */
export async function handleMcpRequest(req: Request): Promise<Response> {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // 学習用に、SSE ではなく素の JSON で応答させて読みやすくする
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

// ────────────────────────────── クライアント側 ──────────────────────────────

export async function connectMcp(caller: AgentDefinition, callerCallId: string, ctx: RunContext): Promise<PeerConnection> {
  const client = new Client({ name: `${caller.id}-agent`, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", ctx.baseUrl), {
    fetch: loggingFetch(ctx, callerCallId, "mcp"),
  });

  // initialize → notifications/initialized のハンドシェイク
  await client.connect(transport);

  // tools/list でサーバーが公開しているツールを知る。どれを使わせるかはホスト（呼び出し側）の方針
  const allowed = new Set(caller.call.canCall.map(toolNameFor));
  const { tools } = await client.listTools();

  return {
    tools: tools
      .filter((t) => allowed.has(t.name))
      .map((t): BetaTool => {
        // MCP のツール定義（JSON Schema）を、そのまま Claude のツール定義に変換する
        const { $schema: _ignored, ...schema } = t.inputSchema as Record<string, unknown>;
        return {
          name: t.name,
          description: t.description ?? "",
          input_schema: schema as BetaTool["input_schema"],
          eager_input_streaming: true,
        };
      }),

    async call(target, task) {
      const meta: TraceMeta = { runId: ctx.runId, parentCallId: callerCallId, depth: ctx.depth + 1 };
      const result = await client.callTool(
        { name: toolNameFor(target), arguments: { task }, _meta: { [TRACE_META_KEY]: meta } },
        undefined,
        // サブエージェントは時間がかかるので、既定の 60 秒より長く待つ
        { timeout: 10 * 60_000, signal: ctx.signal },
      );
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
      return { text, isError: result.isError === true };
    },

    close: () => client.close(),
  };
}
