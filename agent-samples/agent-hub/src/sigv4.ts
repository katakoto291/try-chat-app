// AWS の署名（SigV4）を付けてから送る fetch。
// AgentCore Runtime に置いたエージェントは、既定では IAM の認証が必要なので、
// ハブが「呼ぶ側の代わりに」署名を付けて転送します（trip-planner/src/mcp.ts と同じ仕組み）。
// fetch と同じ形にしてあるので、A2A の SDK にもそのまま渡せます。

import { Sha256 } from "@aws-crypto/sha256-js";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";

const signers = new Map<string, SignatureV4>();

function signerFor(region: string): SignatureV4 {
  let signer = signers.get(region);
  if (!signer) {
    signer = new SignatureV4({ service: "bedrock-agentcore", region, credentials: fromNodeProviderChain(), sha256: Sha256 });
    signers.set(region, signer);
  }
  return signer;
}

export const sigv4Fetch: typeof fetch = async (input, init) => {
  const target = new URL(input instanceof Request ? input.url : input.toString());
  const region = target.hostname.split(".")[1] ?? "us-east-1"; // bedrock-agentcore.<region>.amazonaws.com
  const headers: Record<string, string> = { host: target.host };
  new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
  const body = typeof init?.body === "string" ? init.body : undefined;

  const signed = await signerFor(region).sign({
    method: init?.method ?? "GET",
    protocol: target.protocol,
    hostname: target.hostname,
    path: target.pathname,
    query: Object.fromEntries(target.searchParams),
    headers,
    body,
  });
  const { host: _host, ...sendHeaders } = signed.headers;
  return fetch(target, { ...init, headers: sendHeaders });
};

/** AgentCore のランタイムの URL（この後ろに /invocations などが付く） */
function runtimeBase(arn: string): string {
  const region = arn.split(":")[3];
  return `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(arn)}`;
}

/** HTTP 方式（/invocations）で載せたエージェントを呼ぶ URL */
export const agentCoreInvokeUrl = (arn: string) => `${runtimeBase(arn)}/invocations?qualifier=DEFAULT`;

/**
 * A2A 方式で載せたエージェントの URL。
 * この URL に JSON-RPC を POST し、Agent Card は この URL + .well-known/agent-card.json（AWS の GetAgentCard API）で取る
 */
export const agentCoreA2aUrl = (arn: string) => `${runtimeBase(arn)}/invocations/`;
