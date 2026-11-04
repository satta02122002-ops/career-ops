import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AUTH_COOKIE, isSecureRequest, sessionCookieOptions } from "@/lib/web-auth.mjs";

// Clears the optional dashboard session cookie (see src/lib/web-auth.mjs).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(
    AUTH_COOKIE,
    "",
    sessionCookieOptions({
      secure: isSecureRequest({
        forwardedProto: req.headers.get("x-forwarded-proto"),
        protocol: req.nextUrl.protocol,
        force: process.env.CAREER_OPS_WEB_COOKIE_SECURE,
      }),
      maxAge: 0,
    }),
  );
  return res;
}
