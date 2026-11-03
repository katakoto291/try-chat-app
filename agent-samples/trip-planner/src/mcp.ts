// MCP サーバーへのつなぎ方。
//
// エージェントから見ると、MCP サーバーは「ツールの入った箱」です。
// URL を教えるだけで、SDK が tools/list でツールの一覧（名前・説明・入力の形）を取ってきて、
// Claude に渡してくれます。Claude がツールを使いたいと言ったら、SDK が tools/call で MCP サーバーに頼みます。
//
// つなぎ先の認証は、MCP サーバーの置き場所によって変わります。
//   MCP_AUTH=none   … ローカルや社内ネットワークなど、認証なしで呼べるところ（既定）
//   MCP_AUTH=bearer … OAuth などで取ったトークンを Authorization: Bearer で送る（MCP_BEARER_TOKEN）
//   MCP_AUTH=sigv4  … AgentCore Runtime に置いた MCP サーバーを、AWS の認証情報（IAM）で呼ぶ

import { Sha256 } from "@aws-crypto/sha256-js";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SignatureV4 } from "@smithy/signature-v4";
import { McpClient } from "@strands-agents/sdk";

export const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "http://localhost:8000/mcp";
const MCP_AUTH = (process.env.MCP_AUTH ?? "none").toLowerCase();

/** リクエストごとに新しい MCP クライアントを作る（使い終わったら disconnect する） */
export function createMcpClient(): McpClient {
  const url = new URL(MCP_SERVER_URL);

  if (MCP_AUTH === "sigv4") {
    // 署名付きの fetch を持たせたトランスポートを自分で作って渡す
    return new McpClient({ transport: new StreamableHTTPClientTransport(url, { fetch: sigv4Fetch(url) }) });
  }
  if (MCP_AUTH === "bearer") {
    return new McpClient({ url, headers: { Authorization: `Bearer ${process.env.MCP_BEARER_TOKEN ?? ""}` } });
  }
  return new McpClient({ url });
}

/**
 * AWS の署名（SigV4）を付けてから送る fetch。
 * AgentCore Runtime の MCP サーバーは、既定では IAM の認証が必要なので、
 * 送る前にリクエスト全体（メソッド・URL・ヘッダー・本文）に署名を付けます。
 */
function sigv4Fetch(url: URL): typeof fetch {
  // 例: bedrock-agentcore.us-east-1.amazonaws.com → us-east-1
  const region = process.env.AWS_REGION ?? url.hostname.split(".")[1] ?? "us-east-1";
  const signer = new SignatureV4({
    service: "bedrock-agentcore",
    region,
    credentials: fromNodeProviderChain(), // 環境変数 → ~/.aws → 実行ロール の順に探す
    sha256: Sha256,
  });

  return async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input.toString());
    const headers: Record<string, string> = { host: target.host };
    new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
    const body = typeof init?.body === "string" ? init.body : undefined;

    const signed = await signer.sign({
      method: init?.method ?? "GET",
      protocol: target.protocol,
      hostname: target.hostname,
      path: target.pathname,
      query: Object.fromEntries(target.searchParams),
      headers,
      body,
    });
    const { host: _host, ...sendHeaders } = signed.headers; // host は fetch が自分で付ける
    return fetch(target, { ...init, headers: sendHeaders });
  };
}
