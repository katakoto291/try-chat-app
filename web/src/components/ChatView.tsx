import { useEffect, useRef, useState } from "react";
import type { Message } from "../store";
import { Markdown } from "./Markdown";

const EXAMPLES = [
  "こんにちは！あなたは何ができますか？",
  "量子コンピュータについて、初心者向けに調べてわかりやすく説明して",
  "Python で FizzBuzz を書くコードを作って",
  "TypeScript で配列を重複なくマージする関数を実装して",
];

interface Props {
  messages: Message[];
  streaming: boolean;
  selectedMessageId: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  onSelectMessage: (id: string) => void;
}

export function ChatView({ messages, streaming, selectedMessageId, onSend, onStop, onSelectMessage }: Props) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const submit = () => {
    const text = input.trim();
    if (!text || streaming) return;
    onSend(text);
    setInput("");
  };

  return (
    <main className="chat">
      <div className="messages">
        {messages.length === 0 ? (
          <div className="empty">
            <h1>何を手伝いましょうか？</h1>
            <p className="muted">質問に応じて、司令塔エージェントが専門エージェントを呼び出します。</p>
            <div className="examples">
              {EXAMPLES.map((ex) => (
                <button key={ex} onClick={() => onSend(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`message ${m.role}`}>
              {m.role === "user" ? (
                <div className="bubble">{m.content}</div>
              ) : (
                <div className="assistant-body">
                  {m.content ? <Markdown text={m.content} /> : m.pending && <span className="typing">考え中…</span>}
                  {m.error && <div className="error">⚠ {m.error}</div>}
                  {m.trace?.rootId && (
                    <button
                      className={`trace-chip ${selectedMessageId === m.id ? "active" : ""}`}
                      onClick={() => onSelectMessage(m.id)}
                    >
                      🔗 エージェント呼び出し {Object.keys(m.trace.calls).length} 回
                      {m.pending ? "（実行中）" : ""} — トレースを見る
                    </button>
                  )}
                </div>
              )}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <div className="composer">
        <textarea
          value={input}
          placeholder="メッセージを入力（Enter で送信 / Shift+Enter で改行）"
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {streaming ? (
          <button className="send stop" onClick={onStop} aria-label="停止">
            ■
          </button>
        ) : (
          <button className="send" onClick={submit} disabled={!input.trim()} aria-label="送信">
            ↑
          </button>
        )}
      </div>
    </main>
  );
}
