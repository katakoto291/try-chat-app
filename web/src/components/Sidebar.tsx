import type { AgentInfo, ConfigResponse, Topology } from "../../../shared/protocol";
import type { Conversation } from "../store";

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  config: ConfigResponse | null;
  topology: Topology;
  onLogout: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

export function Sidebar({ conversations, activeId, config, topology, onLogout, onSelect, onNew, onDelete }: Props) {
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
                <Relation agent={a} agents={config.agents} topology={topology} />
              </li>
            ))}
          </ul>
          {config.external.agents.length > 0 && (
            <>
              <h3>
                外部エージェント
                <span className="muted small">{config.external.source === "hub" ? "agent-hub から" : "設定から"}</span>
              </h3>
              <ul>
                {config.external.agents.map((a) => (
                  <li key={a.id} title={a.available ? `${a.description}\n${a.url}` : `${a.url}\n${a.note ?? ""}`}>
                    <span className="agent-badge agent-external" style={a.available ? undefined : { opacity: 0.4 }}>
                      {a.name}
                    </span>
                    <span className="muted small">{a.available ? a.skills.join("・") : "つながりません"}</span>
                  </li>
                ))}
              </ul>
              <p className="muted small">「呼び出し」パターンのとき、司令塔が call_ext_* ツールで呼びます</p>
            </>
          )}
          {config.auth && (
            <button className="logout" onClick={onLogout}>
              ログアウト
            </button>
          )}
        </section>
      )}
    </nav>
  );
}

/** 選んでいる連携パターンでの、そのエージェントのつながり */
function Relation({ agent, agents, topology }: { agent: AgentInfo; agents: AgentInfo[]; topology: Topology }) {
  const names = (ids: string[]) => ids.map((id) => agents.find((x) => x.id === id)?.label ?? id).join("・");
  if (topology === "call") {
    return agent.canCall.length > 0 ? <span className="muted small">→ {names(agent.canCall)}</span> : null;
  }
  if (topology === "handoff") {
    return agent.handoffTo.length > 0 ? <span className="muted small">⇒ {names(agent.handoffTo)}</span> : null;
  }
  return (
    <span className="muted small topics">
      {agent.id === "orchestrator" ? "発行: " : "購読: "}
      {(agent.id === "orchestrator" ? agent.publishes : agent.subscribes).join(", ")}
    </span>
  );
}
