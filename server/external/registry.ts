/**
 * 外部エージェントの一覧（どこにいて、何ができるか）。
 *
 * 外部エージェントは、このアプリとは別のサーバーで動くエージェントです
 * （agent-samples/ の旅行アシスタントや観光プランナーなど）。
 * どれも「POST /invocations で呼べる」「自己紹介（Agent Card）を返す」という約束を守っています。
 *
 * 一覧の作り方は 2 通り:
 *
 * (1) 設定から（EXTERNAL_AGENTS）
 *     EXTERNAL_AGENTS=http://localhost:8080,http://localhost:8081
 *     このアプリが、それぞれの URL から自己紹介を読みに行く。
 *     → エージェントが増えるたびに設定を書き換える。生きているかも、認証も、このアプリが面倒を見る
 *
 * (2) agent-hub から（AGENT_HUB_URL。こちらが優先）
 *     AGENT_HUB_URL=http://localhost:8090
 *     ハブの GET /agents で一覧をもらい、呼ぶときもハブ経由（POST /agents/:id/invocations）。
 *     → このアプリはハブの URL だけ知っていればよい。場所・認証・死活確認はハブが引き受ける
 */

import type { ExternalAgentInfo } from "../../shared/protocol.js";

export interface ExternalAgent {
  info: ExternalAgentInfo;
  /** POST で呼ぶ URL（{"prompt": "...", "stream": true} を送ると SSE で途中経過が返る） */
  invokeUrl: string;
  /** 呼ぶときに付けるヘッダー（ハブの合言葉など） */
  headers?: Record<string, string>;
}

export interface ExternalAgentList {
  source: "config" | "hub" | "none";
  agents: ExternalAgent[];
}

/** 自己紹介（Agent Card）の形。agent-samples/*\/src/card.ts と同じ */
interface AgentCard {
  id?: string;
  name?: string;
  description?: string;
  skills?: { name?: string; description?: string }[];
}

const CACHE_MS = 30_000;
let cache: { at: number; list: Promise<ExternalAgentList> } | undefined;

/** 外部エージェントの一覧を返す（30 秒キャッシュ） */
export function listExternalAgents(): Promise<ExternalAgentList> {
  if (!cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), list: load() };
  return cache.list;
}

async function load(): Promise<ExternalAgentList> {
  const hubUrl = process.env.AGENT_HUB_URL?.trim().replace(/\/+$/, "");
  if (hubUrl) return fromHub(hubUrl);

  const urls = (process.env.EXTERNAL_AGENTS ?? "")
    .split(",")
    .map((u) => u.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (urls.length === 0) return { source: "none", agents: [] };
  return { source: "config", agents: await Promise.all(urls.map(fromUrl)) };
}

/** agent-hub の GET /agents で一覧をもらう。呼び出し先もハブ経由にする */
async function fromHub(hubUrl: string): Promise<ExternalAgentList> {
  const headers: Record<string, string> = process.env.AGENT_HUB_TOKEN ? { authorization: `Bearer ${process.env.AGENT_HUB_TOKEN}` } : {};
  try {
    const res = await fetch(`${hubUrl}/agents`, { headers, signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { agents } = (await res.json()) as {
      agents: { id: string; name: string; description: string; skills: string[]; status: string; lastError?: string; invokePath: string }[];
    };
    return {
      source: "hub",
      agents: agents.map((a) => ({
        invokeUrl: `${hubUrl}${a.invokePath}`,
        headers,
        info: {
          id: slug(a.id),
          name: a.name,
          description: a.description,
          url: `${hubUrl}/agents/${a.id}`,
          skills: a.skills,
          available: a.status === "healthy",
          note: a.status === "healthy" ? undefined : a.lastError,
        },
      })),
    };
  } catch (err) {
    console.warn(`agent-hub（${hubUrl}）から一覧を取れませんでした: ${errorText(err)}`);
    return { source: "hub", agents: [] };
  }
}

/** URL から自己紹介を読んで、外部エージェントの情報を作る */
async function fromUrl(baseUrl: string): Promise<ExternalAgent> {
  const invokeUrl = `${baseUrl}/invocations`;
  try {
    const card = await fetchCard(baseUrl);
    const id = slug(card.id ?? card.name ?? new URL(baseUrl).host);
    return {
      invokeUrl,
      info: {
        id,
        name: card.name ?? id,
        description: card.description ?? "",
        url: baseUrl,
        skills: (card.skills ?? []).map((s) => s.name ?? "").filter(Boolean),
        available: true,
      },
    };
  } catch (err) {
    const id = slug(new URL(baseUrl).host);
    return {
      invokeUrl,
      info: { id, name: baseUrl, description: "", url: baseUrl, skills: [], available: false, note: errorText(err) },
    };
  }
}

/** まず GET /.well-known/agent-card.json、だめなら POST /invocations {"action":"describe"} で聞く */
async function fetchCard(baseUrl: string): Promise<AgentCard> {
  const signal = AbortSignal.timeout(3000);
  const res = await fetch(`${baseUrl}/.well-known/agent-card.json`, { signal }).catch(() => undefined);
  if (res?.ok) return (await res.json()) as AgentCard;

  const res2 = await fetch(`${baseUrl}/invocations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "describe" }),
    signal: AbortSignal.timeout(3000),
  });
  if (!res2.ok) throw new Error(`自己紹介を読めませんでした（HTTP ${res2.status}）`);
  return (await res2.json()) as AgentCard;
}

/** ツール名に使えるように、英数字・_・- だけにする */
export function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40) || "agent";
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.cause instanceof Error ? `${err.message}（${err.cause.message}）` : err.message;
  return String(err);
}
