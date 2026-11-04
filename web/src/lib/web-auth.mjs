// Optional single-user login for the dashboard.
//
// The dashboard is local-first and, by default, has no login: the loopback bind
// is the access control (see origin-guard.mjs and bind-host.mjs). That stops
// being enough the moment the dashboard is published beyond the machine, for
// example behind a Cloudflare Tunnel on the user's own domain. This module is the
// pure decision logic for an opt-in password gate that `src/proxy.ts` applies
// after the origin guard has passed.
//
// Opt-in, never implied: the gate is ON only when CAREER_OPS_WEB_PASSWORD_HASH is
// set (generate it with `npm run auth:hash`). Unset means today's behavior,
// byte for byte. When the hash is set the gate fails CLOSED: a missing or short
// CAREER_OPS_WEB_SESSION_SECRET answers 503 on every route instead of serving
// the dashboard unauthenticated or with a guessable signing key.
//
// The session is a stateless, HMAC-SHA256-signed token in an HttpOnly cookie:
//   base64url(JSON {v, iat, exp, n}) "." base64url(HMAC(secret, payload))
// Verification uses crypto.subtle.verify, which compares in constant time.
// Like origin-guard.mjs this file imports nothing from node or next, so it runs
// on any runtime the proxy is compiled for and is unit testable in isolation.
// Password hashing (scrypt) needs node:crypto and lives in password-hash.mjs,
// which only the login route imports.

export const AUTH_COOKIE = "co_session";
export const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MIN_SECRET_LENGTH = 32;

// Paths reachable without a session. Build assets never reach the proxy (its
// matcher excludes them). Everything else, pages and /api alike, needs a session.
const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/logout", "/icon.svg"]);

const encoder = new TextEncoder();

/**
 * Read the gate's configuration from an env-like object.
 * @param {Record<string, string | undefined>} env
 * @returns {{ enabled: false } | { enabled: true, ok: true, secret: string, ttlSeconds: number } | { enabled: true, ok: false, reason: string }}
 */
export function readAuthConfig(env) {
  const hash = String(env?.CAREER_OPS_WEB_PASSWORD_HASH ?? "").trim();
  if (!hash) return { enabled: false };
  const secret = String(env?.CAREER_OPS_WEB_SESSION_SECRET ?? "").trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    return {
      enabled: true,
      ok: false,
      reason: `CAREER_OPS_WEB_SESSION_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters when CAREER_OPS_WEB_PASSWORD_HASH is set`,
    };
  }
  const ttlRaw = Number(env?.CAREER_OPS_WEB_SESSION_TTL_SECONDS);
  const ttlSeconds = Number.isInteger(ttlRaw) && ttlRaw > 0 ? ttlRaw : DEFAULT_SESSION_TTL_SECONDS;
  return { enabled: true, ok: true, secret, ttlSeconds };
}

/** @param {string} pathname */
export function isPublicPath(pathname) {
  return PUBLIC_PATHS.has(pathname);
}

/**
 * Where to send the user after signing in. Only a same-site absolute path is
 * accepted: anything that could leave the origin ("//evil.com", "/\\evil.com",
 * "https://...") or loop back to /login falls back to "/".
 * @param {unknown} raw
 */
export function safeNextPath(raw) {
  if (typeof raw !== "string" || raw === "") return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f\\]/.test(raw)) return "/";
  if (raw === "/login" || raw.startsWith("/login?") || raw.startsWith("/login/")) return "/";
  return raw;
}

/**
 * Cookies must be Secure when the browser reached us over HTTPS. Behind a
 * tunnel or reverse proxy the hop to Next is plain HTTP, so the original scheme
 * comes from X-Forwarded-Proto. CAREER_OPS_WEB_COOKIE_SECURE=1 forces it.
 * @param {{ forwardedProto?: string | null, protocol?: string | null, force?: string | null }} p
 */
export function isSecureRequest({ forwardedProto, protocol, force }) {
  if (String(force ?? "").trim() === "1") return true;
  const fp = String(forwardedProto ?? "").split(",")[0].trim().toLowerCase();
  if (fp) return fp === "https";
  return String(protocol ?? "").replace(/:$/, "").toLowerCase() === "https";
}

/**
 * Attributes for the session cookie (pass a maxAge of 0 to clear it).
 * @param {{ secure: boolean, maxAge: number }} p
 * @returns {{ httpOnly: true, secure: boolean, sameSite: "strict", path: "/", maxAge: number }}
 */
export function sessionCookieOptions({ secure, maxAge }) {
  return { httpOnly: true, secure, sameSite: "strict", path: "/", maxAge };
}

/** @param {Uint8Array} bytes */
function toBase64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} s */
function fromBase64Url(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** @param {string} secret */
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/**
 * Issue a signed session token.
 * @param {{ secret: string, ttlSeconds: number, now?: number }} p  now in ms
 */
export async function createSessionToken({ secret, ttlSeconds, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  const payload = toBase64Url(encoder.encode(JSON.stringify({ v: 1, iat, exp: iat + ttlSeconds, n: toBase64Url(nonce) })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload)));
  return `${payload}.${toBase64Url(sig)}`;
}

/**
 * True only for a well-formed, correctly signed, unexpired token.
 * @param {{ token: unknown, secret: string, now?: number }} p  now in ms
 */
export async function verifySessionToken({ token, secret, now = Date.now() }) {
  if (typeof token !== "string" || token.length > 1024) return false;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const sig = fromBase64Url(parts[1]);
  if (!sig) return false;
  let valid = false;
  try {
    valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, encoder.encode(parts[0]));
  } catch {
    return false;
  }
  if (!valid) return false;
  const raw = fromBase64Url(parts[0]);
  if (!raw) return false;
  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return false;
  }
  if (!claims || claims.v !== 1 || !Number.isInteger(claims.exp) || !Number.isInteger(claims.iat)) return false;
  const nowSec = Math.floor(now / 1000);
  // A token issued in the future (beyond small clock skew) is not trusted either.
  return claims.exp > nowSec && claims.iat <= nowSec + 60;
}

/**
 * The gate's decision for one request, after the origin guard has passed.
 * @param {{ config: ReturnType<typeof readAuthConfig>, pathname: string, search?: string, token?: string | null, now?: number }} p
 * @returns {Promise<{ action: "next" } | { action: "deny", status: number, error: string } | { action: "redirect", location: string }>}
 */
export async function decideAuth({ config, pathname, search = "", token, now }) {
  // Gate off: there is nothing to sign in to. Redirect here rather than from the
  // page, whose streamed response would turn the redirect into a client-side hop.
  if (!config.enabled) return pathname === "/login" ? { action: "redirect", location: "/" } : { action: "next" };
  if (!config.ok) return { action: "deny", status: 503, error: "login is misconfigured on the server" };
  const signedIn = token ? await verifySessionToken({ token, secret: config.secret, now }) : false;
  if (isPublicPath(pathname)) {
    if (pathname === "/login" && signedIn) return { action: "redirect", location: "/" };
    return { action: "next" };
  }
  if (signedIn) return { action: "next" };
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return { action: "deny", status: 401, error: "sign in required" };
  }
  const next = safeNextPath(`${pathname}${search}`);
  return { action: "redirect", location: next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}` };
}
