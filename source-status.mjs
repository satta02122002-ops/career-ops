#!/usr/bin/env node
// source-status.mjs — one row per discovery source in data/source-status.tsv:
// what kind of source it is, how it is read, whether the last run actually read
// it, when it last succeeded, how many jobs it returned, and the error.
//
//   node scan.mjs --json > receipt.json
//   node source-status.mjs receipt.json        # merge this run into the status file
//   node source-status.mjs --summary           # print the current table
//
// A source counts as scanned only when its board answered. An entry with no
// zero-token provider is "not_scanned (search only)", never "ok". Job boards
// that may not be scraped (Bayt, GulfTalent, Naukrigulf, LinkedIn, Indeed) and
// search engines are listed as "search_only": their leads come in through
// `leads.mjs add`, and the row counts those leads.

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { getCareerOpsRoot } from "./path-resolver.mjs";
import { atomicWriteFile } from "./scan.mjs";
import { loadYaml } from "./lib/yaml-document.mjs";
import { parseLeads } from "./lib/lead-store.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const ROOT = getCareerOpsRoot();
export const STATUS_PATH = process.env.CAREER_OPS_SOURCE_STATUS || path.join(ROOT, "data/source-status.tsv");
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || path.join(ROOT, "portals.yml");
const LEADS_PATH = process.env.CAREER_OPS_LEADS || path.join(ROOT, "data/leads.tsv");

export const COLUMNS = ["source", "type", "method", "status", "last_attempt", "last_success", "found_last", "added_last", "leads_total", "error"];

/** Platforms read only through search results or links you paste, by design. */
export const SEARCH_ONLY_SOURCES = [
  { source: "Google Search", type: "search_engine", hosts: [] },
  { source: "Bayt", type: "job_board", hosts: ["bayt.com"] },
  { source: "GulfTalent", type: "job_board", hosts: ["gulftalent.com"] },
  { source: "Naukrigulf", type: "job_board", hosts: ["naukrigulf.com"] },
  { source: "LinkedIn", type: "job_board", hosts: ["linkedin.com"] },
  { source: "Indeed UAE", type: "job_board", hosts: ["indeed.com"] },
];

// scan.mjs portal-health vocabulary → status shown here.
const STATUS_OF = {
  reachable: "ok",
  empty: "ok (0 jobs)",
  unverified_zero: "error: 0 jobs, no successful response",
  network: "error: network / blocked",
  auth: "error: refused (401/403)",
  server: "error: server (5xx)",
  slug_gone: "error: board gone (404)",
  unknown: "error",
};

const clean = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ").trim();

export function parseStatus(text) {
  const lines = String(text || "").split("\n").filter(Boolean);
  if (!lines.length) return [];
  const head = lines[0].split("\t");
  return lines.slice(1).map((l) => {
    const c = l.split("\t");
    return Object.fromEntries(COLUMNS.map((k) => [k, c[head.indexOf(k)] ?? ""]));
  });
}

/**
 * Pure merge of one scan receipt into the previous status rows.
 * @param {{ prev: Record<string,string>[], receipt: any, portals: any, leads: Record<string,string>[], now: string }} p
 */
export function buildStatus({ prev, receipt, portals, leads, now }) {
  const byName = new Map(prev.map((r) => [r.source, r]));
  const out = new Map();
  const typeOf = new Map();
  for (const e of portals?.tracked_companies || []) if (e?.name) typeOf.set(e.name, e.source_type || "employer");
  for (const e of portals?.job_boards || []) if (e?.name) typeOf.set(e.name, e.source_type || "job_board");
  const leadsBySource = new Map();
  for (const l of leads) leadsBySource.set(l.source, (leadsBySource.get(l.source) || 0) + 1);
  const errors = new Map((receipt?.errors || []).map((e) => [e.company, e.error]));

  const row = (source, patch) => {
    const old = byName.get(source) || {};
    const r = {
      source,
      type: patch.type ?? old.type ?? "employer",
      method: patch.method ?? old.method ?? "",
      status: patch.status ?? old.status ?? "",
      last_attempt: patch.last_attempt ?? old.last_attempt ?? "",
      last_success: patch.ok ? now : old.last_success ?? "",
      found_last: patch.found_last ?? old.found_last ?? "",
      added_last: patch.added_last ?? old.added_last ?? "",
      leads_total: String(leadsBySource.get(source) || 0),
      error: patch.error ?? "",
    };
    out.set(source, r);
  };

  if (receipt) {
    for (const s of receipt.sources || []) {
      const status = STATUS_OF[s.status] || (s.status ? `error: ${s.status}` : "error");
      row(s.name, {
        type: typeOf.get(s.name) || (s.board ? "job_board" : "employer"),
        method: s.provider || "",
        status,
        last_attempt: now,
        ok: status.startsWith("ok"),
        found_last: s.found == null ? "" : String(s.found),
        added_last: String(s.added ?? 0),
        error: status.startsWith("ok") ? "" : clean(errors.get(s.name) || ""),
      });
    }
    for (const n of receipt.not_scanned || []) {
      row(n.name, {
        type: typeOf.get(n.name) || "employer",
        method: n.method === "websearch" ? "web search (manual)" : "none",
        status: n.reason === "config_error" ? "error: config" : "not_scanned (search only)",
        last_attempt: now,
        ok: false,
        found_last: "",
        added_last: "",
        error: clean(n.error || (n.reason === "no_provider" ? "no direct board connected" : "")),
      });
    }
  }
  // Carry forward rows this run did not mention (e.g. disabled now).
  for (const r of prev) if (!out.has(r.source)) out.set(r.source, { ...r, leads_total: String(leadsBySource.get(r.source) || 0) });
  // Search-only platforms are always listed, with the leads they contributed.
  for (const s of SEARCH_ONLY_SOURCES) {
    const count = leads.filter((l) => l.source === s.source || s.hosts.some((h) => safeHost(l.url).endsWith(h))).length;
    out.set(s.source, {
      ...(out.get(s.source) || {}),
      source: s.source,
      type: s.type,
      method: "search results / pasted links",
      status: "search_only",
      last_attempt: out.get(s.source)?.last_attempt || "",
      last_success: out.get(s.source)?.last_success || "",
      found_last: "",
      added_last: "",
      leads_total: String(count),
      error: "not scraped (site terms); leads via search or your links",
    });
  }
  // Sources that only appear in leads (recruiters found by search, etc.).
  for (const [src, n] of leadsBySource) {
    if (src && !out.has(src)) out.set(src, { source: src, type: "", method: "leads only", status: "leads only", last_attempt: "", last_success: "", found_last: "", added_last: "", leads_total: String(n), error: "" });
  }
  return [...out.values()];
}

function safeHost(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function serializeStatus(rows) {
  const order = (r) => (r.status === "search_only" ? 2 : r.status.startsWith("ok") ? 0 : 1);
  const sorted = [...rows].sort((a, b) => order(a) - order(b) || a.source.localeCompare(b.source));
  return [COLUMNS.join("\t"), ...sorted.map((r) => COLUMNS.map((c) => clean(r[c])).join("\t"))].join("\n") + "\n";
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage:\n  node source-status.mjs <scan-receipt.json>   merge a scan.mjs --json receipt into data/source-status.tsv\n  node source-status.mjs --summary              print the current per-source table\n");
    process.exit(0);
  }
  const prev = existsSync(STATUS_PATH) ? parseStatus(readFileSync(STATUS_PATH, "utf8")) : [];
  if (args.includes("--summary")) {
    const rows = prev;
    const ok = rows.filter((r) => r.status.startsWith("ok")).length;
    const err = rows.filter((r) => r.status.startsWith("error")).length;
    const ns = rows.filter((r) => r.status.startsWith("not_scanned")).length;
    console.log(`sources: ${rows.length} · scanned ok ${ok} · errors ${err} · not scanned ${ns}`);
    for (const r of rows) console.log(`  ${r.status.padEnd(28)} ${r.source.padEnd(32)} found ${r.found_last || "-"} · leads ${r.leads_total} ${r.error ? "· " + r.error : ""}`);
    return;
  }
  const receiptPath = args.find((a) => !a.startsWith("--"));
  let receipt = null;
  if (receiptPath) {
    const raw = readFileSync(receiptPath, "utf8");
    // scan.mjs --json prints one receipt; tolerate log lines around it.
    const start = raw.indexOf("{");
    receipt = JSON.parse(raw.slice(start, raw.lastIndexOf("}") + 1));
  }
  const portals = existsSync(PORTALS_PATH) ? loadYaml(readFileSync(PORTALS_PATH, "utf8")) || {} : {};
  const leads = existsSync(LEADS_PATH) ? parseLeads(readFileSync(LEADS_PATH, "utf8")) : [];
  const rows = buildStatus({ prev, receipt, portals, leads, now: new Date().toISOString() });
  mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
  atomicWriteFile(STATUS_PATH, serializeStatus(rows));
  console.log(`source-status: ${rows.length} sources written to ${STATUS_PATH}`);
}

if (isMainModule(import.meta.url)) main();
