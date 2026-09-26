import { createHmac, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

/**
 * 合言葉ログイン（APP_PASSWORD）。
 *
 * 公開した URL で本物の API キーを使うと、誰でもチャットできてしまい料金がかかる。
 * APP_PASSWORD を設定すると、合言葉を知っている人だけが /api を使えるようになる。
 * 未設定ならログインなし（ローカル開発用）。
 */

const COOKIE = "try-chat-app-session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 日

export const password = process.env.APP_PASSWORD || "";
export const authEnabled = password !== "";

/** Cookie に入れる値。合言葉そのものではなく、合言葉から作った署名を入れる */
function sessionToken(): string {
  return createHmac("sha256", password).update("try-chat-app-session-v1").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** ログイン済みでなければ 401 を返すミドルウェア */
export const requireLogin: MiddlewareHandler = async (c, next) => {
  if (!authEnabled) return next();
  const token = getCookie(c, COOKIE);
  if (token && safeEqual(token, sessionToken())) return next();
  return c.json({ error: "ログインが必要です" }, 401);
};

/** POST /api/login の中身 */
export const login: MiddlewareHandler = async (c) => {
  const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null;
  const given = typeof body?.password === "string" ? body.password : "";
  if (!authEnabled || !safeEqual(given, password)) {
    // 総当たりを遅くするため、失敗時は少し待つ
    await new Promise((r) => setTimeout(r, 1000));
    return c.json({ error: "合言葉が違います" }, 401);
  }
  setCookie(c, COOKIE, sessionToken(), {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Strict",
    path: "/",
    maxAge: MAX_AGE,
  });
  return c.json({ ok: true });
};

export const logout: MiddlewareHandler = async (c) => {
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
};
