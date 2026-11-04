import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTH_COOKIE,
  DEFAULT_SESSION_TTL_SECONDS,
  createSessionToken,
  decideAuth,
  isPublicPath,
  isSecureRequest,
  readAuthConfig,
  safeNextPath,
  sessionCookieOptions,
  verifySessionToken,
} from "../../src/lib/web-auth.mjs";

const SECRET = "s".repeat(40);
const ENABLED = { CAREER_OPS_WEB_PASSWORD_HASH: "scrypt:x", CAREER_OPS_WEB_SESSION_SECRET: SECRET };

// --- readAuthConfig -------------------------------------------------------

test("readAuthConfig: off when no password hash is set (default behavior unchanged)", () => {
  assert.deepEqual(readAuthConfig({}), { enabled: false });
  assert.deepEqual(readAuthConfig({ CAREER_OPS_WEB_PASSWORD_HASH: "   " }), { enabled: false });
  assert.deepEqual(readAuthConfig({ CAREER_OPS_WEB_SESSION_SECRET: SECRET }), { enabled: false });
});

test("readAuthConfig: fails closed when the hash is set but the secret is missing or short", () => {
  for (const secret of [undefined, "", "short"]) {
    const c = readAuthConfig({ CAREER_OPS_WEB_PASSWORD_HASH: "scrypt:x", CAREER_OPS_WEB_SESSION_SECRET: secret });
    assert.equal(c.enabled, true);
    assert.equal(c.ok, false);
  }
});

test("readAuthConfig: enabled with default and custom TTL", () => {
  const c = readAuthConfig(ENABLED);
  assert.equal(c.enabled && c.ok && c.ttlSeconds, DEFAULT_SESSION_TTL_SECONDS);
  const c2 = readAuthConfig({ ...ENABLED, CAREER_OPS_WEB_SESSION_TTL_SECONDS: "3600" });
  assert.equal(c2.enabled && c2.ok && c2.ttlSeconds, 3600);
  const c3 = readAuthConfig({ ...ENABLED, CAREER_OPS_WEB_SESSION_TTL_SECONDS: "-5" });
  assert.equal(c3.enabled && c3.ok && c3.ttlSeconds, DEFAULT_SESSION_TTL_SECONDS);
});

// --- safeNextPath ---------------------------------------------------------

test("safeNextPath keeps same-site paths with query strings", () => {
  assert.equal(safeNextPath("/pipeline"), "/pipeline");
  assert.equal(safeNextPath("/jobs?tab=open"), "/jobs?tab=open");
});

test("safeNextPath refuses anything that could leave the origin or loop to /login", () => {
  for (const bad of [undefined, "", "pipeline", "//evil.com", "/\\evil.com", "https://evil.com", "/a\\b", "/x\n", "/login", "/login?next=/", "/login/x", 42]) {
    assert.equal(safeNextPath(bad), "/", `expected "/" for ${JSON.stringify(bad)}`);
  }
});

// --- isPublicPath ---------------------------------------------------------

test("isPublicPath covers only the sign-in surface", () => {
  for (const p of ["/login", "/api/auth/login", "/api/auth/logout", "/icon.svg"]) assert.equal(isPublicPath(p), true, p);
  for (const p of ["/", "/pipeline", "/api/tracker", "/api/auth", "/login2", "/api/auth/login/x"]) assert.equal(isPublicPath(p), false, p);
});

// --- cookies --------------------------------------------------------------

test("isSecureRequest follows X-Forwarded-Proto, then protocol, and can be forced", () => {
  assert.equal(isSecureRequest({ forwardedProto: "https", protocol: "http:" }), true);
  assert.equal(isSecureRequest({ forwardedProto: "http", protocol: "https:" }), false);
  assert.equal(isSecureRequest({ forwardedProto: "https, http", protocol: "http:" }), true);
  assert.equal(isSecureRequest({ protocol: "https:" }), true);
  assert.equal(isSecureRequest({ protocol: "http:" }), false);
  assert.equal(isSecureRequest({ protocol: "http:", force: "1" }), true);
});

test("sessionCookieOptions is HttpOnly, SameSite=Strict, site-wide", () => {
  assert.deepEqual(sessionCookieOptions({ secure: true, maxAge: 10 }), {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: 10,
  });
  assert.equal(AUTH_COOKIE, "co_session");
});

// --- tokens ---------------------------------------------------------------

test("a freshly issued token verifies with the same secret", async () => {
  const token = await createSessionToken({ secret: SECRET, ttlSeconds: 60 });
  assert.equal(await verifySessionToken({ token, secret: SECRET }), true);
});

test("a token fails with another secret, after expiry, or when tampered", async () => {
  const now = Date.UTC(2026, 10, 3);
  const token = await createSessionToken({ secret: SECRET, ttlSeconds: 60, now });
  assert.equal(await verifySessionToken({ token, secret: "t".repeat(40), now }), false);
  assert.equal(await verifySessionToken({ token, secret: SECRET, now: now + 61_000 }), false);
  const [payload, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ v: 1, iat: 0, exp: 9_999_999_999, n: "x" })).toString("base64url");
  assert.equal(await verifySessionToken({ token: `${forged}.${sig}`, secret: SECRET, now }), false);
  const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
  assert.equal(await verifySessionToken({ token: `${payload}.${flipped}`, secret: SECRET, now }), false);
});

test("a token issued in the future is refused", async () => {
  const now = Date.UTC(2026, 10, 3);
  const token = await createSessionToken({ secret: SECRET, ttlSeconds: 3600, now: now + 10 * 60_000 });
  assert.equal(await verifySessionToken({ token, secret: SECRET, now }), false);
});

test("malformed tokens never verify and never throw", async () => {
  for (const t of [null, undefined, 1, "", "abc", "a.b.c", ".", "a.", ".b", "!!!.???", "x".repeat(2000)]) {
    assert.equal(await verifySessionToken({ token: t, secret: SECRET }), false);
  }
});

// --- decideAuth -----------------------------------------------------------

test("decideAuth is a no-op when the gate is off, and /login bounces home", async () => {
  const config = readAuthConfig({});
  for (const pathname of ["/", "/pipeline", "/api/tracker", "/api/auth/login"]) {
    assert.deepEqual(await decideAuth({ config, pathname }), { action: "next" });
  }
  assert.deepEqual(await decideAuth({ config, pathname: "/login" }), { action: "redirect", location: "/" });
});

test("decideAuth answers 503 everywhere when misconfigured (fails closed)", async () => {
  const config = readAuthConfig({ CAREER_OPS_WEB_PASSWORD_HASH: "scrypt:x" });
  for (const pathname of ["/", "/api/tracker", "/login", "/api/auth/login"]) {
    const d = await decideAuth({ config, pathname });
    assert.equal(d.action, "deny");
    assert.equal(d.action === "deny" && d.status, 503);
  }
});

test("decideAuth: without a session, pages redirect to /login with next, /api gets 401", async () => {
  const config = readAuthConfig(ENABLED);
  assert.deepEqual(await decideAuth({ config, pathname: "/pipeline", search: "?x=1" }), {
    action: "redirect",
    location: "/login?next=%2Fpipeline%3Fx%3D1",
  });
  assert.deepEqual(await decideAuth({ config, pathname: "/" }), { action: "redirect", location: "/login" });
  const api = await decideAuth({ config, pathname: "/api/tracker", token: "garbage" });
  assert.equal(api.action, "deny");
  assert.equal(api.action === "deny" && api.status, 401);
  assert.deepEqual(await decideAuth({ config, pathname: "/login" }), { action: "next" });
  assert.deepEqual(await decideAuth({ config, pathname: "/api/auth/login" }), { action: "next" });
});

test("decideAuth: with a valid session everything passes and /login bounces home", async () => {
  const config = readAuthConfig(ENABLED);
  const token = await createSessionToken({ secret: SECRET, ttlSeconds: 60 });
  assert.deepEqual(await decideAuth({ config, pathname: "/pipeline", token }), { action: "next" });
  assert.deepEqual(await decideAuth({ config, pathname: "/api/tracker", token }), { action: "next" });
  assert.deepEqual(await decideAuth({ config, pathname: "/login", token }), { action: "redirect", location: "/" });
});
