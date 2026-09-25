import { useState } from "react";
import { totalUsage, type CallNode, type Trace } from "../trace";

/**
 * エージェント呼び出しの木を表示するパネル。
 * 親から子へのインデントが「誰が誰を呼んだか」を表す。
 */
export function TracePanel({ trace, onClose }: { trace: Trace | undefined; onClose: () => void }) {
  const calls = trace ? Object.values(trace.calls) : [];
  const usage = trace ? totalUsage(trace) : { input: 0, output: 0 };

  return (
    <aside className="trace">
      <header className="trace-header">
        <div>
          <h2>エージェント呼び出しトレース</h2>
          {trace?.rootId && (
            <p className="muted small">
              呼び出し {calls.length} 回 · 最大の深さ {Math.max(...calls.map((c) => c.depth))} · トークン 入力{" "}
              {usage.input.toLocaleString()} / 出力 {usage.output.toLocaleString()}
            </p>
          )}
        </div>
        <button className="icon-button" onClick={onClose} aria-label="トレースを閉じる">
          ×
        </button>
      </header>
      <div className="trace-body">
        {trace?.rootId ? (
          <CallView trace={trace} callId={trace.rootId} />
        ) : (
          <p className="muted">アシスタントの返答を選ぶと、裏で行われたエージェント間の呼び出しがここに表示されます。</p>
        )}
      </div>
    </aside>
  );
}

function CallView({ trace, callId }: { trace: Trace; callId: string }) {
  const node = trace.calls[callId];
  const [open, setOpen] = useState(true);
  if (!node) return null;

  return (
    <div className={`call call-${node.agent}`}>
      <button className="call-head" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className={`agent-badge agent-${node.agent}`}>{node.label}</span>
        <span className="muted small">{node.model}</span>
        <span className="spacer" />
        <Status node={node} />
      </button>
      {open && (
        <div className="call-body">
          {node.parentCallId && (
            <details className="task">
              <summary>受け取った依頼 (task)</summary>
              <pre>{node.task}</pre>
            </details>
          )}
          {node.turns.map((text, i) => {
            // このターンで呼び出した子エージェントを、ターンの直後に並べる
            const children = node.children.filter((id) => trace.calls[id]?.parentTurn === i);
            return (
              <div key={i} className="turn">
                <div className="turn-label">ターン {i + 1}</div>
                <div className="turn-text">{text || <span className="muted">…</span>}</div>
                {children.length > 0 && (
                  <div className="children">
                    <div className="turn-label">
                      ↳ {children.length > 1 ? `${children.length} つのエージェントを並列に呼び出し` : "エージェントを呼び出し"}
                    </div>
                    {children.map((id) => (
                      <CallView key={id} trace={trace} callId={id} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Status({ node }: { node: CallNode }) {
  if (node.status === "running") return <span className="status running">実行中…</span>;
  const seconds = ((node.endedAt ?? node.startedAt) - node.startedAt) / 1000;
  return (
    <span className={`status ${node.status}`}>
      {node.status === "error" ? "エラー" : "完了"} · {seconds.toFixed(1)}s
      {node.usage && node.usage.output_tokens > 0 && ` · ${node.usage.output_tokens} tok`}
    </span>
  );
}
