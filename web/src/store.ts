import type { CallPattern } from "../../shared/protocol";
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
        // 古い形式のトレース（通信ログ導入前）を補う
        const trace = m.trace && { ...m.trace, pattern: m.trace.pattern ?? "direct", wires: m.trace.wires ?? [] };
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

const PATTERN_KEY = "try-chat-app:pattern";

export function loadPattern(): CallPattern {
  try {
    const p = localStorage.getItem(PATTERN_KEY);
    return p === "mcp" || p === "a2a" ? p : "direct";
  } catch {
    return "direct";
  }
}

export function savePattern(p: CallPattern) {
  try {
    localStorage.setItem(PATTERN_KEY, p);
  } catch {
    // 保存できなくても動作に支障はない
  }
}
