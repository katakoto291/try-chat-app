import { expect, test } from "@playwright/test";
import { ask, configure, lastAnswer, logLabels, openTab, tracePanel, treeAgents } from "./helpers.js";

/**
 * 連携パターン × プロトコル × 画面との通信 の組み合わせごとに、
 * 「誰が呼ばれたか（呼び出しツリー）」と「何が通信されたか（通信ログ）」を確かめる。
 * モックモードでは、長い質問 → リサーチャーとライター、コードの依頼 → コーダー → レビュアー に振り分けられる。
 */

const RESEARCH = "量子コンピュータについて、初心者向けに調べてわかりやすく説明して";
const CODE = "Python で FizzBuzz を書くコードを作って";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

const vias = (page: import("@playwright/test").Page) => tracePanel(page).locator(".call-head .via");

test.describe("呼び出し", () => {
  test("直接呼び出し: リサーチャーとライターを並列に呼び、結果をまとめる", async ({ page }) => {
    await configure(page, { topology: "呼び出し", protocol: "直接呼び出し" });
    await ask(page, RESEARCH);

    await expect(lastAnswer(page)).toContainText("（モック）専門エージェントの結果をまとめました。");
    await expect(lastAnswer(page).locator(".trace-chip")).toContainText("呼び出し / 直接呼び出し · エージェント 3 回");
    await expect(treeAgents(page)).toHaveText(["司令塔", "リサーチャー", "ライター"]);
    await expect(vias(page)).toHaveText(["via 直接", "via 直接"]);
    await expect(tracePanel(page).locator(".status.done")).toHaveCount(3);

    await openTab(page, /通信ログ/);
    await expect(logLabels(page)).toContainText(['runAgent("researcher", task)', 'runAgent("writer", task)']);
  });

  test("MCP: initialize → tools/list → tools/call の順に通信する（入れ子の呼び出しも）", async ({ page }) => {
    await configure(page, { topology: "呼び出し", protocol: "MCP" });
    await ask(page, CODE);

    await expect(lastAnswer(page)).toContainText("レビューの指摘を反映した最終版です");
    await expect(treeAgents(page)).toHaveText(["司令塔", "コーダー", "レビュアー"]);
    await expect(vias(page)).toHaveText(["via MCP", "via MCP"]);

    await openTab(page, /通信ログ/);
    const labels = await logLabels(page).allInnerTexts();
    const first = (label: string) => labels.indexOf(label);
    expect(first("initialize")).toBeGreaterThanOrEqual(0);
    expect(first("initialize")).toBeLessThan(first("tools/list"));
    expect(first("tools/list")).toBeLessThan(first("tools/call (call_coder)"));
    expect(labels).toContain("tools/call (call_reviewer)");

    // 通信の中身（JSON-RPC）を開いて見られる
    await tracePanel(page).locator(".wire-head").filter({ hasText: "tools/call (call_coder)" }).click();
    await expect(tracePanel(page).locator(".wire-body").first()).toContainText('"jsonrpc"');
  });

  test("A2A: Agent Card を取得し、Task の状態が SUBMITTED → WORKING → COMPLETED と進む", async ({ page }) => {
    await configure(page, { topology: "呼び出し", protocol: "A2A" });
    await ask(page, CODE);

    await expect(treeAgents(page)).toHaveText(["司令塔", "コーダー", "レビュアー"]);
    await expect(vias(page)).toHaveText(["via A2A", "via A2A"]);

    await openTab(page, /通信ログ/);
    const labels = await logLabels(page).allInnerTexts();
    expect(labels).toContain("GET Agent Card（coder）");
    expect(labels).toContain("SendStreamingMessage");
    const submitted = labels.indexOf("task → TASK_STATE_SUBMITTED");
    const working = labels.indexOf("statusUpdate → TASK_STATE_WORKING");
    const completed = labels.indexOf("statusUpdate → TASK_STATE_COMPLETED");
    expect(submitted).toBeGreaterThanOrEqual(0);
    expect(submitted).toBeLessThan(working);
    expect(working).toBeLessThan(completed);
    expect(labels).toContain("artifactUpdate");
  });
});

test("ハンドオフ: 司令塔 ⇒ コーダー ⇒ レビュアー と引き継ぎ、最後の担当者が答える", async ({ page }) => {
  await configure(page, { topology: "ハンドオフ" });
  await ask(page, CODE);

  await expect(lastAnswer(page)).toContainText("（モック）レビュー結果:");
  await expect(lastAnswer(page).locator(".trace-chip")).toContainText("ハンドオフ · エージェント 3 回");
  await expect(treeAgents(page)).toHaveText(["司令塔", "コーダー", "レビュアー"]);
  await expect(vias(page)).toHaveText(["via ハンドオフ", "via ハンドオフ"]);
  await expect(tracePanel(page).locator(".root-link")).toHaveText(["⇓ ハンドオフ（会話ごと引き継ぎ）", "⇓ ハンドオフ（会話ごと引き継ぎ）"]);

  await openTab(page, /通信ログ/);
  await expect(logLabels(page)).toHaveText(["TRANSFER 司令塔 ⇒ コーダー", "TRANSFER コーダー ⇒ レビュアー"]);
});

test("Pub/Sub: イベントが連鎖し、司令塔が届いた結果を集約する", async ({ page }) => {
  await configure(page, { topology: "Pub/Sub" });
  await ask(page, CODE);

  await expect(lastAnswer(page)).toContainText("（モック）届いたイベントの結果をまとめました。");
  await expect(treeAgents(page)).toHaveText(["司令塔", "コーダー", "レビュアー", "司令塔"]);
  await expect(tracePanel(page).locator(".root-link")).toHaveText(["⇓ 購読していたイベントが出そろったので、集約"]);

  await openTab(page, /通信ログ/);
  await expect(logLabels(page)).toHaveText([
    "PUBLISH code.requested",
    "DELIVER code.requested → コーダー",
    "PUBLISH code.written",
    "DELIVER code.written → レビュアー",
    "DELIVER code.written → 司令塔（集約）",
    "PUBLISH review.completed",
    "DELIVER review.completed → 司令塔（集約）",
  ]);
});

test.describe("画面との通信", () => {
  test("独自 SSE では AG-UI イベントのタブが出ない", async ({ page }) => {
    await configure(page, { transport: "独自 SSE" });
    await ask(page, "こんにちは");
    await expect(tracePanel(page).getByRole("tab")).toHaveText(["呼び出しツリー", "通信ログ (0)"]);
  });

  // 独自 SSE のときと同じ返答・同じ呼び出しツリーになることも確かめる。
  // 最上位のエージェントは STEP_*、その下で呼ばれたエージェントは SUBAGENT_* になる
  // （ハンドオフは全員が最上位なので STEP_* だけ）
  const cases = [
    { topology: "呼び出し", answer: "レビューの指摘を反映した最終版です", agents: ["司令塔", "コーダー", "レビュアー"], steps: 1, subagents: 2 },
    { topology: "ハンドオフ", answer: "（モック）レビュー結果:", agents: ["司令塔", "コーダー", "レビュアー"], steps: 3, subagents: 0 },
    { topology: "Pub/Sub", answer: "（モック）届いたイベントの結果をまとめました。", agents: ["司令塔", "コーダー", "レビュアー", "司令塔"], steps: 2, subagents: 2 },
  ] as const;
  for (const { topology, answer, agents, steps, subagents } of cases) {
    test(`AG-UI（${topology}）: 独自 SSE と同じ結果になり、RUN_STARTED〜RUN_FINISHED の標準イベントが届く`, async ({ page }) => {
      await configure(page, { topology, transport: "AG-UI" });
      await ask(page, CODE);

      await expect(lastAnswer(page)).toContainText(answer);
      await expect(lastAnswer(page).locator(".trace-chip")).toContainText(`${topology} / AG-UI`);
      await expect(treeAgents(page)).toHaveText([...agents]);

      await openTab(page, /AG-UI イベント/);
      const labels = await logLabels(page).allInnerTexts();
      expect(labels[0]).toBe("RUN_STARTED");
      expect(labels.at(-1)).toBe("RUN_FINISHED");
      const count = (type: string) => labels.filter((l) => l === type).length;
      expect(count("STEP_STARTED")).toBe(steps);
      expect(count("STEP_FINISHED")).toBe(steps);
      expect(count("SUBAGENT_STARTED")).toBe(subagents);
      expect(count("SUBAGENT_FINISHED")).toBe(subagents);
      expect(labels.some((l) => l.startsWith("TEXT_MESSAGE_CONTENT"))).toBe(true);
    });
  }
});
