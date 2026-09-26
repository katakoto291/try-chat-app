import { runAgent } from "../agents/runAgent.js";
import type { BetaMessageParam } from "../llm/types.js";
import type { RunContext } from "../runs.js";
import { runHandoff } from "./handoff.js";
import { runPubSub } from "./pubsub.js";

/** 連携パターンに応じて、1 回のチャットを実行し最終回答を返す */
export async function executeChat(messages: BetaMessageParam[], ctx: RunContext): Promise<string> {
  switch (ctx.topology) {
    case "call":
      return (await runAgent("orchestrator", messages, ctx)).text;
    case "handoff":
      return runHandoff(messages, ctx);
    case "pubsub":
      return runPubSub(messages, ctx);
  }
}
