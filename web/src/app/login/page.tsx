import { redirect } from "next/navigation";
import { CoMark } from "@/components/co-mark";
import { LoginForm } from "@/components/login-form";
import { instrumentSerif } from "@/lib/fonts";
import { readAuthConfig, safeNextPath } from "@/lib/web-auth.mjs";

export const dynamic = "force-dynamic";

// Sign-in screen for the optional dashboard login (see src/lib/web-auth.mjs).
// With the gate off there is nothing to sign in to, so the page sends the
// visitor straight to the dashboard. src/proxy.ts redirects a visitor who is
// already signed in away from here before this renders.
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const config = readAuthConfig(process.env);
  const params = await searchParams;
  const next = safeNextPath(Array.isArray(params.next) ? params.next[0] : params.next);
  if (!config.enabled) redirect(next);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <section className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-xl sm:p-8">
        <div className="flex items-center gap-2.5">
          <CoMark size={32} />
          <span className={`${instrumentSerif.className} relative -top-px text-2xl font-normal tracking-tight text-landing`}>
            career-ops
          </span>
        </div>
        <h1 className="mt-6 text-xl font-semibold text-foreground">Sign in</h1>
        <p className="mt-1 text-sm text-muted">This dashboard is private. Enter your password to continue.</p>
        {config.ok ? (
          <LoginForm next={next} />
        ) : (
          <p role="alert" className="mt-6 rounded-lg border border-border bg-background p-3 text-sm text-muted">
            Sign-in is not configured correctly on the server. Set CAREER_OPS_WEB_SESSION_SECRET (at least 32
            characters) and restart.
          </p>
        )}
      </section>
    </main>
  );
}
