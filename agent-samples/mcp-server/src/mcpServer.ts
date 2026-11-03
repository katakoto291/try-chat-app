// MCP サーバーの中身: 「何を公開するか」を登録する部分。
//
// MCP サーバーが公開できるものは 3 種類あります。
//   ツール（tools）       … AI が「呼び出す」関数。エージェントが一番よく使う
//   リソース（resources） … AI やアプリが「読む」データ（URI で指定する）
//   プロンプト（prompts） … 利用者が選んで使う、定型の指示文のひな形
// エージェントの SDK（Strands / Vercel AI SDK / Claude Agent SDK）が自動で使うのは主に「ツール」です。

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CITIES, SPOTS, getSpot, searchSpots } from "./spots.js";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

/** リクエストごとに新しいサーバーを作る（状態を持たない＝どのコンテナで受けても同じ結果になる） */
export function createServer(): McpServer {
  const server = new McpServer({ name: "travel-spots", version: "1.0.0" });

  // --- ツール --------------------------------------------------------------
  server.registerTool(
    "search_spots",
    {
      title: "観光スポット検索",
      description: `都市の観光スポットを探す。対応都市: ${CITIES.join("、")}`,
      inputSchema: z.object({
        city: z.string().describe("都市名（例: 東京）"),
        category: z.enum(["観光", "グルメ", "自然", "買い物"]).optional().describe("絞り込むカテゴリ"),
        indoorOnly: z.boolean().optional().describe("true なら屋内（雨でも楽しめる）スポットだけ"),
      }),
      annotations: { readOnlyHint: true }, // データを書き換えないツールだと伝える
    },
    async ({ city, category, indoorOnly }) => json(searchSpots(city, category, indoorOnly ?? false)),
  );

  server.registerTool(
    "get_spot_details",
    {
      title: "スポットの詳細",
      description: "search_spots で見つけたスポットの ID を渡すと、営業時間や説明などの詳細を返す",
      inputSchema: z.object({ id: z.string().describe("スポット ID（例: tokyo-asakusa）") }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const spot = getSpot(id);
      // 見つからないときは isError: true にすると、AI は「失敗した」と分かって別の手を考えられる
      return spot ? json(spot) : { content: [{ type: "text" as const, text: `ID「${id}」は見つかりません` }], isError: true };
    },
  );

  // --- リソース ------------------------------------------------------------
  server.registerResource(
    "all-spots",
    "spots://all",
    { title: "全スポット一覧", description: "登録されている全スポットのデータ", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(SPOTS, null, 2) }] }),
  );

  // --- プロンプト ----------------------------------------------------------
  server.registerPrompt(
    "plan_day_trip",
    {
      title: "日帰りプランを作る",
      description: "都市を指定して、日帰り観光プランを頼むときのひな形",
      argsSchema: z.object({ city: z.string().describe("都市名") }),
    },
    ({ city }) => ({
      messages: [
        { role: "user", content: { type: "text", text: `${city}で日帰り観光をします。天気も考えて、回る順番つきのプランを作ってください。` } },
      ],
    }),
  );

  return server;
}
