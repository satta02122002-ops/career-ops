"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { cn } from "@/lib/cn";

// Shown only when the optional dashboard login is on (see src/lib/web-auth.mjs).
export function SignOutButton({ className }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } finally {
      window.location.assign("/login");
    }
  }
  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className={cn(
        "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50 max-sm:min-h-[44px]",
        className,
      )}
    >
      <LogOut className="size-4" />
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
