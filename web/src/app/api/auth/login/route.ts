import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  AUTH_COOKIE,
  createSessionToken,
  isSecureRequest,
  readAuthConfig,
  sessionCookieOptions,
} from "@/lib/web-auth.mjs";
import { verifyPassword } from "@/lib/password-hash.mjs";
import { clientKey, createLoginThrottle } from "@/lib/login-throttle.mjs";
import { readJsonObject } from "@/lib/json-body";

// Optional dashboard login (see src/lib/web-auth.mjs). Reachable without a
// session by design; the origin guard in src/proxy.ts still runs first, so a
// cross-site page cannot post here from the user's browser.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const throttle = createLoginThrottle();

export async function POST(req: NextRequest) {
  const config = readAuthConfig(process.env);
  if (!config.enabled) return NextResponse.json({ error: "login is not enabled" }, { status: 404 });
  if (!config.ok) return NextResponse.json({ error: "login is misconfigured on the server" }, { status: 503 });

  const key = clientKey(req.headers);
  const gate = throttle.check(key);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later.", retryAfterSeconds: gate.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } },
    );
  }

  const body = await readJsonObject<{ password?: unknown }>(req);
  if (!body) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const password = body.password;

  const ok = await verifyPassword(password, process.env.CAREER_OPS_WEB_PASSWORD_HASH);  if (!ok) {
    throttle.recordFailure(key);
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }
  throttle.recordSuccess(key);

  const token = await createSessionToken({ secret: config.secret, ttlSeconds: config.ttlSeconds });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(
    AUTH_COOKIE,
    token,
    sessionCookieOptions({
      secure: isSecureRequest({
        forwardedProto: req.headers.get("x-forwarded-proto"),
        protocol: req.nextUrl.protocol,
        force: process.env.CAREER_OPS_WEB_COOKIE_SECURE,
      }),
      maxAge: config.ttlSeconds,
    }),
  );
  return res;
}
