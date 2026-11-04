// scrypt password hashing for the optional dashboard login (see web-auth.mjs).
//
// Stored form, one line, safe to put in an env var:
//   scrypt:<N>:<r>:<p>:<salt base64url>:<hash base64url>
// Colon-separated on purpose: a "$" would be expanded by shells and by the
// dotenv loader Next.js uses for .env files, silently corrupting the hash.
// Only the login route (Node runtime) and scripts/hash-password.mjs import this.

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 1 << 15;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const MAXMEM = 128 * 1024 * 1024;
export const MIN_PASSWORD_LENGTH = 12;

/** @returns {Promise<Buffer>} */
function derive(password, salt, n, r, p, keyLen) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLen, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** @param {string} password */
export async function hashPassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEY_LEN);
  return `scrypt:${N}:${R}:${P}:${salt.toString("base64url")}:${key.toString("base64url")}`;
}

/**
 * Constant-time check of a password against a stored hash. A malformed stored
 * hash never matches (and never throws), so a bad env value locks everyone out
 * rather than letting anyone in.
 * @param {unknown} password
 * @param {unknown} stored
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== "string" || password === "" || password.length > 1024) return false;
  if (typeof stored !== "string") return false;
  const parts = stored.trim().split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0)) return false;
  if (n > 1 << 20 || (n & (n - 1)) !== 0 || r > 32 || p > 16) return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (salt.length < 8 || expected.length < 16) return false;
  let actual;
  try {
    actual = await derive(password, salt, n, r, p, expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
