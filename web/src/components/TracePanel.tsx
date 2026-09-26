import { useState } from "react";
import { patternInfo } from "../patterns";
import { totalUsage, type CallNode, type Trace, type WireEntry } from "../trace";

type Tab = "tree" | "wire";

/**
 * エージェント呼び出しを表示するパネル。
 * - 呼び出しツリー: 誰が誰を呼んだか（親から子へのインデント）
 * - 通信ログ:       エージェント間で実際にやり取りされたメッセージ（時系列）
 */
export function TracePanel({ trace, onClose }: { trace: Trace | undefined; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("tree");
  const calls = trace ? Object.values(trace.calls) : [];
  const usage = trace ? totalUsage(trace) : { input: 0, output: 0 };

  return (
    <aside className="trace">
      <header className="trace-header">
        <div>
          <h2>エージェント呼び出しトレース</h2>
          {trace?.rootId && (
            <p className="muted small">
              {patternInfo(trace.pattern).label} · 呼び出し {calls.length} 回 · 最大の深さ{" "}
              {Math.max(...calls.map((c) => c.depth))} · トークン 入力 {usage.input.toLocaleString()} / 出力{" "}
              {usage.output.toLocaleString()}
            </p>
          )}
        </div>
        <button className="icon-button" onClick={onClose} aria-label="トレースを閉じる">
          ×
        </button>
      </header>

      {trace?.rootId && (
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "tree"} className={tab === "tree" ? "active" : ""} onClick={() => setTab("tree")}>
            呼び出しツリー
          </button>
          <button role="tab" aria-selected={tab === "wire"} className={tab === "wire" ? "active" : ""} onClick={() => setTab("wire")}>
            通信ログ ({trace.wires.length})
          </button>
        </div>
      )}

      <div className="trace-body">
        {!trace?.rootId ? (
          <p className="muted">アシスタントの返答を選ぶと、裏で行われたエージェント間の呼び出しがここに表示されます。</p>
        ) : tab === "tree" ? (
          <CallView trace={trace} callId={trace.rootId} />
        ) : (
          <WireLog trace={trace} />
        )}
      </div>
    </aside>
  );
}

// ────────────────────────────── 呼び出しツリー ──────────────────────────────

function CallView({ trace, callId }: { trace: Trace; callId: string }) {
  const node = trace.calls[callId];
  const [open, setOpen] = useState(true);
  if (!node) return null;

  return (
    <div className={`call call-${node.agent}`}>
      <button className="call-head" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className={`agent-badge agent-${node.agent}`}>{node.label}</span>
        {node.parentCallId && <span className={`via via-${node.via}`}>via {patternInfo(node.via).label}</span>}
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

// ────────────────────────────── 通信ログ ──────────────────────────────

const ARROWS: Record<WireEntry["direction"], string> = { request: "→", response: "←", event: "⇠" };

function WireLog({ trace }: { trace: Trace }) {
  const info = patternInfo(trace.pattern);
  return (
    <div className="wire-log">
      <div className="pattern-explainer">
        <div className="small">
          <strong>{info.label}</strong> の流れ — 呼ばれる側は「{info.calleeIs}」
        </div>
        <ol>
          {info.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </div>
      {trace.wires.length === 0 ? (
        <p className="muted small">まだ通信はありません（サブエージェントを呼び出すと記録されます）。</p>
      ) : (
        trace.wires.map((w) => <WireRow key={w.seq} wire={w} caller={trace.calls[w.callId]} />)
      )}
    </div>
  );
}

function WireRow({ wire, caller }: { wire: WireEntry; caller: CallNode | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`wire wire-${wire.direction}`}>
      <button className="wire-head" onClick={() => setOpen(!open)} disabled={!wire.body}>
        <span className="wire-time">+{(wire.at / 1000).toFixed(2)}s</span>
        {caller && <span className={`agent-badge agent-${caller.agent}`}>{caller.label}</span>}
        <span className="wire-arrow" title={wire.direction}>
          {ARROWS[wire.direction]}
        </span>
        <span className="wire-label">{wire.label}</span>
        <span className="spacer" />
        <span className="muted small wire-url">{wire.url}</span>
      </button>
      {open && wire.body && <pre className="wire-body">{wire.body}</pre>}
    </div>
  );
}
