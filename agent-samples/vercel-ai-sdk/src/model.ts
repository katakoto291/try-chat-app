// 「どこの Claude を使うか」を切り替える部分。
// エージェントのコード（agent.ts）は、ここで作った model を受け取るだけなので、
// MODEL_PROVIDER を変えても他のファイルは一切変わりません。
//
//   MODEL_PROVIDER=anthropic … Anthropic の API を直接（ANTHROPIC_API_KEY）
//   MODEL_PROVIDER=bedrock   … Amazon Bedrock の Claude（AWS の認証情報）
//   MODEL_PROVIDER=foundry   … Microsoft Foundry の Claude（API キー or Entra ID）

import { createAnthropic } from "@ai-sdk/anthropic";
import { createAmazonBedrockAnthropic } from "@ai-sdk/amazon-bedrock/anthropic";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { DefaultAzureCredential } from "@azure/identity";
import type { LanguageModel } from "ai";

export type Provider = "anthropic" | "bedrock" | "foundry";

export function resolveProvider(): Provider {
  const p = (process.env.MODEL_PROVIDER ?? "anthropic").toLowerCase();
  if (p === "anthropic" || p === "bedrock" || p === "foundry") return p;
  throw new Error(`MODEL_PROVIDER は anthropic / bedrock / foundry のどれかにしてください（今: ${p}）`);
}

export function createModel(provider: Provider = resolveProvider()): { model: LanguageModel; modelId: string } {
  switch (provider) {
    case "anthropic": {
      const modelId = process.env.MODEL_ID ?? "claude-opus-5-5";
      return { model: createAnthropic()(modelId), modelId };
    }

    case "bedrock": {
      // Bedrock のモデル ID は「anthropic.」が付き、多くの場合は推論プロファイル（us. / eu. / global. など）を付けて呼びます
      const modelId = process.env.MODEL_ID ?? "us.anthropic.claude-opus-5-5";
      const bedrock = createAmazonBedrockAnthropic({
        region: process.env.AWS_REGION ?? "us-east-1",
        // AWS SDK と同じ順番で認証情報を探す（環境変数 → ~/.aws → コンテナ/実行ロール）。
        // AgentCore Runtime 上では「実行ロール」の一時的な認証情報がここで自動的に使われます。
        credentialProvider: fromNodeProviderChain(),
      });
      return { model: bedrock(modelId), modelId };
    }

    case "foundry": {
      // Foundry では「デプロイ名」をモデル ID として指定します（例: デプロイ名を claude-opus-5-5 にしておく）
      const modelId = process.env.MODEL_ID ?? "claude-opus-5-5";
      // Foundry hosted agents の中では FOUNDRY_PROJECT_ENDPOINT が自動で入るので、そこからリソース名を取り出せます
      const resource =
        process.env.ANTHROPIC_FOUNDRY_RESOURCE ??
        (process.env.FOUNDRY_PROJECT_ENDPOINT && new URL(process.env.FOUNDRY_PROJECT_ENDPOINT).hostname.split(".")[0]);
      const baseURL =
        process.env.ANTHROPIC_FOUNDRY_BASE_URL?.replace(/\/$/, "") ??
        (resource ? `https://${resource}.services.ai.azure.com/anthropic` : undefined);
      if (!baseURL) throw new Error("ANTHROPIC_FOUNDRY_RESOURCE（リソース名）を設定してください");

      const apiKey = process.env.ANTHROPIC_FOUNDRY_API_KEY;
      const anthropic = apiKey
        ? // API キー方式: x-api-key ヘッダーで送る（Anthropic の API と同じ形）
          createAnthropic({ baseURL: `${baseURL}/v1`, apiKey })
        : // Entra ID 方式: az login やマネージド ID のトークンを Bearer で送る（キーを置かなくてよい）
          createAnthropic({ baseURL: `${baseURL}/v1`, authToken: foundryTokenProvider() });
      return { model: anthropic(modelId), modelId };
    }
  }
}

function foundryTokenProvider() {
  const credential = new DefaultAzureCredential();
  return async () => {
    const token = await credential.getToken("https://ai.azure.com/.default");
    if (!token) throw new Error("Entra ID のトークンを取得できませんでした（az login 済みか確認してください）");
    return token.token;
  };
}
