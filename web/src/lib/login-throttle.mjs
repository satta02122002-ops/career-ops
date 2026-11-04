// Brute-force throttle for the dashboard login (see web-auth.mjs).
//
// In-memory and per client address: after MAX_FAILURES wrong passwords inside
// WINDOW_MS, that address is locked out for LOCK_MS. A single-user dashboard runs
// as one process, so process memory is the right scope; a restart clears it.
// A global ceiling also applies, so rotating addresses cannot multiply attempts
// without bound.

export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60 * 1000;
export const LOCK_MS = 15 * 60 * 1000;
export const GLOBAL_MAX_FAILURES = 50;
const MAX_TRACKED = 5000;

export function createLoginThrottle({ now = () => Date.now() } = {}) {
  /** @type {Map<string, { fails: number, firstAt: number, lockedUntil: number }>} */
  const byKey = new Map();
  /** @type {number[]} */
  let globalFails = [];

  function prune(t) {
    globalFails = globalFails.filter((at) => t - at < WINDOW_MS);
    if (byKey.size > MAX_TRACKED) {
      for (const [k, v] of byKey) {
        if (v.lockedUntil <= t && t - v.firstAt >= WINDOW_MS) byKey.delete(k);
      }
    }
  }

  return {
    /** @param {string} key @returns {{ allowed: true } | { allowed: false, retryAfterSeconds: number }} */
    check(key) {
      const t = now();
      prune(t);
      const e = byKey.get(key);
      if (e && e.lockedUntil > t) return { allowed: false, retryAfterSeconds: Math.ceil((e.lockedUntil - t) / 1000) };
      if (globalFails.length >= GLOBAL_MAX_FAILURES) {
        const retry = Math.ceil((globalFails[0] + WINDOW_MS - t) / 1000);
        return { allowed: false, retryAfterSeconds: Math.max(retry, 1) };
      }
      return { allowed: true };
    },
    /** @param {string} key */
    recordFailure(key) {
      const t = now();
      globalFails.push(t);
      let e = byKey.get(key);
      if (!e || t - e.firstAt >= WINDOW_MS) e = { fails: 0, firstAt: t, lockedUntil: 0 };
      e.fails += 1;
      if (e.fails >= MAX_FAILURES) e.lockedUntil = t + LOCK_MS;
      byKey.set(key, e);
    },
    /** @param {string} key */
    recordSuccess(key) {
      byKey.delete(key);
    },
  };
}

/**
 * The client address for throttling. Behind Cloudflare the real client is in
 * CF-Connecting-IP; otherwise the first X-Forwarded-For hop; otherwise one
 * shared bucket (still bounded by the per-key and global limits).
 * @param {{ get(name: string): string | null }} headers
 */
export function clientKey(headers) {
  const cf = headers.get("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim();
  const xff = headers.get("x-forwarded-for");
  if (xff && xff.split(",")[0].trim()) return xff.split(",")[0].trim();
  return "local";
}
