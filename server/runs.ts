import type { CallPattern, ChatEvent, Topology } from "../shared/protocol.js";
import type { ModelClient } from "./llm/types.js";

/**
 * 1 回のチャットリクエスト（= 1 回の実行）の共有情報。
 *
 * MCP / A2A パターンでは、サブエージェントは「別のサーバー」の中で動く。
 * その途中経過をブラウザに届けるため、呼び出し時に runId をメタデータとして渡し、
 * 受け側はこのレジストリから emit（ブラウザへの送信口）を取り出す。
 *
 * 実際の分散システムでは、ここは OpenTelemetry などの分散トレーシングが担う部分。
 * このアプリはすべて 1 プロセスで動いているので、Map で代用している。
 */
export interface Run {
  runId: string;
  topology: Topology;
  pattern: CallPattern;
  client: ModelClient;
  emit: (event: ChatEvent) => void;
  signal: AbortSignal;
  /** MCP / A2A サーバーの URL を組み立てるための、このサーバー自身の URL */
  baseUrl: string;
}

/** runAgent に渡すコンテキスト = 実行全体の情報 + 呼び出し階層上の位置 */
export interface RunContext extends Run {
  depth: number;
  parentCallId: string | null;
}

/** プロトコルのメタデータに載せて相手に渡す、トレース用の情報 */
export interface TraceMeta {
  runId: string;
  parentCallId: string;
  depth: number;
}

/** MCP の `_meta` / A2A の `metadata` でトレース情報を運ぶときのキー */
export const TRACE_META_KEY = "try-chat-app/trace";

const runs = new Map<string, Run>();

export function registerRun(run: Run) {
  runs.set(run.runId, run);
  return () => runs.delete(run.runId);
}

/** 受け取ったメタデータから、呼び出し元の実行コンテキストを復元する */
export function contextFromMeta(meta: unknown): RunContext | undefined {
  const m = meta as Partial<TraceMeta> | undefined;
  const run = m?.runId ? runs.get(m.runId) : undefined;
  if (!run || typeof m?.parentCallId !== "string" || typeof m.depth !== "number") return undefined;
  return { ...run, parentCallId: m.parentCallId, depth: m.depth };
}
