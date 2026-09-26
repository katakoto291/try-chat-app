import { getRequestListener } from "@hono/node-server";
import { app } from "../server/app.js";

/**
 * Vercel の関数としての入り口。
 * vercel.json の rewrites で /api/*・/mcp・/a2a/* がすべてここに届き、Hono がパスで振り分ける。
 * （フロントエンドの静的ファイルは Vercel が dist/ から直接配信する）
 */
export default getRequestListener(app.fetch);
