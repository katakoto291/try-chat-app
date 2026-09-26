import { Fragment, useState } from "react";
import type { Via } from "../../../shared/protocol";
import { patternInfo, topologyInfo } from "../patterns";
import { totalUsage, type AguiEntry, type CallNode, type Trace, type WireEntry } from "../trace";

type Tab = "tree" | "wire" | "agui";

const VIA_LABELS: Record<Via, string> = {
  direct: "直接",
  mcp: "MCP",
  a2a: "A2A",
  handoff: "ハンドオフ",
  pubsub: "Pub/Sub",
};

/**
 * エージェント呼び出しを表示するパネル。
 * - 呼び出しツリー: 誰が誰を呼んだか / 誰から誰に引き継いだか
 * - 通信ログ:       エージェント間で実際にやり取りされたメッセージ（時系列）
 * - AG-UI イベント: 画面がサーバーから受け取った AG-UI の生イベント（AG-UI 選択時のみ）
 */
export function TracePanel({ trace, onClose }: { trace: Trace | undefined; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("tree");
  const calls = trace ? Object.values(trace.calls) : [];
  const usage = trace ? totalUsage(trace) : { input: 0, output: 0 };
  const hasTrace = !!trace && trace.rootIds.length > 0;
  const current: Tab = tab === "agui" && trace?.transport !== "agui" ? "tree" : tab;

  const tabs: { id: Tab; label: string }[] = [
    { id: "tree", label: "呼び出しツリー" },
    { id: "wire", label: `通信ログ (${trace?.wires.length ?? 0})` },
  ];
  if (trace?.transport === "agui") tabs.push({ id: "agui", label: `AG-UI イベント (${trace.agui.length})` });

  return (
    <aside className="trace">
      <header className="trace-header">
        <div>
          <h2>エージェント呼び出しトレース</h2>
          {hasTrace && (
            <p className="muted small">
              {topologyInfo(trace.topology).label}
              {trace.topology === "call" && ` / ${patternInfo(trace.pattern).label}`}
              {trace.transport === "agui" && " / AG-UI"} · エージェント {calls.length} 回 · トークン 入力{" "}
              {usage.input.toLocaleString()} / 出力 {usage.output.toLocaleString()}
            </p>
          )}
        </div>
        <button className="icon-button" onClick={onClose} aria-label="トレースを閉じる">
          ×
        </button>
      </header>

      {hasTrace && (
        <div className="tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={current === t.id}
              className={current === t.id ? "active" : ""}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div className="trace-body">
        {!hasTrace ? (
          <p className="muted">アシスタントの返答を選ぶと、裏で行われたエージェント間の呼び出しがここに表示されます。</p>
        ) : current === "tree" ? (
          <Roots trace={trace} />
        ) : current === "wire" ? (
          <WireLog trace={trace} />
        ) : (
          <AguiLog trace={trace} />
        )}
      </div>
    </aside>
  );
}

// ────────────────────────────── 呼び出しツリー ──────────────────────────────

/** 最上位のエージェントを順に並べる（ハンドオフや Pub/Sub の集約では複数になる） */
function Roots({ trace }: { trace: Trace }) {
  return (
    <>
      {trace.rootIds.map((id, i) => {
        const node = trace.calls[id];
        return (
          <Fragment key={id}>
            {i > 0 && node && (
              <div className="root-link">
                {node.handoffFrom ? "⇓ ハンドオフ（会話ごと引き継ぎ）" : "⇓ 購読していたイベントが出そろったので、集約"}
              </div>
            )}
            <CallView trace={trace} callId={id} />
          </Fragment>
        );
      })}
    </>
  );
}

function CallView({ trace, callId }: { trace: Trace; callId: string }) {
  const node = trace.calls[callId];
  const [open, setOpen] = useState(true);
  if (!node) return null;
  const showVia = node.parentCallId !== null || node.handoffFrom !== undefined;

  return (
    <div className={`call call-${node.agent}`}>
      <button className="call-head" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className={`agent-badge agent-${node.agent}`}>{node.label}</span>
        {showVia && <span className={`via via-${node.via}`}>via {VIA_LABELS[node.via]}</span>}
        <span className="muted small">{node.model}</span>
        <span className="spacer" />
        <Status node={node} />
      </button>
      {open && (
        <div className="call-body">
          {(node.parentCallId || node.handoffFrom) && (
            <details className="task">
              <summary>受け取った内容</summary>
              <pre>{node.task}</pre>
            </details>
          )}
          {node.turns.map((text, i) => {
            // このターンで起動した子エージェントを、ターンの直後に並べる
            const children = node.children.filter((id) => trace.calls[id]?.parentTurn === i);
            return (
              <div key={i} className="turn">
                <div className="turn-label">ターン {i + 1}</div>
                <div className="turn-text">{text || <span className="muted">…</span>}</div>
                {children.length > 0 && (
                  <div className="children">
                    <div className="turn-label">
                      ↳{" "}
                      {trace.topology === "pubsub"
                        ? `発行したイベントに ${children.length} つのエージェントが反応`
                        : children.length > 1
                          ? `${children.length} つのエージェントを並列に呼び出し`
                          : "エージェントを呼び出し"}
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

function Explainer({ trace }: { trace: Trace }) {
  const topology = topologyInfo(trace.topology);
  const pattern = patternInfo(trace.pattern);
  const title = trace.topology === "call" ? `${pattern.label} の流れ — 呼ばれる側は「${pattern.calleeIs}」` : `${topology.label} の流れ`;
  const steps = trace.topology === "call" ? pattern.steps : topology.steps;
  return (
    <div className="pattern-explainer">
      <div className="small">
        <strong>{title}</strong>
      </div>
      <ol>
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </div>
  );
}

function WireLog({ trace }: { trace: Trace }) {
  return (
    <div className="wire-log">
      <Explainer trace={trace} />
      {trace.wires.length === 0 ? (
        <p className="muted small">まだ通信はありません（他のエージェントとやり取りすると記録されます）。</p>
      ) : (
        trace.wires.map((w) => (
          <LogRow
            key={w.seq}
            className={`wire-${w.direction}`}
            at={w.at}
            badge={trace.calls[w.callId]}
            arrow={ARROWS[w.direction]}
            label={w.label}
            right={w.url}
            body={w.body}
          />
        ))
      )}
    </div>
  );
}

// ────────────────────────────── AG-UI イベント ──────────────────────────────

function AguiLog({ trace }: { trace: Trace }) {
  return (
    <div className="wire-log">
      <div className="pattern-explainer">
        <div className="small">
          <strong>AG-UI</strong> — エージェントから画面へ届いた標準イベント
        </div>
        <ol>
          <li>RUN_STARTED で始まり、RUN_FINISHED（または RUN_ERROR）で終わる</li>
          <li>文章は TEXT_MESSAGE_START → CONTENT（断片）→ END、ツールは TOOL_CALL_START → ARGS → END → RESULT</li>
          <li>サブエージェントは SUBAGENT_STARTED / FINISHED。そのあいだのイベントには subagentRunId が付く</li>
          <li>標準にない情報（通信ログなど）は CUSTOM イベントや metadata で運ぶ</li>
        </ol>
      </div>
      {trace.agui.map((e) => (
        <LogRow
          key={e.seq}
          className={`agui-${categoryOf(e.type)}`}
          at={e.at}
          badge={badgeFor(trace, e)}
          arrow="⇠"
          label={e.count > 1 ? `${e.type} ×${e.count}` : e.type}
          right={summaryOf(e)}
          body={JSON.stringify(e.event, null, 2)}
        />
      ))}
    </div>
  );
}

function categoryOf(type: string): string {
  if (type.startsWith("TEXT_MESSAGE")) return "text";
  if (type.startsWith("TOOL_CALL")) return "tool";
  if (type.startsWith("SUBAGENT") || type.startsWith("STEP")) return "agent";
  if (type.startsWith("RUN")) return "run";
  return "other";
}

/** どのエージェントのイベントか（subagentRunId か metadata.callId から探す） */
function badgeFor(trace: Trace, e: AguiEntry): CallNode | undefined {
  const ev = e.event as { subagentRunId?: string; metadata?: { callId?: string }; messageId?: string };
  const id = ev.subagentRunId ?? ev.metadata?.callId ?? ev.messageId?.split(":")[0];
  return id ? trace.calls[id] : undefined;
}

function summaryOf(e: AguiEntry): string {
  const ev = e.event as Record<string, unknown>;
  if (typeof ev.toolCallName === "string") return ev.toolCallName;
  if (typeof ev.name === "string") return ev.name;
  if (typeof ev.stepName === "string") return ev.stepName;
  if (typeof ev.delta === "string") return ev.delta.replace(/\s+/g, " ").slice(0, 40);
  return "";
}

// ────────────────────────────── 共通の 1 行 ──────────────────────────────

function LogRow(props: {
  className: string;
  at: number;
  badge: CallNode | undefined;
  arrow: string;
  label: string;
  right: string;
  body: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`wire ${props.className}`}>
      <button className="wire-head" onClick={() => setOpen(!open)} disabled={!props.body}>
        <span className="wire-time">+{(props.at / 1000).toFixed(2)}s</span>
        {props.badge && <span className={`agent-badge agent-${props.badge.agent}`}>{props.badge.label}</span>}
        <span className="wire-arrow">{props.arrow}</span>
        <span className="wire-label">{props.label}</span>
        <span className="spacer" />
        <span className="muted small wire-url">{props.right}</span>
      </button>
      {open && props.body && <pre className="wire-body">{props.body}</pre>}
    </div>
  );
}
