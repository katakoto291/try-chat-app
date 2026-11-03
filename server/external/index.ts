/**
 * 外部エージェントを、司令塔の「ツール」として見せる。
 *
 * 外部エージェント 1 つにつき、call_ext_<id> というツールを 1 つ作ります。
 * ツールの説明には、相手の自己紹介（Agent Card）の説明とできること（skills）を入れるので、
 * Claude はそれを読んで「この依頼はこのエージェントに頼もう」と判断できます。
 */

import { TASK_INPUT_SCHEMA } from "../patterns/types.js";
import type { BetaTool } from "../llm/types.js";
import type { RunContext } from "../runs.js";
import { callExternalAgent } from "./invoke.js";
import { listExternalAgents, type ExternalAgent } from "./registry.js";

export { listExternalAgents };

const PREFIX = "call_ext_";

export interface ExternalToolbox {
  tools: BetaTool[];
  has(toolName: string): boolean;
  call(toolName: string, task: string): Promise<{ text: string; isError: boolean }>;
}

export async function externalToolbox(ctx: RunContext, callerCallId: string): Promise<ExternalToolbox> {
  const { agents } = await listExternalAgents();
  const byTool = new Map<string, ExternalAgent>();
  for (const agent of agents) if (agent.info.available) byTool.set(`${PREFIX}${agent.info.id}`, agent);

  return {
    tools: [...byTool].map(([name, { info }]) => ({
      name,
      description: [
        `外部エージェント「${info.name}」に仕事を依頼する（別のサーバーで動いている）。${info.description}`,
        info.skills.length > 0 ? `できること: ${info.skills.join("、")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      input_schema: TASK_INPUT_SCHEMA,
      eager_input_streaming: true,
    })),
    has: (name) => byTool.has(name),
    call: (name, task) => callExternalAgent(byTool.get(name)!, task, ctx, callerCallId),
  };
}
