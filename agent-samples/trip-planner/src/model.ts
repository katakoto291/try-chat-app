// 「どこの Claude を使うか」を切り替える部分。
// Strands では、モデルは BedrockModel / AnthropicModel などの「モデルクラス」を差し替えるだけです。
//
//   MODEL_PROVIDER=anthropic … Anthropic の API を直接（ANTHROPIC_API_KEY）
//   MODEL_PROVIDER=bedrock   … Amazon Bedrock の Claude（AWS の認証情報）
//   MODEL_PROVIDER=foundry   … Microsoft Foundry の Claude（API キー or Entra ID）

import Anthropic from "@anthropic-ai/sdk";
import { DefaultAzureCredential } from "@azure/identity";
import type { Model } from "@strands-agents/sdk";
import { AnthropicModel } from "@strands-agents/sdk/models/anthropic";
import { BedrockModel } from "@strands-agents/sdk/models/bedrock";

export type Provider = "anthropic" | "bedrock" | "foundry";

const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "claude-opus-5-5",
  bedrock: "us.anthropic.claude-opus-5-5", // 推論プロファイル ID（リージョンに合わせて us./eu./apac./global.）
  foundry: "claude-opus-5-5", // Foundry の「デプロイ名」
};
const MAX_TOKENS = 16000;

export function resolveProvider(): Provider {
  const p = (process.env.MODEL_PROVIDER ?? "anthropic").toLowerCase();
  if (p === "anthropic" || p === "bedrock" || p === "foundry") return p;
  throw new Error(`MODEL_PROVIDER は anthropic / bedrock / foundry のどれかにしてください（今: ${p}）`);
}

export function createModel(provider: Provider = resolveProvider()): { model: Model; modelId: string } {
  const modelId = process.env.MODEL_ID || DEFAULT_MODEL[provider];

  switch (provider) {
    case "anthropic":
      // ANTHROPIC_API_KEY を自動で読む
      return { model: new AnthropicModel({ modelId, maxTokens: MAX_TOKENS }), modelId };

    case "bedrock":
      // 中で AWS SDK を使うので、認証情報は AWS SDK と同じ順番で自動的に探されます
      // （環境変数 → ~/.aws → 実行ロール）。AgentCore Runtime 上では「実行ロール」の権限で Bedrock を呼びます。
      return {
        model: new BedrockModel({ modelId, region: process.env.AWS_REGION ?? "us-east-1", maxTokens: MAX_TOKENS }),
        modelId,
      };

    case "foundry":
      // Foundry の Claude は Anthropic の API と同じ形なので、AnthropicModel に「つなぎ先を変えたクライアント」を渡します
      return { model: new AnthropicModel({ modelId, maxTokens: MAX_TOKENS, client: foundryClient() }), modelId };
  }
}

function foundryClient(): Anthropic {
  // Foundry hosted agents の中では FOUNDRY_PROJECT_ENDPOINT が自動で入るので、そこからリソース名を取り出せます
  const resource =
    process.env.ANTHROPIC_FOUNDRY_RESOURCE ??
    (process.env.FOUNDRY_PROJECT_ENDPOINT && new URL(process.env.FOUNDRY_PROJECT_ENDPOINT).hostname.split(".")[0]);
  const baseURL =
    process.env.ANTHROPIC_FOUNDRY_BASE_URL?.replace(/\/$/, "") ??
    (resource ? `https://${resource}.services.ai.azure.com/anthropic` : undefined);
  if (!baseURL) throw new Error("ANTHROPIC_FOUNDRY_RESOURCE（リソース名）を設定してください");

  // API キー方式: x-api-key ヘッダーで送る（Anthropic の API と同じ形）
  const apiKey = process.env.ANTHROPIC_FOUNDRY_API_KEY;
  if (apiKey) return new Anthropic({ baseURL, apiKey });

  // Entra ID 方式: az login やマネージド ID のトークンを、リクエストのたびに Bearer で付ける（キーを置かなくてよい）
  const credential = new DefaultAzureCredential();
  return new Anthropic({
    baseURL,
    apiKey: null,
    authToken: "entra-id", // 仮の値。実際のトークンは下の fetch で差し替える
    fetch: async (url, init) => {
      const token = await credential.getToken("https://ai.azure.com/.default");
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token.token}`);
      return fetch(url, { ...init, headers });
    },
  });
}
