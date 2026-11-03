import { expect, test } from "@playwright/test";
import { AUTH_PASSWORD, AUTH_URL, ask, lastAnswer } from "./helpers.js";

/** 合言葉ログイン（APP_PASSWORD を設定したサーバーで確かめる） */
test.use({ baseURL: AUTH_URL });

test("合言葉がないと API は 401 を返す", async ({ request }) => {
  expect((await request.get("/api/config")).status()).toBe(401);
  const chat = await request.post("/api/chat", { data: { messages: [{ role: "user", content: "こんにちは" }] } });
  expect(chat.status()).toBe(401);
});

test("合言葉が違うとログインできない", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agent Chat" })).toBeVisible();
  await expect(page.getByRole("button", { name: "ログイン" })).toBeDisabled();

  await page.getByPlaceholder("合言葉").fill("wrong-password");
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page.getByText("合言葉が違います")).toBeVisible();
});

test("正しい合言葉でログインして使え、ログアウトすると戻る", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("合言葉").fill(AUTH_PASSWORD);
  await page.getByPlaceholder("合言葉").press("Enter");

  await expect(page.getByRole("heading", { name: "何を手伝いましょうか？" })).toBeVisible();
  await ask(page, "こんにちは");
  await expect(lastAnswer(page)).toContainText("（モック）こんにちは！");

  // リロードしてもログインしたまま
  await page.reload();
  await expect(page.getByRole("button", { name: "ログアウト" })).toBeVisible();

  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page.getByRole("heading", { name: "Agent Chat" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Agent Chat" })).toBeVisible();
});
