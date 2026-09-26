import type { AgentDefinition } from "../agents/definitions.js";
import type { RunContext } from "../runs.js";
import { connectA2a } from "./a2a.js";
import { connectDirect } from "./direct.js";
import { connectMcp } from "./mcp.js";
import type { PeerConnection } from "./types.js";

export type { PeerConnection };

/** 呼び出しパターンに応じて、呼び出せる相手への接続を作る */
export function connectPeers(caller: AgentDefinition, callerCallId: string, ctx: RunContext): Promise<PeerConnection> {
  switch (ctx.pattern) {
    case "direct":
      return connectDirect(caller, callerCallId, ctx);
    case "mcp":
      return connectMcp(caller, callerCallId, ctx);
    case "a2a":
      return connectA2a(caller, callerCallId, ctx);
  }
}
