"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function LoginForm({ next }: { next: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
        credentials: "same-origin",
      });
      if (res.ok) {
        // A full navigation, not a client transition: the app shell's providers
        // mount fresh with the new session cookie in place.
        window.location.assign(next);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string; retryAfterSeconds?: number };
      if (res.status === 429 && body.retryAfterSeconds) {
        const minutes = Math.max(1, Math.ceil(body.retryAfterSeconds / 60));
        setError(`Too many attempts. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`);
      } else {
        setError(body.error || "Sign-in failed.");
      }
      setPassword("");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
      <div>
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-foreground">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "login-error" : undefined}
          className="h-12 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
        />
      </div>
      {error && (
        <p id="login-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || password === ""} className="h-11 w-full rounded-full">
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
