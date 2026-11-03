import { expect, type Locator, type Page } from "@playwright/test";

/** テスト用サーバーのポート（playwright.config.ts で起動する） */
export const PORT = 3210;
export const AUTH_PORT = 3211;
export const AUTH_URL = `http://localhost:${AUTH_PORT}`;
export const AUTH_PASSWORD = "e2e-password";

export type TopologyLabel = "呼び出し" | "ハンドオフ" | "Pub/Sub";
export type ProtocolLabel = "直接呼び出し" | "MCP" | "A2A";
export type TransportLabel = "独自 SSE" | "AG-UI";

/** 入力欄の上の切り替えボタン（連携パターン / プロトコル / 画面との通信） */
export function setting(page: Page, group: "連携パターン" | "プロトコル" | "画面との通信", name: string): Locator {
  return page.getByRole("radiogroup", { name: group }).getByRole("radio", { name, exact: true });
}

export async function configure(
  page: Page,
  opts: { topology?: TopologyLabel; protocol?: ProtocolLabel; transport?: TransportLabel },
) {
  if (opts.topology) await setting(page, "連携パターン", opts.topology).click();
  if (opts.protocol) await setting(page, "プロトコル", opts.protocol).click();
  if (opts.transport) await setting(page, "画面との通信", opts.transport).click();
}

export function composer(page: Page): Locator {
  return page.getByPlaceholder(/メッセージを入力/);
}

/** 質問を送って、返答が終わる（停止ボタンが消え、送信ボタンに戻る）まで待つ */
export async function ask(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press("Enter");
  await expect(page.getByRole("button", { name: "送信" })).toBeVisible({ timeout: 30_000 });
}

/** 最後のアシスタントの返答 */
export function lastAnswer(page: Page): Locator {
  return page.locator(".message.assistant").last();
}

export function tracePanel(page: Page): Locator {
  return page.locator("aside.trace");
}

/** 呼び出しツリーに出ているエージェント名（出てきた順） */
export function treeAgents(page: Page): Locator {
  return tracePanel(page).locator(".call-head .agent-badge");
}

/** 通信ログ / AG-UI イベントの各行のラベル */
export async function openTab(page: Page, name: RegExp | string) {
  await tracePanel(page).getByRole("tab", { name }).click();
}

export function logLabels(page: Page): Locator {
  return tracePanel(page).locator(".wire-label");
}
