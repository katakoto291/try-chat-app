import Anthropic from "@anthropic-ai/sdk";
import type { ModelCall, ModelClient } from "./types.js";

/**
 * 本物の Claude API を呼ぶクライアント。
 * ストリーミングで呼び出し、テキストの断片を onText に流しつつ、
 * 最後に finalMessage() で完成したメッセージ（tool_use を含む）を返す。
 */
export class AnthropicModelClient implements ModelClient {
  readonly mode = "anthropic";
  private client = new Anthropic();

  async call({ model, system, messages, tools, effort, onText, signal }: ModelCall) {
    const stream = this.client.beta.messages.stream(
      {
        model,
        max_tokens: 64000,
        system,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        output_config: effort ? { effort } : undefined,
        // 安全分類器に断られた場合、サーバー側で自動的に別モデルへフォールバックする
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal },
    );
    stream.on("text", onText);
    return stream.finalMessage();
  }
}
