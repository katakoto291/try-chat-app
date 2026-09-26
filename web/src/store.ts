import type { CallPattern, Topology } from "../../shared/protocol";
import type { Transport } from "./patterns";
import type { Trace } from "./trace";

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** assistant のメッセージだけが持つ、エージェント呼び出しの記録 */
  trace?: Trace;
  pending?: boolean;
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: number;
}

const KEY = "try-chat-app:conversations";

export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as Conversation[]) : [];
    // 読み込み途中で閉じられたメッセージは「中断」として扱う
    return list.map((c) => ({
      ...c,
      messages: c.messages.map((m) => {
        // 古い形式のトレースを補う
        const old = m.trace as (Trace & { rootId?: string | null }) | undefined;
        const trace = old && {
          ...old,
          topology: old.topology ?? "call",
          pattern: old.pattern ?? "direct",
          transport: old.transport ?? "sse",
          rootIds: old.rootIds ?? (old.rootId ? [old.rootId] : []),
          wires: old.wires ?? [],
          agui: old.agui ?? [],
        };
        return m.pending ? { ...m, trace, pending: false, error: m.error ?? "中断されました" } : { ...m, trace };
      }),
    }));
  } catch {
    return [];
  }
}

export function saveConversations(list: Conversation[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // 容量オーバーなどは無視（履歴が保存されないだけ）
  }
}

export const newId = () => crypto.randomUUID();

export interface Settings {
  topology: Topology;
  pattern: CallPattern;
  transport: Transport;
}

const SETTINGS_KEY = "try-chat-app:settings";
const DEFAULT_SETTINGS: Settings = { topology: "call", pattern: "direct", transport: "sse" };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 保存できなくても動作に支障はない
  }
}
