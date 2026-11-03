// AWS の署名（SigV4）を付けてから送る fetch。
// AgentCore Runtime に置いたエージェントは、既定では IAM の認証が必要なので、
// ハブが「呼ぶ側の代わりに」署名を付けて転送します（trip-planner/src/mcp.ts と同じ仕組み）。

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

export async function sigv4Fetch(url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) {
  const target = new URL(url);
  const region = target.hostname.split(".")[1] ?? "us-east-1"; // bedrock-agentcore.<region>.amazonaws.com
  const signed = await signerFor(region).sign({
    method: init.method,
    protocol: target.protocol,
    hostname: target.hostname,
    path: target.pathname,
    query: Object.fromEntries(target.searchParams),
    headers: { ...init.headers, host: target.host },
    body: init.body,
  });
  const { host: _host, ...headers } = signed.headers;
  return fetch(target, { method: init.method, headers, body: init.body, signal: init.signal });
}

/** AgentCore のランタイム ARN から、呼び出し用の URL を作る */
export function agentCoreInvokeUrl(arn: string): string {
  const region = arn.split(":")[3];
  return `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(arn)}/invocations?qualifier=DEFAULT`;
}
