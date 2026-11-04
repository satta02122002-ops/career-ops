import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from "../../src/lib/password-hash.mjs";

test("hashPassword produces the documented one-line scrypt format", async () => {
  const h = await hashPassword("correct horse battery");
  assert.match(h, /^scrypt:32768:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  assert.equal(h.includes("$"), false, "no $: shells and dotenv would expand it");
  assert.notEqual(await hashPassword("correct horse battery"), h, "salted: two hashes differ");
});

test("verifyPassword accepts the right password and rejects others", async () => {
  const h = await hashPassword("correct horse battery");
  assert.equal(await verifyPassword("correct horse battery", h), true);
  assert.equal(await verifyPassword("correct horse batterY", h), false);
  assert.equal(await verifyPassword("", h), false);
  assert.equal(await verifyPassword(undefined, h), false);
});

test("hashPassword refuses short passwords", async () => {
  await assert.rejects(hashPassword("x".repeat(MIN_PASSWORD_LENGTH - 1)));
});

test("a malformed stored hash never matches and never throws", async () => {
  for (const stored of [undefined, "", "plain", "scrypt:1:2:3", "bcrypt:a:b:c:d:e", "scrypt:3:8:1:AAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBB", "scrypt:99999999:8:1:a:b", "scrypt$32768$8$1$AAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBB"]) {
    assert.equal(await verifyPassword("correct horse battery", stored), false, String(stored));
  }
});
