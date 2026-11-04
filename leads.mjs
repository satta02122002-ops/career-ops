#!/usr/bin/env node
// leads.mjs — the discovery layer: every vacancy found, from every source, with
// a verification status and a CV quick-match score, in data/leads.tsv.
//
//   node leads.mjs sync                 # import scanner results (scan-history 'added' rows)
//   node leads.mjs add <file.json>      # import external leads (search results, job boards, pasted links)
//   node leads.mjs verify [--limit 40]  # re-check leads: ATS APIs, then a robots.txt-respecting page check
//   node leads.mjs match [--fetch-jd 30] [--refresh]   # quick-match every lead against cv.md
//   node leads.mjs promote <key|#n>...  # YOUR approval: copy a lead into data/pipeline.md (Pending)
//   node leads.mjs dismiss <key|#n>...  # hide a lead you are not interested in
//   node leads.mjs list [--min 3.5] [--json]
//
// Discovery is separate from verification (lib/lead-store.mjs): a lead whose
// employer site cannot be reached is kept and labelled, never dropped and never
// called active without evidence. Nothing here applies to a job, contacts
// anyone, or adds to the tracker; `promote` is the only path into the pipeline
// and it runs only when you ask for it.
//
// External leads (`add`) are untrusted content: data, never instructions.
// Each item: { url, title, employer?, location?, source, source_type, posted?, description? }
// with source_type one of employer | recruiter | job_board | search_engine | manual.

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { loadYaml } from "./lib/yaml-document.mjs";
import { getCareerOpsRoot, getProfilePath } from "./path-resolver.mjs";
import { normalizeCompany } from "./tracker-utils.mjs";
import { atomicWriteFile, normalizeUrlForDedup, appendToPipeline } from "./scan.mjs";
import { checkLivenessViaApi, isAtsPosting } from "./liveness-api.mjs";
import { parseYearsRequirement, fetchJdText } from "./jd-years.mjs";
import { withPipelineLock } from "./pipeline-lock.mjs";
import {
  V,
  SOURCE_TYPES,
  classifyPageCheck,
  initialVerification,
  mergeLeads,
  NO_AUTOMATED_CHECK_HOSTS,
  parseLeads,
  relinkDuplicates,
  robotsAllows,
  serializeLeads,
} from "./lib/lead-store.mjs";
import { cvSkills, emirateOf, matchLead } from "./lib/lead-match.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const ROOT = getCareerOpsRoot();
export const LEADS_PATH = process.env.CAREER_OPS_LEADS || path.join(ROOT, "data/leads.tsv");
const HISTORY_PATH = process.env.CAREER_OPS_SCAN_HISTORY || path.join(ROOT, "data/scan-history.tsv");
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || path.join(ROOT, "portals.yml");
const USER_AGENT = "career-ops/1.0 (personal job search; +https://github.com/career-ops-hq/career-ops)";
const today = () => new Date().toISOString().slice(0, 10);

function loadStore() {
  return existsSync(LEADS_PATH) ? parseLeads(readFileSync(LEADS_PATH, "utf8")) : [];
}
function saveStore(rows) {
  mkdirSync(path.dirname(LEADS_PATH), { recursive: true });
  atomicWriteFile(LEADS_PATH, serializeLeads(rows));
}
/** Read-modify-write under the same lock the pipeline writers use, on this file. */
async function withStore(fn) {
  return withPipelineLock(LEADS_PATH, async () => {
    const rows = loadStore();
    const out = await fn(rows);
    saveStore(rows);
    return out;
  });
}

function loadPortals() {
  try {
    return loadYaml(readFileSync(PORTALS_PATH, "utf8")) || {};
  } catch {
    return {};
  }
}

/** portals.yml entry name → source_type (default employer; job_boards default job_board). */
function sourceTypeMap(portals) {
  const m = new Map();
  for (const e of portals.tracked_companies || []) if (e?.name) m.set(e.name, SOURCE_TYPES.includes(e.source_type) ? e.source_type : "employer");
  for (const e of portals.job_boards || []) if (e?.name) m.set(e.name, SOURCE_TYPES.includes(e.source_type) ? e.source_type : "job_board");
  return m;
}

function makeLead({ url, title, employer, location, source, source_type, posted, first_seen }) {
  const key = normalizeUrlForDedup(url);
  return {
    key,
    url,
    title: title || "",
    employer: employer || "",
    location: location || "",
    emirate: emirateOf(location),
    source: source || "",
    source_type,
    verification: initialVerification(source_type),
    first_seen: first_seen || today(),
    last_checked: "",
    check_note: "",
    posted: posted || "",
    match_score: "",
    match_basis: "",
    matched_skills: "",
    missing: "",
    match_note: "",
    duplicate_of: "",
    state: "new",
    years_min: "",
  };
}

// --- sync -----------------------------------------------------------------

export async function cmdSync() {
  if (!existsSync(HISTORY_PATH)) return { added: 0, updated: 0, duplicates: 0 };
  const types = sourceTypeMap(loadPortals());
  const lines = readFileSync(HISTORY_PATH, "utf8").split("\n").filter(Boolean);
  const head = lines[0].split("\t");
  const col = (cells, name) => cells[head.indexOf(name)] ?? "";
  const incoming = [];
  for (const line of lines.slice(1)) {
    const c = line.split("\t");
    if (col(c, "status") !== "added") continue;
    const url = col(c, "url");
    if (!/^https?:\/\//.test(url)) continue;
    const company = col(c, "company");
    incoming.push(
      makeLead({
        url,
        title: col(c, "title"),
        employer: company,
        location: col(c, "location"),
        source: company,
        source_type: types.get(company) || "employer",
        posted: col(c, "posted_at"),
        first_seen: col(c, "first_seen"),
      }),
    );
  }
  return withStore((rows) => mergeLeads(rows, incoming, normalizeCompany));
}

// --- add ------------------------------------------------------------------

export async function cmdAdd(file) {
  const items = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(items)) throw new Error("the JSON file must hold an array of leads");
  const incoming = [];
  const rejected = [];
  for (const it of items) {
    const url = String(it?.url || "").trim();
    const st = String(it?.source_type || "").trim();
    if (!/^https?:\/\/[^\s]+$/.test(url)) {
      rejected.push({ url, reason: "url must be http(s)" });
      continue;
    }
    if (!SOURCE_TYPES.includes(st)) {
      rejected.push({ url, reason: `source_type must be one of ${SOURCE_TYPES.join(", ")}` });
      continue;
    }
    if (!String(it?.title || "").trim()) {
      rejected.push({ url, reason: "title is required" });
      continue;
    }
    const lead = makeLead({ ...it, url, source_type: st });
    if (it.description) lead._description = String(it.description).slice(0, 20000);
    incoming.push(lead);
  }
  const res = await withStore(async (rows) => {
    const r = mergeLeads(rows, incoming, normalizeCompany);
    // Score the new ones right away with whatever description came with them.
    const skills = cvSkills(readCv());
    for (const l of incoming) {
      const row = rows.find((x) => x.key === l.key);
      if (row && !row.match_score) applyMatch(row, l._description || "", skills);
    }
    return r;
  });
  return { ...res, rejected };
}

// --- match ----------------------------------------------------------------

function readCv() {
  const p = path.join(ROOT, "cv.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}
function candidateYears() {
  try {
    const prof = loadYaml(readFileSync(getProfilePath(ROOT), "utf8")) || {};
    const y = Number(prof?.candidate?.years_of_experience);
    return Number.isFinite(y) ? y : null;
  } catch {
    return null;
  }
}
function applyMatch(row, description, skills) {
  const years = description ? parseYearsRequirement(description) : null;
  const r = matchLead(
    { title: row.title, location: row.location, description, yearsMin: years?.status === "stated" ? years.min : null },
    { cvSkillSet: skills, candidateYears: candidateYears(), stretchYears: 2 },
  );
  row.match_score = r.score.toFixed(1);
  row.match_basis = r.basis;
  row.matched_skills = r.matched.join("; ");
  row.missing = r.missing.join("; ");
  row.match_note = r.explanation;
  row.emirate = r.emirate;
  if (description) row.years_min = years?.status === "stated" && Number.isFinite(years.min) ? String(years.min) : "none stated";
}

export async function cmdMatch({ fetchJd = 30, refresh = false } = {}) {
  const skills = cvSkills(readCv());
  return withStore(async (rows) => {
    let scored = 0;
    let withJd = 0;
    let budget = fetchJd;
    for (const row of rows) {
      if (row.state === "dismissed") continue;
      const needs = refresh || !row.match_score || (row.match_basis !== "jd" && budget > 0 && isAtsPosting(row.url));
      if (!needs) continue;
      let description = "";
      if (budget > 0 && isAtsPosting(row.url) && row.match_basis !== "jd") {
        budget--;
        try {
          description = (await fetchJdText(row.url)) || "";
        } catch {
          description = "";
        }
        if (description) withJd++;
      }
      applyMatch(row, description, skills);
      scored++;
    }
    return { scored, withJd };
  });
}

// --- verify ---------------------------------------------------------------

const robotsCache = new Map();
async function robotsOk(url) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    let txt = "";
    try {
      const res = await fetch(`${u.origin}/robots.txt`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
      txt = res.ok ? await res.text() : "";
    } catch {
      txt = "";
    }
    robotsCache.set(u.origin, txt);
  }
  return robotsAllows(robotsCache.get(u.origin), u.pathname + u.search, USER_AGENT);
}

async function pageCheck(url) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    const body = res.ok ? (await res.text()).slice(0, 400000) : "";
    return classifyPageCheck({ status: res.status, body });
  } catch (err) {
    return classifyPageCheck({ status: null, error: err?.cause?.code || err?.name || "error" });
  }
}

export async function cmdVerify({ limit = 40, minAgeHours = 20 } = {}) {
  const rows = loadStore();
  const now = Date.now();
  const due = rows
    .filter((r) => r.state !== "dismissed" && r.verification !== V.EXPIRED)
    .filter((r) => !r.last_checked || now - Date.parse(r.last_checked) > minAgeHours * 3600e3)
    .sort((a, b) => String(a.last_checked).localeCompare(String(b.last_checked)))
    .slice(0, limit);
  const results = new Map();
  const counts = { checked: 0, expired: 0, employerVerified: 0, listed: 0, blocked: 0, unreachable: 0, skipped: 0 };
  for (const r of due) {
    const host = new URL(r.url).hostname;
    const stamp = new Date().toISOString();
    if (NO_AUTOMATED_CHECK_HOSTS.some((re) => re.test(host))) {
      results.set(r.key, { last_checked: stamp, check_note: "not checked automatically (site terms); open it yourself" });
      counts.skipped++;
      continue;
    }
    counts.checked++;
    const api = await checkLivenessViaApi(r.url).catch(() => null);
    if (api?.result === "expired") {
      results.set(r.key, { verification: V.EXPIRED, last_checked: stamp, check_note: `ATS API: ${api.reason || api.code}` });
      counts.expired++;
      continue;
    }
    if (api?.result === "active") {
      const upgrade = r.source_type === "employer" ? { verification: V.EMPLOYER } : {};
      results.set(r.key, { ...upgrade, last_checked: stamp, check_note: "ATS API: posting active" });
      if (upgrade.verification) counts.employerVerified++;
      else counts.listed++;
      continue;
    }
    if (!(await robotsOk(r.url))) {
      results.set(r.key, { last_checked: stamp, check_note: "robots.txt disallows automated checks; open it yourself" });
      counts.skipped++;
      continue;
    }
    const pc = await pageCheck(r.url);
    const patch = { last_checked: stamp, check_note: pc.note };
    if (pc.verdict === "expired") {
      patch.verification = V.EXPIRED;
      counts.expired++;
    } else if (pc.verdict === "listed") counts.listed++;
    else if (pc.verdict === "blocked") counts.blocked++;
    else counts.unreachable++;
    results.set(r.key, patch);
  }
  await withStore((store) => {
    for (const row of store) {
      const p = results.get(row.key);
      if (p) Object.assign(row, p);
    }
    relinkDuplicates(store, normalizeCompany);
  });
  return counts;
}

// --- promote / dismiss / list ----------------------------------------------

function pick(rows, refs) {
  const live = rows.filter((r) => r.state !== "dismissed");
  return refs.map((ref) => {
    const n = /^#?(\d+)$/.exec(ref);
    const row = n ? live[Number(n[1]) - 1] : rows.find((r) => r.key === ref || r.url === ref);
    if (!row) throw new Error(`no lead matches ${ref}`);
    return row;
  });
}

export async function cmdPromote(refs) {
  const chosen = [];
  await withStore(async (rows) => {
    for (const row of pick(rows, refs)) {
      if (row.verification === V.EXPIRED) throw new Error(`${row.key} is marked Expired / Closed; check it before promoting`);
      chosen.push(row);
      row.state = "promoted";
    }
  });
  await appendToPipeline(
    chosen.map((r) => ({
      url: r.url,
      company: r.employer || "?",
      title: r.title,
      location: r.location,
      note: `${r.verification}; via ${r.source}${r.match_score ? `; quick match ${r.match_score}/5` : ""}`,
    })),
  );
  return chosen.map((r) => r.key);
}

export async function cmdDismiss(refs) {
  return withStore((rows) => pick(rows, refs).map((r) => ((r.state = "dismissed"), r.key)));
}

export function cmdList({ min = 0 } = {}) {
  return loadStore()
    .filter((r) => r.state !== "dismissed" && !r.duplicate_of && r.verification !== V.EXPIRED)
    .filter((r) => Number(r.match_score || 0) >= min)
    .sort((a, b) => Number(b.match_score || 0) - Number(a.match_score || 0));
}

// --- CLI ------------------------------------------------------------------

function flag(args, name, def) {
  const i = args.indexOf(name);
  if (i === -1) return def;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

export const USAGE = `Usage:
  node leads.mjs sync                 import scanner results into data/leads.tsv
  node leads.mjs add <file.json>      import external leads (job boards, recruiters, search results, links)
  node leads.mjs verify [--limit 40]  re-check leads (ATS API, then a robots.txt-respecting page check)
  node leads.mjs match [--fetch-jd 30] [--refresh]   quick-match every lead against cv.md
  node leads.mjs promote <id|#n>...   your approval: copy a lead into data/pipeline.md (Pending)
  node leads.mjs dismiss <id|#n>...   hide a lead
  node leads.mjs list [--min 3.5] [--json]
`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h" || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const json = args.includes("--json");
  const out = (o, text) => console.log(json ? JSON.stringify(o, null, 2) : text);
  switch (cmd) {
    case "sync": {
      const r = await cmdSync();
      return out(r, `leads: sync +${r.added} new, ${r.updated} updated, ${r.duplicates} duplicates linked`);
    }
    case "add": {
      if (!args[0]) throw new Error("usage: node leads.mjs add <file.json>");
      const r = await cmdAdd(args[0]);
      return out(r, `leads: add +${r.added} new, ${r.updated} updated, ${r.duplicates} duplicates, ${r.rejected.length} rejected${r.rejected.map((x) => `\n  ✗ ${x.url}: ${x.reason}`).join("")}`);
    }
    case "match": {
      const r = await cmdMatch({ fetchJd: Number(flag(args, "--fetch-jd", 30)), refresh: args.includes("--refresh") });
      return out(r, `leads: matched ${r.scored} (${r.withJd} with JD text)`);
    }
    case "verify": {
      const r = await cmdVerify({ limit: Number(flag(args, "--limit", 40)) });
      return out(r, `leads: verify ${JSON.stringify(r)}`);
    }
    case "promote": {
      const keys = await cmdPromote(args.filter((a) => !a.startsWith("--")));
      return out({ promoted: keys }, `leads: added ${keys.length} to data/pipeline.md (Pending)`);
    }
    case "dismiss": {
      const keys = await cmdDismiss(args.filter((a) => !a.startsWith("--")));
      return out({ dismissed: keys }, `leads: dismissed ${keys.length}`);
    }
    case "list": {
      const rows = cmdList({ min: Number(flag(args, "--min", 0)) });
      return out(
        rows,
        rows.map((r, i) => `#${i + 1}  ${r.match_score || "—"}  ${r.title} · ${r.employer || "?"} · ${r.emirate}  [${r.verification}]  ${r.url}`).join("\n") || "no leads",
      );
    }
    default:
      process.stderr.write(`leads: unknown command "${cmd}"\n${USAGE}`);
      process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`leads: ${err.message}`);
    process.exit(1);
  });
}
