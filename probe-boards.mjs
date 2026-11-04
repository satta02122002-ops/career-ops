#!/usr/bin/env node
// probe-boards.mjs — find the job board behind each careers page that has no
// zero-token provider yet, so it can be wired into portals.yml.
//
//   node probe-boards.mjs              # writes data/board-probes.tsv
//   node probe-boards.mjs --summary
//
// For every enabled tracked_companies entry that no provider claims (the
// "web search" entries), it fetches careers_url once, honouring robots.txt,
// and looks for the signature of an ATS career-ops can read (Workday,
// SuccessFactors, Oracle, Phenom, Avature, SmartRecruiters, Teamtailor,
// Greenhouse, Lever, iCIMS, Taleo, Eightfold, Zoho Recruit, Darwinbox, ...).
// It writes what it saw and a suggested provider; it never edits portals.yml.
// A blocked or unreachable page is reported as such, never as "no board".

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { getCareerOpsRoot } from "./path-resolver.mjs";
import { atomicWriteFile } from "./scan.mjs";
import { loadYaml } from "./lib/yaml-document.mjs";
import { robotsAllows } from "./lib/lead-store.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const ROOT = getCareerOpsRoot();
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || path.join(ROOT, "portals.yml");
export const PROBES_PATH = path.join(ROOT, "data/board-probes.tsv");
const UA = "career-ops/1.0 (personal job search; board discovery)";

/** [provider id, regex over the page HTML]. First hit wins, so order is priority. */
export const SIGNATURES = [
  ["workday", /https?:\/\/[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com\/[A-Za-z0-9_\-/]+/i],
  ["oraclecloud", /https?:\/\/[a-z0-9-]+\.fa(\.[a-z0-9]+)*\.oraclecloud\.com\/hcmUI\/CandidateExperience[^"'\s<]*/i],
  ["successfactors", /(rmkcdn\.successfactors\.com|career\d*\.successfactors\.(com|eu)[^"'\s<]*|jobs2web)/i],
  ["smartrecruiters", /https?:\/\/(careers|jobs)\.smartrecruiters\.com\/[A-Za-z0-9_-]+/i],
  ["phenom", /(cdn|assets)\.phenompeople\.com/i],
  ["avature", /([a-z0-9-]+\.avature\.net|avature\.portal)/i],
  ["eightfold", /[a-z0-9-]+\.eightfold\.ai/i],
  ["teamtailor", /teamtailor(-cdn)?\.com/i],
  ["greenhouse", /(boards|job-boards)(-api)?\.greenhouse\.io\/[A-Za-z0-9_-]+/i],
  ["lever", /jobs\.(eu\.)?lever\.co\/[A-Za-z0-9_-]+/i],
  ["icims", /[a-z0-9-]+\.icims\.com/i],
  ["taleo", /[a-z0-9-]+\.taleo\.net\/careersection/i],
  ["zoho-recruit", /[a-z0-9-]+\.zohorecruit\.(com|eu|in|sa)/i],
  ["darwinbox", /[a-z0-9-]+\.darwinbox\.in/i],
  ["radancy", /tbcdn\.talentbrew\.com/i],
  ["workable", /apply\.workable\.com\/[A-Za-z0-9_-]+/i],
  ["bamboohr", /[a-z0-9-]+\.bamboohr\.com/i],
  ["recruitee", /[a-z0-9-]+\.recruitee\.com/i],
  ["jibeapply", /jibeapply\.com/i],
];

export function detectBoard(html) {
  for (const [id, re] of SIGNATURES) {
    const m = String(html || "").match(re);
    if (m) return { provider: id, evidence: m[0].slice(0, 160) };
  }
  return null;
}

async function robotsOk(url) {
  try {
    const u = new URL(url);
    const res = await fetch(`${u.origin}/robots.txt`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10000) });
    return robotsAllows(res.ok ? await res.text() : "", u.pathname + u.search, UA);
  } catch {
    return true;
  }
}

async function probe(entry) {
  const url = entry.careers_url;
  if (!/^https?:\/\//.test(url || "")) return { status: "no careers_url" };
  if (!(await robotsOk(url))) return { status: "robots.txt disallows" };
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { status: `HTTP ${res.status}`, final: res.url };
    const html = (await res.text()).slice(0, 2_000_000);
    const hit = detectBoard(html) || detectBoard(res.url);
    return hit ? { status: "board found", final: res.url, ...hit } : { status: "no known board on page (may load by script)", final: res.url };
  } catch (err) {
    return { status: `unreachable: ${err?.cause?.code || err?.name || "error"}` };
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write("Usage:\n  node probe-boards.mjs            probe web-search-only careers pages for a known ATS → data/board-probes.tsv\n  node probe-boards.mjs --summary  print the last probe results\n");
    process.exit(0);
  }
  const portals = loadYaml(readFileSync(PORTALS_PATH, "utf8")) || {};
  const targets = (portals.tracked_companies || []).filter((e) => e && e.enabled !== false && !e.provider && e.scan_method === "websearch");
  if (process.argv.includes("--summary") && existsSync(PROBES_PATH)) {
    console.log(readFileSync(PROBES_PATH, "utf8"));
    return;
  }
  const rows = [["name", "source_type", "careers_url", "status", "provider", "evidence", "final_url", "probed_at"].join("\t")];
  const now = new Date().toISOString();
  let found = 0;
  for (const e of targets) {
    const r = await probe(e);
    if (r.provider) found++;
    rows.push([e.name, e.source_type || "employer", e.careers_url || "", r.status, r.provider || "", r.evidence || "", r.final || "", now].map((v) => String(v).replace(/[\t\r\n]+/g, " ")).join("\t"));
    await new Promise((res) => setTimeout(res, 750)); // be polite
  }
  mkdirSync(path.dirname(PROBES_PATH), { recursive: true });
  atomicWriteFile(PROBES_PATH, rows.join("\n") + "\n");
  console.log(`probe-boards: ${targets.length} pages probed, ${found} with a known board → ${PROBES_PATH}`);
}

if (isMainModule(import.meta.url)) main().catch((e) => (console.error(`probe-boards: ${e.message}`), process.exit(1)));
