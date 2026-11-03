// ハブの中心: 「どのエージェントが、どこにいて、何ができて、今動いているか」を覚えておく台帳。
//
// エージェントの登録のしかたは 2 種類あります。
//   { "url": "http://localhost:8080" }               … ふつうの HTTP のエージェント（ローカル、Foundry、Container Apps など）
//   { "agentCoreArn": "arn:aws:bedrock-agentcore:..." } … AgentCore Runtime のエージェント（ハブが IAM の署名を付けて呼ぶ）
//
// 登録すると、ハブはエージェントの自己紹介（Agent Card）を読み、定期的に生きているか確認します。

import { agentCoreInvokeUrl, sigv4Fetch } from "./sigv4.js";

export interface Registration {
  url?: string;
  agentCoreArn?: string;
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
  /** 呼び出し先（POST する URL） */
  invokeUrl: string;
  auth: "none" | "bearer" | "sigv4";
  card: AgentCard;
  status: "healthy" | "unhealthy";
  /** 最後に生きていることを確認した時刻 */
  lastSeen?: string;
  lastError?: string;
}

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
  const id = slug(card.id ?? card.name ?? reg.url ?? reg.agentCoreArn ?? "agent");
  const agent: HubAgent = { id, ...target, card, status: "healthy", lastSeen: new Date().toISOString() };
  agents.set(id, agent);
  return agent;
}

/** エージェントに POST する。ハブの外からは、相手の場所や認証方式の違いは見えない */
export function invoke(agent: Pick<HubAgent, "invokeUrl" | "auth" | "registration">, body: string, signal?: AbortSignal) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
  if (agent.auth === "sigv4") return sigv4Fetch(agent.invokeUrl, { method: "POST", headers, body, signal });
  if (agent.auth === "bearer") headers.authorization = `Bearer ${agent.registration.bearerToken}`;
  return fetch(agent.invokeUrl, { method: "POST", headers, body, signal });
}

/** 登録済みのエージェントが生きているかを確かめる（ハブが定期的に呼ぶ） */
export async function checkHealth(agent: HubAgent): Promise<void> {
  try {
    if (agent.auth === "sigv4") {
      // AgentCore は /ping を外から叩けないので、自己紹介を聞けるかで代わりに確かめる
      await fetchCard(agent);
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

function resolve(reg: Registration): Pick<HubAgent, "invokeUrl" | "auth" | "registration"> {
  if (reg.agentCoreArn) return { registration: reg, invokeUrl: agentCoreInvokeUrl(reg.agentCoreArn), auth: "sigv4" };
  if (!reg.url) throw new Error("url か agentCoreArn のどちらかが必要です");
  const base = reg.url.replace(/\/+$/, "");
  return { registration: { ...reg, url: base }, invokeUrl: `${base}/invocations`, auth: reg.bearerToken ? "bearer" : "none" };
}

/** 自己紹介を聞く。どの場所でも届く POST /invocations {"action":"describe"} を使う */
async function fetchCard(target: Pick<HubAgent, "invokeUrl" | "auth" | "registration">): Promise<AgentCard> {
  const res = await invoke(target, JSON.stringify({ action: "describe" }), AbortSignal.timeout(5000));
  if (!res.ok) throw new Error(`自己紹介を読めませんでした（HTTP ${res.status}）`);
  return (await res.json()) as AgentCard;
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40) || "agent";
}
