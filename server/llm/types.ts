import type Anthropic from "@anthropic-ai/sdk";

export type BetaMessage = Anthropic.Beta.BetaMessage;
export type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
export type BetaTool = Anthropic.Beta.BetaTool;

/** モデルを 1 回呼び出すときの引数 */
export interface ModelCall {
  model: string;
  system: string;
  messages: BetaMessageParam[];
  tools: BetaTool[];
  effort?: "low" | "medium" | "high";
  /** 生成されたテキストの断片が届くたびに呼ばれる */
  onText: (delta: string) => void;
  signal: AbortSignal;
}

/**
 * LLM 呼び出しの抽象。本物の Claude API（anthropic.ts）と、
 * API キーなしで動作を確認できるモック（mock.ts）の 2 実装がある。
 */
export interface ModelClient {
  readonly mode: "anthropic" | "mock";
  call(params: ModelCall): Promise<BetaMessage>;
}
