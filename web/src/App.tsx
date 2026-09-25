import { useEffect, useRef, useState } from "react";
import type { ConfigResponse } from "../../shared/protocol";
import { fetchConfig, streamChat } from "./api";
import { ChatView } from "./components/ChatView";
import { Sidebar } from "./components/Sidebar";
import { TracePanel } from "./components/TracePanel";
import { loadConversations, newId, saveConversations, type Conversation, type Message } from "./store";
import { applyEvent, emptyTrace, rootText } from "./trace";

export function App() {
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [activeId, setActiveId] = useState<string | null>(() => conversations[0]?.id ?? null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [traceOpen, setTraceOpen] = useState(true);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetchConfig().then(setConfig).catch(() => setConfig(null));
  }, []);
  useEffect(() => saveConversations(conversations), [conversations]);

  const active = conversations.find((c) => c.id === activeId);
  const selectedMessage = active?.messages.find((m) => m.id === selectedMessageId);

  const updateMessage = (convId: string, msgId: string, fn: (m: Message) => Message) =>
    setConversations((list) =>
      list.map((c) => (c.id === convId ? { ...c, messages: c.messages.map((m) => (m.id === msgId ? fn(m) : m)) } : c)),
    );

  async function send(text: string) {
    const conv: Conversation = active ?? { id: newId(), title: text.slice(0, 30), messages: [], updatedAt: Date.now() };
    const userMsg: Message = { id: newId(), role: "user", content: text };
    const assistantMsg: Message = { id: newId(), role: "assistant", content: "", trace: emptyTrace(), pending: true };

    // サーバーに送る履歴（エラーになった返答は除く）
    const history = [...conv.messages, userMsg]
      .filter((m) => !m.error && m.content)
      .map((m) => ({ role: m.role, content: m.content }));

    const updated = { ...conv, messages: [...conv.messages, userMsg, assistantMsg], updatedAt: Date.now() };
    setConversations((list) => [updated, ...list.filter((c) => c.id !== conv.id)]);
    setActiveId(conv.id);
    setSelectedMessageId(assistantMsg.id);
    setTraceOpen(true);

    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    try {
      await streamChat(
        history,
        (event) =>
          updateMessage(conv.id, assistantMsg.id, (m) => {
            if (event.type === "error") return { ...m, error: event.message };
            if (event.type === "done") return m;
            const trace = applyEvent(m.trace ?? emptyTrace(), event);
            return { ...m, trace, content: rootText(trace) };
          }),
        controller.signal,
      );
    } catch (err) {
      const message = controller.signal.aborted ? "停止しました" : err instanceof Error ? err.message : String(err);
      updateMessage(conv.id, assistantMsg.id, (m) => ({ ...m, error: message }));
    } finally {
      updateMessage(conv.id, assistantMsg.id, (m) => ({ ...m, pending: false }));
      setStreaming(false);
      abortRef.current = null;
    }
  }

  return (
    <div className={`app ${traceOpen ? "with-trace" : ""}`}>
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        config={config}
        onSelect={(id) => {
          setActiveId(id);
          setSelectedMessageId(null);
        }}
        onNew={() => {
          setActiveId(null);
          setSelectedMessageId(null);
        }}
        onDelete={(id) => {
          setConversations((list) => list.filter((c) => c.id !== id));
          if (id === activeId) setActiveId(null);
        }}
      />
      <ChatView
        messages={active?.messages ?? []}
        streaming={streaming}
        selectedMessageId={selectedMessageId}
        onSend={send}
        onStop={() => abortRef.current?.abort()}
        onSelectMessage={(id) => {
          setSelectedMessageId(id);
          setTraceOpen(true);
        }}
      />
      {traceOpen && <TracePanel trace={selectedMessage?.trace} onClose={() => setTraceOpen(false)} />}
    </div>
  );
}
