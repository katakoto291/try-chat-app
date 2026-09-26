import { useState } from "react";
import { login } from "../api";

/** 合言葉（APP_PASSWORD）を入力する画面 */
export function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError("");
    const ok = await login(password).catch(() => false);
    setBusy(false);
    if (ok) onSuccess();
    else setError("合言葉が違います");
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>Agent Chat</h1>
        <p className="muted small">このアプリは合言葉を知っている人だけが使えます。</p>
        <input
          type="password"
          value={password}
          autoFocus
          placeholder="合言葉"
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className="error">{error}</div>}
        <button type="submit" disabled={!password || busy}>
          {busy ? "確認中…" : "ログイン"}
        </button>
      </form>
    </div>
  );
}
