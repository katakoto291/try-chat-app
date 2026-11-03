/**
 * 外部エージェントを呼ぶ。
 *
 * やっていることは HTTP の POST 1 回だけです。
 *   POST <url>/invocations  {"prompt": "<依頼内容>", "stream": true}
 * 返ってくる SSE（途中経過）を 1 件ずつ読み、このアプリのトレース用イベントに変換して画面に流します。
 *
 *   data: {"type":"tool_call","name":"get_weather","input":{...}}  → tool_call
 *   data: {"type":"text","text":"東京は"}                          → text
 *   data: {"type":"result","result":"..."}                         → 最終回答
 *
 * 外部エージェントの中で何が起きているか（どのモデルで何回考えたか）は見えません。
 * 見えるのは、相手が SSE で教えてくれた範囲だけです。これが「別のサーバーのエージェント」を呼ぶということです。
 */

import { randomUUID } from "node:crypto";
import type { WireMessage } from "../../shared/protocol.js";
import type { RunContext } from "../runs.js";
import { errorText, type ExternalAgent } from "./registry.js";

/** 1 回の外部呼び出しにかける時間の上限 */
const TIMEOUT_MS = 5 * 60_000;
const MAX_LOG_BODY = 4000;

interface SampleEvent {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  result?: string;
  error?: string;
}

export async function callExternalAgent(
  agent: ExternalAgent,
  task: string,
  ctx: RunContext,
  callerCallId: string,
): Promise<{ text: string; isError: boolean }> {
  const callId = randomUUID();
  const log = (m: Omit<WireMessage, "protocol">) => ctx.emit({ type: "wire", callId: callerCallId, protocol: "external", ...m });

  ctx.emit({
    type: "agent_start",
    callId,
    parentCallId: callerCallId,
    agent: "external",
    label: agent.info.name,
    model: `外部（${new URL(agent.info.url).host}）`,
    task,
    depth: ctx.depth + 1,
    via: "external",
  });
  ctx.emit({ type: "turn_start", callId, turn: 0 });

  const body = JSON.stringify({ prompt: task, stream: true });
  log({ direction: "request", label: `POST /invocations（${agent.info.name}）`, url: `POST ${agent.invokeUrl}`, body: pretty(body) });

  let text = "";
  let result: string | undefined;
  let isError = false;
  // ツールの結果を、呼び出しと対応づけるため（名前 → 最後の toolUseId）
  const lastToolUse = new Map<string, string>();

  try {
    const res = await fetch(agent.invokeUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...agent.headers },
      body,
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());

    for await (const data of sseData(res.body)) {
      log({ direction: "event", label: eventLabel(data), url: `SSE ${agent.invokeUrl}`, body: pretty(data) });
      const ev = parse(data);
      if (!ev) continue;

      if (ev.type === "text" && ev.text) {
        text += ev.text;
        ctx.emit({ type: "text", callId, turn: 0, delta: ev.text });
      } else if (ev.type === "tool_call" && ev.name) {
        const toolUseId = `ext_${randomUUID()}`;
        lastToolUse.set(ev.name, toolUseId);
        ctx.emit({ type: "tool_call", callId, toolUseId, name: ev.name, input: ev.input ?? {} });
      } else if (ev.type === "tool_result" && ev.name && lastToolUse.has(ev.name)) {
        const content = typeof ev.output === "string" ? ev.output : JSON.stringify(ev.output);
        ctx.emit({ type: "tool_result", callId, toolUseId: lastToolUse.get(ev.name)!, content, isError: false });
      } else if (ev.type === "result" && typeof ev.result === "string") {
        result = ev.result;
      } else if (ev.type === "error") {
        isError = true;
        result = `外部エージェントでエラー: ${ev.error ?? "不明なエラー"}`;
      }
    }
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    isError = true;
    result = `外部エージェント「${agent.info.name}」を呼べませんでした: ${errorText(err)}`;
  }

  const output = result ?? text;
  ctx.emit({ type: "agent_end", callId, output, isError, usage: { input_tokens: 0, output_tokens: 0 } });
  return { text: output || "（空の応答）", isError };
}

/** SSE の本文から `data:` の中身を 1 件ずつ取り出す */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
      const data = chunk
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield data;
    }
  }
}

function parse(data: string): SampleEvent | undefined {
  try {
    return JSON.parse(data) as SampleEvent;
  } catch {
    return undefined;
  }
}

function eventLabel(data: string): string {
  const ev = parse(data);
  if (!ev) return "SSE";
  if (ev.type === "tool_call") return `tool_call（${ev.name}）`;
  if (ev.type === "text") return "text";
  return ev.type;
}

function pretty(s: string): string {
  let out = s;
  try {
    out = JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    // JSON でなければそのまま
  }
  return out.length > MAX_LOG_BODY ? `${out.slice(0, MAX_LOG_BODY)}\n…（省略）` : out;
}
