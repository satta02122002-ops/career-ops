import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLoginThrottle,
  clientKey,
  MAX_FAILURES,
  LOCK_MS,
  WINDOW_MS,
  GLOBAL_MAX_FAILURES,
} from "../../src/lib/login-throttle.mjs";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("locks an address after MAX_FAILURES and releases it after LOCK_MS", () => {
  const c = clock();
  const th = createLoginThrottle({ now: c.now });
  for (let i = 0; i < MAX_FAILURES - 1; i++) th.recordFailure("1.1.1.1");
  assert.equal(th.check("1.1.1.1").allowed, true);
  th.recordFailure("1.1.1.1");
  const locked = th.check("1.1.1.1");
  assert.equal(locked.allowed, false);
  assert.equal(!locked.allowed && locked.retryAfterSeconds, LOCK_MS / 1000);
  assert.equal(th.check("2.2.2.2").allowed, true, "other addresses unaffected");
  c.advance(LOCK_MS);
  assert.equal(th.check("1.1.1.1").allowed, true);
});

test("failures spread beyond the window do not accumulate", () => {
  const c = clock();
  const th = createLoginThrottle({ now: c.now });
  for (let i = 0; i < MAX_FAILURES - 1; i++) th.recordFailure("k");
  c.advance(WINDOW_MS);
  th.recordFailure("k");
  assert.equal(th.check("k").allowed, true);
});

test("a success clears the address's failures", () => {
  const th = createLoginThrottle();
  for (let i = 0; i < MAX_FAILURES - 1; i++) th.recordFailure("k");
  th.recordSuccess("k");
  th.recordFailure("k");
  assert.equal(th.check("k").allowed, true);
});

test("a global ceiling stops rotating addresses", () => {
  const th = createLoginThrottle({ now: clock().now });
  for (let i = 0; i < GLOBAL_MAX_FAILURES; i++) th.recordFailure(`ip-${i}`);
  assert.equal(th.check("fresh-ip").allowed, false);
});

test("clientKey prefers CF-Connecting-IP, then the first X-Forwarded-For hop", () => {
  const h = (o) => ({ get: (n) => o[n] ?? null });
  assert.equal(clientKey(h({ "cf-connecting-ip": " 5.6.7.8 ", "x-forwarded-for": "1.2.3.4" })), "5.6.7.8");
  assert.equal(clientKey(h({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" })), "1.2.3.4");
  assert.equal(clientKey(h({})), "local");
});
