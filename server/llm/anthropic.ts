import Anthropic from "@anthropic-ai/sdk";
import type { ModelCall, ModelClient } from "./types.js";

/**
 * モデルごとに使えるパラメータが違うので、送る前に確認する。
 * - effort（思考の深さ）: Haiku 4.5 では使えない（送ると 400 エラー）
 * - fallbacks（断られたときの自動切り替え）: 安全分類器がある Opus 5 / Fable だけが対象
 */
function capabilities(model: string) {
  return {
    effort: !model.includes("haiku"),
    fallbacks: /^claude-(opus-5|fable-5)/.test(model),
  };
}

/**
 * 本物の Claude API を呼ぶクライアント。
 * ストリーミングで呼び出し、テキストの断片を onText に流しつつ、
 * 最後に finalMessage() で完成したメッセージ（tool_use を含む）を返す。
 */
export class AnthropicModelClient implements ModelClient {
  readonly mode = "anthropic";
  private client = new Anthropic();

  async call({ model, system, messages, tools, effort, onText, signal }: ModelCall) {
    const can = capabilities(model);
    const stream = this.client.beta.messages.stream(
      {
        model,
        max_tokens: 64000,
        system,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        output_config: effort && can.effort ? { effort } : undefined,
        // 安全分類器に断られた場合、サーバー側で自動的に別モデルへフォールバックする
        ...(can.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal },
    );
    stream.on("text", onText);
    return stream.finalMessage();
  }
}
