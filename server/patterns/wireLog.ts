import type { CallPattern, WireMessage } from "../../shared/protocol.js";
import type { RunContext } from "../runs.js";

const MAX_BODY = 6000;

/**
 * 通信内容をすべて記録する fetch。
 * MCP / A2A の SDK にこれを渡すと、SDK が実際に送受信した JSON がそのまま
 * トレースの「通信ログ」に表示される。
 */
export function loggingFetch(ctx: RunContext, callId: string, protocol: CallPattern): typeof fetch {
  const log = (m: Omit<WireMessage, "protocol">) => ctx.emit({ type: "wire", callId, protocol, ...m });

  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const reqBody = typeof init?.body === "string" ? init.body : "";

    log({
      direction: "request",
      label:
        rpcMethod(reqBody) ??
        (protocol === "mcp" && method === "GET"
          ? "GET（サーバーからの通知を受け取る SSE 接続を開く）"
          : url.pathname.endsWith("agent-card.json")
            ? `GET Agent Card（${url.pathname.split("/")[2]}）`
            : `${method} ${url.pathname}`),
      url: `${method} ${url.pathname}`,
      body: pretty(reqBody),
    });

    const res = await fetch(input, init);
    const status = `${res.status} ${res.statusText}`.trim();
    const contentType = res.headers.get("content-type") ?? "";

    // ストリーミング応答（SSE）は分岐させて、届いたイベントを 1 件ずつ記録する
    if (contentType.includes("text/event-stream") && res.body) {
      const [forSdk, forLog] = res.body.tee();
      void logSse(forLog, (data) =>
        log({ direction: "event", label: eventLabel(data), url: `SSE ${url.pathname}`, body: pretty(data) }),
      );
      log({ direction: "response", label: `${status} (SSE ストリーム開始)`, url: url.pathname, body: "" });
      return new Response(forSdk, { status: res.status, statusText: res.statusText, headers: res.headers });
    }

    const text = await res.clone().text();
    const kind = url.pathname.endsWith("agent-card.json") && res.ok ? " Agent Card" : responseKind(text);
    log({ direction: "response", label: `${status}${kind}`, url: url.pathname, body: pretty(text) });
    return res;
  };
}

async function logSse(stream: ReadableStream<Uint8Array>, onData: (data: string) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const data = buffer
          .slice(0, sep)
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        buffer = buffer.slice(sep + 2);
        if (data) onData(data);
      }
    }
  } catch {
    // 中断されたストリームは記録しない
  }
}

function rpcMethod(body: string): string | undefined {
  try {
    const json = JSON.parse(body);
    if (typeof json.method !== "string") return undefined;
    const tool = json.params?.name;
    return tool ? `${json.method} (${tool})` : json.method;
  } catch {
    return undefined;
  }
}

function responseKind(body: string): string {
  try {
    const json = JSON.parse(body);
    if (json.error) return " error";
    if (json.result) return " result";
  } catch {
    // JSON 以外
  }
  return "";
}

/** A2A のストリームイベントに「何のイベントか」の名前を付ける */
function eventLabel(data: string): string {
  try {
    const json = JSON.parse(data);
    const result = json.result ?? json;
    const kind = Object.keys(result).find((k) => ["task", "message", "statusUpdate", "artifactUpdate"].includes(k));
    const state = result.statusUpdate?.status?.state ?? result.task?.status?.state;
    if (kind) return state ? `${kind} → ${state}` : kind;
    if (json.error) return "error";
  } catch {
    // JSON 以外
  }
  return "event";
}

function pretty(text: string): string {
  if (!text) return "";
  let out = text;
  try {
    out = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // JSON でなければそのまま
  }
  return out.length > MAX_BODY ? `${out.slice(0, MAX_BODY)}\n…（${out.length - MAX_BODY} 文字省略）` : out;
}
