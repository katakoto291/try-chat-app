// ハブの中心: 「どのエージェントが、どこにいて、何ができて、今動いているか」を覚えておく台帳。
//
// エージェントの登録のしかたは 4 種類あります（呼び方 2 つ × 置き場所 2 つ）。
//
//                       /invocations 方式                       A2A 方式
//   ふつうの HTTP        { "url": "http://localhost:8080" }      { "a2aUrl": "http://localhost:8080/" }
//   AgentCore Runtime   { "agentCoreArn": "arn:..." }           { "agentCoreArn": "arn:...", "protocol": "a2a" }
//
// AgentCore のエージェントは、ハブが IAM の署名を付けて呼びます。
// 登録すると、ハブはエージェントの自己紹介（Agent Card）を読み、定期的に生きているか確認します。
// 呼ぶ側には、どの方式でも同じ形（POST /agents/:id/invocations の SSE）で見せます。

import type { AgentCard as A2aAgentCard } from "@a2a-js/sdk";
import { callA2a, fetchA2aCard } from "./a2a.js";
import { agentCoreA2aUrl, agentCoreInvokeUrl, sigv4Fetch } from "./sigv4.js";

export interface Registration {
  /** /invocations 方式のエージェントのベース URL */
  url?: string;
  /** A2A 方式のエージェントの URL（Agent Card に書かれた JSON-RPC の URL） */
  a2aUrl?: string;
  /** AgentCore Runtime のランタイム ARN */
  agentCoreArn?: string;
  /** agentCoreArn のときの呼び方（既定は invocations） */
  protocol?: "invocations" | "a2a";
  /** 相手が Bearer トークンを求める場合（Azure Container Apps に置いたエージェントなど） */
  bearerToken?: string;
}

export interface AgentCard {
  id?: string;
  name?: string;
  description?: string;
  skills?: { id?: string; name?: string; description?: string; examples?: string[] }[];
  [key: string]: unknown;
}

export interface HubAgent {
  id: string;
  registration: Registration;
  protocol: "invocations" | "a2a";
  /** 呼び出し先（/invocations 方式なら POST する URL、A2A なら JSON-RPC の URL） */
  endpoint: string;
  auth: "none" | "bearer" | "sigv4";
  card: AgentCard;
  status: "healthy" | "unhealthy";
  /** 最後に生きていることを確認した時刻 */
  lastSeen?: string;
  lastError?: string;
}

type Target = Pick<HubAgent, "registration" | "protocol" | "endpoint" | "auth">;

const agents = new Map<string, HubAgent>();

export function listAgents(): HubAgent[] {
  return [...agents.values()];
}

export function getAgent(id: string): HubAgent | undefined {
  return agents.get(id);
}

export function removeAgent(id: string): boolean {
  return agents.delete(id);
}

/** エージェントを登録する（自己紹介を読めなければエラー） */
export async function register(reg: Registration): Promise<HubAgent> {
  const target = resolve(reg);
  const card = await fetchCard(target);
  const id = slug(card.id ?? card.name ?? reg.url ?? reg.a2aUrl ?? reg.agentCoreArn ?? "agent");
  const agent: HubAgent = { id, ...target, card, status: "healthy", lastSeen: new Date().toISOString() };
  agents.set(id, agent);
  return agent;
}

/**
 * エージェントを呼ぶ。body は {"prompt": "...", "stream": true|false}。
 * どの方式のエージェントでも、/invocations 方式と同じ形の Response を返す
 * （stream: true なら SSE、false なら {"result": "..."} の JSON）。
 */
export async function invoke(agent: Target, body: string, signal?: AbortSignal): Promise<Response> {
  if (agent.protocol === "invocations") {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
    if (agent.auth === "bearer") headers.authorization = `Bearer ${agent.registration.bearerToken}`;
    return fetchFor(agent)(agent.endpoint, { method: "POST", headers, body, signal });
  }

  // A2A 方式: 受け取った依頼を A2A のメッセージにして送り、返ってきたイベントを共通の形に直す
  const req = JSON.parse(body || "{}") as { prompt?: string; stream?: boolean; action?: string };
  const card = getAgentByTarget(agent)?.card ?? (await fetchCard(agent));
  if (req.action === "describe") return Response.json(card);
  if (!req.prompt) return Response.json({ error: 'リクエストは {"prompt": "..."} の形で送ってください' }, { status: 400 });

  const events = callA2a(card as unknown as A2aAgentCard, agent.endpoint, req.prompt, fetchFor(agent), signal);
  if (!req.stream) {
    let result = "";
    let error: string | undefined;
    for await (const ev of events) {
      if (ev.type === "result") result = String(ev.result ?? "");
      if (ev.type === "error") error = String(ev.error ?? "");
    }
    return error ? Response.json({ error }, { status: 502 }) : Response.json({ result });
  }
  const encoder = new TextEncoder();
  const sse = new ReadableStream({
    async start(controller) {
      try {
        for await (const ev of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      } catch (err) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: String(err) })}\n\n`));
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done", protocol: "a2a" })}\n\n`));
      controller.close();
    },
  });
  return new Response(sse, { headers: { "content-type": "text/event-stream" } });
}

/** 登録済みのエージェントが生きているかを確かめる（ハブが定期的に呼ぶ） */
export async function checkHealth(agent: HubAgent): Promise<void> {
  try {
    if (agent.protocol === "a2a" || agent.auth === "sigv4") {
      // A2A の相手や AgentCore の相手は /ping があるとは限らない（外から叩けない）ので、自己紹介を聞けるかで確かめる
      agent.card = await fetchCard(agent);
    } else {
      const base = agent.registration.url!.replace(/\/+$/, "");
      const res = await fetch(`${base}/ping`, { signal: AbortSignal.timeout(3000) }).catch(() => undefined);
      const ok = res?.ok || (await fetch(`${base}/readiness`, { signal: AbortSignal.timeout(3000) })).ok;
      if (!ok) throw new Error("ヘルスチェックに失敗");
    }
    agent.status = "healthy";
    agent.lastSeen = new Date().toISOString();
    agent.lastError = undefined;
  } catch (err) {
    agent.status = "unhealthy";
    agent.lastError = err instanceof Error ? err.message : String(err);
  }
}

function resolve(reg: Registration): Target {
  if (reg.agentCoreArn) {
    return reg.protocol === "a2a"
      ? { registration: reg, protocol: "a2a", endpoint: agentCoreA2aUrl(reg.agentCoreArn), auth: "sigv4" }
      : { registration: reg, protocol: "invocations", endpoint: agentCoreInvokeUrl(reg.agentCoreArn), auth: "sigv4" };
  }
  const auth = reg.bearerToken ? "bearer" : "none";
  if (reg.a2aUrl) {
    const url = reg.a2aUrl.endsWith("/") ? reg.a2aUrl : `${reg.a2aUrl}/`;
    return { registration: { ...reg, a2aUrl: url }, protocol: "a2a", endpoint: url, auth };
  }
  if (!reg.url) throw new Error("url・a2aUrl・agentCoreArn のどれかが必要です");
  const base = reg.url.replace(/\/+$/, "");
  return { registration: { ...reg, url: base }, protocol: "invocations", endpoint: `${base}/invocations`, auth };
}

/** 相手に合わせた fetch（AgentCore なら署名付き、Bearer ならトークン付き） */
function fetchFor(target: Target): typeof fetch {
  if (target.auth === "sigv4") return sigv4Fetch;
  if (target.auth === "bearer") {
    return (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${target.registration.bearerToken}`);
      return fetch(input, { ...init, headers });
    };
  }
  return fetch;
}

/**
 * 自己紹介を聞く。
 * - A2A 方式: 標準の場所（<URL>/.well-known/agent-card.json。AgentCore では GetAgentCard API）
 * - /invocations 方式: どの場所でも届く POST /invocations {"action":"describe"}
 */
async function fetchCard(target: Target): Promise<AgentCard> {
  if (target.protocol === "a2a") return (await fetchA2aCard(target.endpoint, fetchFor(target))) as unknown as AgentCard;
  const res = await invoke(target, JSON.stringify({ action: "describe" }), AbortSignal.timeout(5000));
  if (!res.ok) throw new Error(`自己紹介を読めませんでした（HTTP ${res.status}）`);
  return (await res.json()) as AgentCard;
}

function getAgentByTarget(target: Target): HubAgent | undefined {
  return listAgents().find((a) => a.endpoint === target.endpoint);
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40) || "agent";
}
