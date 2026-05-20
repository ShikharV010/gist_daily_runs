"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        const next = params.get("next") || "/";
        router.push(next);
        router.refresh();
      } else {
        setErr("Wrong password");
        setBusy(false);
      }
    } catch {
      setErr("Network error. Try again.");
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-[color:var(--border)]/20">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-5 bg-white border border-[color:var(--border)] rounded-lg p-8 shadow-sm"
      >
        <div className="flex flex-col items-center gap-3 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/gushwork-logo.svg" alt="Gushwork" className="h-8" />
          <div>
            <h1 className="text-lg font-semibold">In-House Cold Email Platform</h1>
            <p className="text-xs text-[color:var(--muted)]">Enter the password to continue</p>
          </div>
        </div>
        <input
          type="password"
          autoFocus
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full px-3 py-2 rounded border border-[color:var(--border)] outline-none focus:ring-2 focus:ring-[color:var(--accent)]"
        />
        {err && <p className="text-sm text-red-600">{err}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full px-4 py-2 rounded bg-[color:var(--accent)] text-white text-sm font-medium disabled:opacity-50"
        >
          {busy ? "Entering…" : "Enter"}
        </button>
      </form>
    </main>
  );
}
