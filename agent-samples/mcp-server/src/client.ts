// MCP サーバーに「素の MCP クライアント」でつないで、何が公開されているかを見る。
// エージェントの SDK が裏でやっていること（一覧を取る → ツールを呼ぶ）を、手で 1 つずつやってみる例です。
//
//   npm run inspect                              # http://localhost:8000/mcp
//   npm run inspect -- https://example.com/mcp

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = new URL(process.argv[2] ?? "http://localhost:8000/mcp");
const client = new Client({ name: "inspect", version: "1.0.0" });
const token = process.env.MCP_BEARER_TOKEN; // サーバー側で合言葉を設定しているときだけ
await client.connect(
  new StreamableHTTPClientTransport(url, token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}),
);

const { tools } = await client.listTools();
console.log("■ ツール一覧（tools/list）");
for (const t of tools) console.log(`- ${t.name}: ${t.description}\n  入力: ${JSON.stringify(t.inputSchema)}`);

const { resources } = await client.listResources();
console.log("\n■ リソース一覧（resources/list）");
for (const r of resources) console.log(`- ${r.uri}: ${r.description}`);

const { prompts } = await client.listPrompts();
console.log("\n■ プロンプト一覧（prompts/list）");
for (const p of prompts) console.log(`- ${p.name}: ${p.description}`);

console.log("\n■ ツールを呼ぶ（tools/call search_spots）");
const result = await client.callTool({ name: "search_spots", arguments: { city: "東京", indoorOnly: true } });
console.log(JSON.stringify(result.content, null, 2));

await client.close();
