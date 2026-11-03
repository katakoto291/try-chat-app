// A2A のエージェントを呼んで、結果をハブの共通の形（/invocations と同じ SSE）に直す部分。
//
// ハブを使う側（チャットアプリなど）は、相手が /invocations 方式か A2A 方式かを気にしなくてよいように、
// どちらも同じ形で返します。
//
//   A2A のイベント                                         ハブが返すイベント
//   statusUpdate(WORKING, data: {type:"tool_call",...}) →  {"type":"tool_call","name":...,"input":...}
//   artifactUpdate（文章）                               →  {"type":"text","text":...}
//   statusUpdate(COMPLETED)                              →  {"type":"result","result":...}
//   statusUpdate(FAILED)                                 →  {"type":"error","error":...}

import { randomUUID } from "node:crypto";
import { Role, TaskState, type AgentCard, type Part } from "@a2a-js/sdk";
import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver, JsonRpcTransportFactory } from "@a2a-js/sdk/client";

const textOf = (parts: Part[]) => parts.flatMap((p) => (p.content?.$case === "text" ? [p.content.value] : [])).join("");

/** Agent Card を読む（A2A の標準の場所: <URL>/.well-known/agent-card.json） */
export async function fetchA2aCard(a2aUrl: string, fetchImpl: typeof fetch): Promise<AgentCard> {
  return new DefaultAgentCardResolver({ fetchImpl }).resolve(a2aUrl);
}

/** A2A でメッセージを送り、ハブの共通イベントの形で 1 件ずつ返す */
export async function* callA2a(
  card: AgentCard,
  a2aUrl: string,
  prompt: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): AsyncGenerator<{ type: string; [key: string]: unknown }> {
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, { transports: [new JsonRpcTransportFactory({ fetchImpl })] }),
  );
  // Agent Card に書かれた URL ではなく、ハブが知っている URL に送る（AgentCore では外から見た URL が違うため）
  const client = await factory.createFromAgentCard({
    ...card,
    supportedInterfaces: card.supportedInterfaces.map((i) => (i.protocolBinding === "JSONRPC" ? { ...i, url: a2aUrl } : i)),
  });

  const stream = client.sendMessageStream(
    {
      tenant: "",
      message: {
        messageId: randomUUID(), contextId: "", taskId: "", role: Role.ROLE_USER,
        parts: [{ content: { $case: "text", value: prompt }, metadata: undefined, filename: "", mediaType: "text/plain" }],
        metadata: undefined, extensions: [], referenceTaskIds: [],
      },
      configuration: undefined,
      metadata: undefined,
    },
    { signal },
  );

  let answer = "";
  for await (const event of stream) {
    const p = event.payload;
    if (p?.$case === "statusUpdate") {
      const state = p.value.status?.state;
      for (const part of p.value.status?.message?.parts ?? []) {
        if (part.content?.$case === "data" && part.content.value?.type === "tool_call") yield part.content.value;
      }
      if (state === TaskState.TASK_STATE_FAILED) yield { type: "error", error: textOf(p.value.status?.message?.parts ?? []) || "失敗しました" };
    } else if (p?.$case === "artifactUpdate" && p.value.artifact) {
      const text = textOf(p.value.artifact.parts);
      if (text) {
        answer += text;
        yield { type: "text", text };
      }
    } else if (p?.$case === "message") {
      // タスクを作らず、メッセージ 1 つで答えるエージェントもいる
      const text = textOf(p.value.parts);
      answer += text;
      yield { type: "text", text };
    }
  }
  yield { type: "result", result: answer };
}
