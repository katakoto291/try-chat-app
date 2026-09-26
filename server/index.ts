import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { app, client } from "./app.js";
import { authEnabled } from "./auth.js";

/**
 * ローカル（npm run dev / npm start）で動かすときの入り口。
 * Vercel では api/index.ts が入り口になり、この serve() は使われない。
 */

// npm run build 後は、ビルド済みのフロントエンドも配信する
app.use("/*", serveStatic({ root: "./dist" }));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`API server: http://localhost:${port}  (LLM_MODE=${client.mode}, ログイン: ${authEnabled ? "あり" : "なし"})`);
  if (client.mode === "mock") {
    console.log("ANTHROPIC_API_KEY が未設定のため、モックモードで動作します。");
  }
});
