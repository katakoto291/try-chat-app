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
      messages: c.messages.map((m) => (m.pending ? { ...m, pending: false, error: m.error ?? "中断されました" } : m)),
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
