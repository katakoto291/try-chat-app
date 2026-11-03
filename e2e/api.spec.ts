import { expect, test } from "@playwright/test";

/** 画面を通さず、サーバーの公開エンドポイントを直接確かめる */

test("/api/config はモックモードと 5 つのエージェントを返す", async ({ request }) => {
  const res = await request.get("/api/config");
  expect(res.ok()).toBe(true);
  const config = await res.json();
  expect(config.mode).toBe("mock");
  expect(config.auth).toBe(false);
  expect(config.agents.map((a: { id: string }) => a.id)).toEqual(["orchestrator", "researcher", "writer", "coder", "reviewer"]);
});

test("A2A の Agent Card を取得できる", async ({ request }) => {
  const res = await request.get("/a2a/coder/.well-known/agent-card.json");
  expect(res.ok()).toBe(true);
  const card = await res.json();
  expect(card.name).toBeTruthy();
  expect(Array.isArray(card.skills)).toBe(true);
  expect(JSON.stringify(card)).toContain("/a2a/coder");
});

test("存在しないエージェントの Agent Card は 404", async ({ request }) => {
  expect((await request.get("/a2a/unknown/.well-known/agent-card.json")).status()).toBe(404);
});

test("POST /api/chat は SSE でイベントを返し、done で終わる", async ({ request }) => {
  const res = await request.post("/api/chat", {
    data: { messages: [{ role: "user", content: "こんにちは" }], topology: "call", pattern: "direct" },
  });
  expect(res.ok()).toBe(true);
  expect(res.headers()["content-type"]).toContain("text/event-stream");
  const types = (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5)).type as string);
  expect(types).toContain("agent_start");
  expect(types).toContain("text");
  expect(types.at(-1)).toBe("done");
});
