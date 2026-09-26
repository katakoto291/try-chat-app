import { useEffect, useRef, useState } from "react";
import { PATTERNS, TOPOLOGIES, TRANSPORTS, patternInfo, topologyInfo } from "../patterns";
import type { Message, Settings } from "../store";
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
  settings: Settings;
  onSettingsChange: (s: Settings) => void;
  selectedMessageId: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  onSelectMessage: (id: string) => void;
}

export function ChatView({
  messages,
  streaming,
  settings,
  onSettingsChange,
  selectedMessageId,
  onSend,
  onStop,
  onSelectMessage,
}: Props) {
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
            <p className="muted">
              質問に応じて、司令塔エージェントが専門エージェントを呼び出します。
              <br />
              下の設定を切り替えて同じ質問を送ると、連携パターン（呼び出し・ハンドオフ・Pub/Sub）や
              プロトコル（直接・MCP・A2A）、画面との通信（独自 SSE・AG-UI）の違いを比べられます。
            </p>
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
                  {m.trace && m.trace.rootIds.length > 0 && (
                    <button
                      className={`trace-chip ${selectedMessageId === m.id ? "active" : ""}`}
                      onClick={() => onSelectMessage(m.id)}
                    >
                      🔗 {traceLabel(m.trace)} · エージェント {Object.keys(m.trace.calls).length} 回
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

      <div className="settings">
        <Segmented
          label="連携パターン"
          options={TOPOLOGIES}
          value={settings.topology}
          disabled={streaming}
          onChange={(topology) => onSettingsChange({ ...settings, topology })}
        />
        <Segmented
          label="プロトコル"
          options={PATTERNS}
          value={settings.pattern}
          disabled={streaming || settings.topology !== "call"}
          onChange={(pattern) => onSettingsChange({ ...settings, pattern })}
        />
        <Segmented
          label="画面との通信"
          options={TRANSPORTS}
          value={settings.transport}
          disabled={streaming}
          onChange={(transport) => onSettingsChange({ ...settings, transport })}
        />
        <p className="muted small settings-summary">
          {topologyInfo(settings.topology).summary}
          {settings.topology === "call" && <> / {patternInfo(settings.pattern).summary}</>}
          {settings.topology !== "call" && <>（プロトコルの選択は「呼び出し」のときだけ使います）</>}
        </p>
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

function traceLabel(trace: NonNullable<Message["trace"]>): string {
  const parts = [topologyInfo(trace.topology).label];
  if (trace.topology === "call") parts.push(patternInfo(trace.pattern).label);
  if (trace.transport === "agui") parts.push("AG-UI");
  return parts.join(" / ");
}

function Segmented<T extends string>({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  disabled: boolean;
  onChange: (v: T) => void;
}) {
  return (
    <div className="setting">
      <span className="muted small">{label}</span>
      <div className={`segmented ${disabled ? "disabled" : ""}`} role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.id}
            role="radio"
            aria-checked={value === o.id}
            className={value === o.id ? "active" : ""}
            disabled={disabled}
            onClick={() => onChange(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
