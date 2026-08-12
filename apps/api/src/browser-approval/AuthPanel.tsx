import { useEffect, useId, useState, type FormEvent } from "react";

import {
  loadBrowserAuthProviders,
  loginWithLocalSession,
  workosLoginUrl,
  type BrowserAuthProvider
} from "./api.js";

export function AuthPanel({
  onAuthenticated
}: {
  onAuthenticated(): Promise<void>;
}) {
  const emailId = useId();
  const passwordId = useId();
  const [providers, setProviders] = useState<BrowserAuthProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadBrowserAuthProviders()
      .then((loaded) => {
        if (active) setProviders(loaded);
      })
      .catch(() => {
        if (active) setError("Sign-in options could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      await loginWithLocalSession(email.trim(), password);
      setPassword("");
      await onAuthenticated();
    } catch {
      setError("Sign in failed. Check your details and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-panel">
      {providers.includes("local") ? (
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor={emailId}>Email</label>
          <input
            autoComplete="email"
            id={emailId}
            onChange={(event) => setEmail(event.currentTarget.value)}
            required
            type="email"
            value={email}
          />
          <label htmlFor={passwordId}>Password</label>
          <input
            autoComplete="current-password"
            id={passwordId}
            onChange={(event) => setPassword(event.currentTarget.value)}
            required
            type="password"
            value={password}
          />
          <button className="primary full" disabled={busy} type="submit">
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      ) : null}
      {providers.includes("workos") ? (
        <a className="button secondary full" href={workosLoginUrl()}>
          Sign in with WorkOS
        </a>
      ) : null}
      {loading ? <p className="muted">Loading sign-in options…</p> : null}
      {!loading && providers.length === 0 ? (
        <p className="error">No browser sign-in provider is available.</p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
