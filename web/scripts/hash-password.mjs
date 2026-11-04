#!/usr/bin/env node
// Generate the env values that turn on the optional dashboard login.
//
//   npm run auth:hash              # prompts for the password (input hidden)
//   printf '%s' "$PW" | npm run auth:hash --silent
//
// Prints two lines for the server's environment (e.g. a systemd EnvironmentFile
// or web/.env.local):
//   CAREER_OPS_WEB_PASSWORD_HASH=scrypt:...
//   CAREER_OPS_WEB_SESSION_SECRET=<random 48 bytes, base64url>
// The password itself is never printed or stored.

import { randomBytes } from "node:crypto";
import { hashPassword, MIN_PASSWORD_LENGTH } from "../src/lib/password-hash.mjs";

async function readHidden(prompt) {
  const { stdin, stderr } = process;
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stderr.write("\n");
          return resolve(value);
        }
        if (c === "\u0003") {
          stdin.setRawMode(false);
          stderr.write("\n");
          return reject(new Error("cancelled"));
        }
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function readPiped() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
}

try {
  let password;
  if (process.stdin.isTTY) {
    password = await readHidden(`Dashboard password (min ${MIN_PASSWORD_LENGTH} characters): `);
    const again = await readHidden("Repeat password: ");
    if (password !== again) throw new Error("passwords do not match");
  } else {
    password = await readPiped();
  }
  const hash = await hashPassword(password);
  process.stdout.write(`CAREER_OPS_WEB_PASSWORD_HASH=${hash}\n`);
  process.stdout.write(`CAREER_OPS_WEB_SESSION_SECRET=${randomBytes(48).toString("base64url")}\n`);
} catch (err) {
  process.stderr.write(`auth:hash: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
