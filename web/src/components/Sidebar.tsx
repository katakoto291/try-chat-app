import type { ConfigResponse } from "../../../shared/protocol";
import type { Conversation } from "../store";

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  config: ConfigResponse | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

export function Sidebar({ conversations, activeId, config, onSelect, onNew, onDelete }: Props) {
  return (
    <nav className="sidebar">
      <button className="new-chat" onClick={onNew}>
        ＋ 新しいチャット
      </button>

      <div className="conv-list">
        {conversations.map((c) => (
          <div key={c.id} className={`conv ${c.id === activeId ? "active" : ""}`} onClick={() => onSelect(c.id)}>
            <span className="conv-title">{c.title}</span>
            <button
              className="icon-button conv-delete"
              aria-label="削除"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(c.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {config && (
        <section className="agents">
          <h3>
            エージェント構成
            <span className={`mode mode-${config.mode}`}>{config.mode === "mock" ? "モック" : "Claude API"}</span>
          </h3>
          <ul>
            {config.agents.map((a) => (
              <li key={a.id} title={a.description}>
                <span className={`agent-badge agent-${a.id}`}>{a.label}</span>
                {a.canCall.length > 0 && (
                  <span className="muted small">
                    → {a.canCall.map((id) => config.agents.find((x) => x.id === id)?.label ?? id).join("・")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </nav>
  );
}
