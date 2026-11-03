import { defineConfig, devices } from "@playwright/test";
import { AUTH_PASSWORD, AUTH_PORT, PORT } from "./e2e/helpers.js";

/**
 * E2E テストの設定（npm run test:e2e）。
 *
 * テスト用のサーバーを 2 つ起動する。どちらもモックモードなので API キーは不要。
 * - :3210 … 合言葉なし。ほとんどのテストはこちらを使う
 * - :3211 … 合言葉あり（APP_PASSWORD=e2e-password）。ログインのテスト用
 *
 * npx や tsx コマンドを挟むと、終了時にサーバー本体（孫プロセス）が残るので node を直接起動する。
 * ふだんの .env は読まない（LLM_MODE と APP_PASSWORD をここで決める）。
 */
const server = (port: number, password: string) => ({
  command: "node --import tsx server/index.ts",
  url: `http://localhost:${port}/api/config`,
  env: { PORT: String(port), LLM_MODE: "mock", APP_PASSWORD: password },
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
});

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "ja-JP",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    // 先にフロントエンドをビルドし、dist/ を配信する（もう 1 つのサーバーも同じ dist/ を使う）
    { ...server(PORT, ""), command: `npx vite build --logLevel warn && ${server(PORT, "").command}` },
    server(AUTH_PORT, AUTH_PASSWORD),
  ],
});
