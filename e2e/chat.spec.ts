import { expect, test } from "@playwright/test";
import { ask, composer, configure, lastAnswer, setting, tracePanel, treeAgents } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("最初の画面に見出し・質問の例・エージェント構成が出る", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "何を手伝いましょうか？" })).toBeVisible();
  await expect(page.locator(".examples button")).toHaveCount(4);
  await expect(page.locator(".sidebar .mode")).toHaveText("モック");
  await expect(page.locator(".sidebar .agents .agent-badge")).toHaveText(["司令塔", "リサーチャー", "ライター", "コーダー", "レビュアー"]);
  await expect(page.getByRole("button", { name: "送信" })).toBeDisabled();
});

test("簡単なあいさつには、司令塔が自分で答える", async ({ page }) => {
  await ask(page, "こんにちは");

  await expect(page.locator(".message.user .bubble")).toHaveText("こんにちは");
  await expect(lastAnswer(page)).toContainText("（モック）こんにちは！「こんにちは」を受け取りました。");
  await expect(lastAnswer(page).locator(".trace-chip")).toContainText("エージェント 1 回");
  await expect(treeAgents(page)).toHaveText(["司令塔"]);
  await expect(composer(page)).toHaveValue("");
});

test("質問の例をクリックすると、その質問が送られる", async ({ page }) => {
  await page.getByRole("button", { name: "Python で FizzBuzz を書くコードを作って" }).click();
  await expect(page.locator(".message.user .bubble")).toHaveText("Python で FizzBuzz を書くコードを作って");
  await expect(lastAnswer(page)).toContainText("def fizzbuzz(n):", { timeout: 30_000 });
});

test("Shift+Enter は改行になり、送信されない", async ({ page }) => {
  await composer(page).fill("1 行目");
  await composer(page).press("Shift+Enter");
  await composer(page).pressSequentially("2 行目");
  await expect(composer(page)).toHaveValue("1 行目\n2 行目");
  await expect(page.locator(".message")).toHaveCount(0);
});

test("返答の途中で停止できる", async ({ page }) => {
  await composer(page).fill("量子コンピュータについて、初心者向けに調べてわかりやすく説明して");
  await composer(page).press("Enter");
  await page.getByRole("button", { name: "停止" }).click();

  await expect(lastAnswer(page).locator(".error")).toHaveText("⚠ 停止しました");
  await expect(page.getByRole("button", { name: "送信" })).toBeVisible();
});

test("返答中は設定を切り替えられない", async ({ page }) => {
  await composer(page).fill("量子コンピュータについて、初心者向けに調べてわかりやすく説明して");
  await composer(page).press("Enter");
  await expect(setting(page, "連携パターン", "ハンドオフ")).toBeDisabled();
  await expect(page.getByRole("button", { name: "送信" })).toBeVisible({ timeout: 30_000 });
  await expect(setting(page, "連携パターン", "ハンドオフ")).toBeEnabled();
});

test("プロトコルは「呼び出し」のときだけ選べる", async ({ page }) => {
  await expect(setting(page, "プロトコル", "MCP")).toBeEnabled();
  await configure(page, { topology: "ハンドオフ" });
  await expect(setting(page, "連携パターン", "ハンドオフ")).toHaveAttribute("aria-checked", "true");
  await expect(setting(page, "プロトコル", "MCP")).toBeDisabled();
  await expect(page.locator(".settings-summary")).toContainText("プロトコルの選択は「呼び出し」のときだけ使います");
});

test("設定と会話はリロードしても残る", async ({ page }) => {
  await configure(page, { protocol: "A2A", transport: "AG-UI" });
  await ask(page, "こんにちは");
  await page.reload();

  await expect(setting(page, "プロトコル", "A2A")).toHaveAttribute("aria-checked", "true");
  await expect(setting(page, "画面との通信", "AG-UI")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".sidebar .conv-title")).toHaveText(["こんにちは"]);
  await expect(lastAnswer(page)).toContainText("（モック）こんにちは！");
});

test("新しいチャットを始めたり、会話を切り替えたり、削除したりできる", async ({ page }) => {
  await ask(page, "1 つ目");
  await page.getByRole("button", { name: "＋ 新しいチャット" }).click();
  await expect(page.getByRole("heading", { name: "何を手伝いましょうか？" })).toBeVisible();
  await ask(page, "2 つ目");

  const titles = page.locator(".sidebar .conv-title");
  await expect(titles).toHaveText(["2 つ目", "1 つ目"]); // 新しい順

  await titles.filter({ hasText: "1 つ目" }).click();
  await expect(page.locator(".message.user .bubble")).toHaveText(["1 つ目"]);

  await page.locator(".conv").filter({ hasText: "1 つ目" }).getByRole("button", { name: "削除" }).click();
  await expect(titles).toHaveText(["2 つ目"]);
  await expect(page.getByRole("heading", { name: "何を手伝いましょうか？" })).toBeVisible();
});

test("同じ会話で続けて質問でき、トレースは選んだ返答のものが出る", async ({ page }) => {
  await ask(page, "こんにちは");
  await ask(page, "Python で FizzBuzz を書くコードを作って");
  await expect(page.locator(".message.assistant")).toHaveCount(2);
  await expect(treeAgents(page)).toHaveText(["司令塔", "コーダー", "レビュアー"]);

  // 1 つ目の返答のトレースに切り替える
  await page.locator(".message.assistant").first().locator(".trace-chip").click();
  await expect(treeAgents(page)).toHaveText(["司令塔"]);
});

test("トレースは閉じたり、返答のボタンから開き直したりできる", async ({ page }) => {
  await ask(page, "こんにちは");
  await tracePanel(page).getByRole("button", { name: "トレースを閉じる" }).click();
  await expect(tracePanel(page)).toHaveCount(0);

  await lastAnswer(page).locator(".trace-chip").click();
  await expect(tracePanel(page)).toBeVisible();
  await expect(treeAgents(page)).toHaveText(["司令塔"]);
});
