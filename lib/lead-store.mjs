// Pure logic for data/leads.tsv, the discovery layer (see leads.mjs).
//
// Discovery is separate from verification: a lead found on a job board, a
// recruiter site or a search engine is KEPT, with a verification status that
// says how much evidence stands behind it, instead of being dropped because the
// employer's own careers site could not be checked. Nothing here invents a
// listing or calls one active without evidence:
//
//   Employer Verified         seen on the employer's own careers site / ATS, or
//                             cross-checked against a lead from one
//   Recruiter Listed          on a recruitment agency's own site
//   Job Board Listed          on a job board (Bayt, GulfTalent, Indeed, ...)
//   Search Engine Discovered  only seen in search results
//   Verification Pending      not yet checked, or the last check was blocked
//   Expired / Closed          the posting itself says closed, or 404/410
//
// Pure: no I/O. leads.mjs does the file and network work.

export const V = Object.freeze({
  EMPLOYER: "Employer Verified",
  RECRUITER: "Recruiter Listed",
  JOB_BOARD: "Job Board Listed",
  SEARCH: "Search Engine Discovered",
  PENDING: "Verification Pending",
  EXPIRED: "Expired / Closed",
});
export const VERIFICATION_STATUSES = Object.values(V);

// Higher = more evidence. Used to pick which of several duplicate listings is
// the primary one shown on the dashboard.
const RANK = { [V.EMPLOYER]: 5, [V.RECRUITER]: 4, [V.JOB_BOARD]: 3, [V.SEARCH]: 2, [V.PENDING]: 1, [V.EXPIRED]: 0 };
export const verificationRank = (v) => RANK[v] ?? 0;

export const SOURCE_TYPES = ["employer", "recruiter", "job_board", "search_engine", "manual"];

/** Status a lead starts with, from where it was found. */
export function initialVerification(sourceType) {
  return (
    {
      employer: V.EMPLOYER,
      recruiter: V.RECRUITER,
      job_board: V.JOB_BOARD,
      search_engine: V.SEARCH,
    }[sourceType] ?? V.PENDING
  );
}

export const COLUMNS = [
  "key",
  "url",
  "title",
  "employer",
  "location",
  "emirate",
  "source",
  "source_type",
  "verification",
  "first_seen",
  "last_checked",
  "check_note",
  "posted",
  "match_score",
  "match_basis",
  "matched_skills",
  "missing",
  "match_note",
  "duplicate_of",
  "state",
  // Appended later; readers look columns up by header name.
  "years_min",
];

const clean = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ").trim();

/** @param {string} text */
export function parseLeads(text) {
  const lines = String(text || "").split("\n").filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split("\t");
  return lines.slice(1).map((l) => {
    const cells = l.split("\t");
    const row = {};
    for (const c of COLUMNS) row[c] = cells[head.indexOf(c)] ?? "";
    return row;
  });
}

/** @param {Record<string, unknown>[]} rows */
export function serializeLeads(rows) {
  return [COLUMNS.join("\t"), ...rows.map((r) => COLUMNS.map((c) => clean(r[c])).join("\t"))].join("\n") + "\n";
}

const TITLE_NOISE = /\b(urgent(ly)?|hiring|walk[- ]?in( interviews?)?|immediate( joiner)?|vacancy|job|jobs|opening|required|needed|wanted|new)\b/g;

/** Title normalized for cross-source duplicate detection. */
export function normalizeTitle(title) {
  const norm = (s) =>
    s
      .replace(TITLE_NOISE, " ")
      .replace(/\bsr\b\.?/g, "senior")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  // "Title - Dubai" / "Title | Company": keep the first part that still says
  // something once hiring noise is gone ("Walk-in Interviews | Warehouse
  // Associate" is the second part).
  const parts = String(title || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .split(/\s[-|–—:]\s|:\s/);
  for (const p of parts) {
    const n = norm(p);
    if (n) return n;
  }
  return "";
}

/**
 * Identity of a vacancy across sources: employer + normalized title + emirate.
 * An unknown employer ("?", "confidential", empty) has no identity, so a
 * recruiter's confidential listing is never merged into a named employer's.
 */
export function leadIdentity({ employer, title, emirate }, normalizeCompany) {
  const e = String(employer || "").trim();
  if (!e || e === "?" || /^confidential\b/i.test(e) || /^(a |an )?(leading|reputed|well[- ]known)\b/i.test(e)) return null;
  const t = normalizeTitle(title);
  if (!t) return null;
  return `${normalizeCompany(e)}|${t}|${emirate || ""}`;
}

/**
 * Merge new leads into the existing store. Same key (normalized URL) updates
 * the existing row; same identity under a different URL is a duplicate, and the
 * listing with the most evidence becomes the primary. Returns counts.
 * @param {Record<string,string>[]} store mutated in place
 * @param {Record<string,string>[]} incoming
 * @param {(name: string) => string} normalizeCompany
 */
export function mergeLeads(store, incoming, normalizeCompany) {
  const byKey = new Map(store.map((r) => [r.key, r]));
  let added = 0;
  let updated = 0;
  let duplicates = 0;
  for (const lead of incoming) {
    const existing = byKey.get(lead.key);
    if (existing) {
      // Keep the stronger verification and fill blanks; never downgrade.
      if (verificationRank(lead.verification) > verificationRank(existing.verification) && existing.verification !== V.EXPIRED) {
        existing.verification = lead.verification;
      }
      for (const c of ["title", "employer", "location", "emirate", "posted"]) if (!existing[c] && lead[c]) existing[c] = lead[c];
      updated++;
      continue;
    }
    store.push(lead);
    byKey.set(lead.key, lead);
    added++;
  }
  duplicates = relinkDuplicates(store, normalizeCompany);
  return { added, updated, duplicates };
}

/** Recompute duplicate_of across the whole store. Returns the duplicate count. */
export function relinkDuplicates(store, normalizeCompany) {
  const groups = new Map();
  for (const r of store) {
    r.duplicate_of = "";
    if (r.state === "dismissed") continue;
    const id = leadIdentity(r, normalizeCompany);
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }
  let dupes = 0;
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const live = rows.filter((r) => r.verification !== V.EXPIRED);
    const pool = live.length ? live : rows;
    const primary = [...pool].sort(
      (a, b) => verificationRank(b.verification) - verificationRank(a.verification) || String(a.first_seen).localeCompare(String(b.first_seen)),
    )[0];
    // Only a listing from a DIFFERENT source is a duplicate. Two URLs on the
    // same board with the same title are two openings (several identical
    // requisitions are common: "Assistant Distribution Center" x3).
    for (const r of rows) {
      if (r === primary || r.source === primary.source) continue;
      r.duplicate_of = primary.key;
      dupes++;
    }
    // Cross-check: a vacancy confirmed on the employer's own site confirms the
    // other listings of the same vacancy too.
    if (primary.verification === V.EMPLOYER) {
      for (const r of rows) {
        if (r !== primary && r.verification !== V.EXPIRED && r.verification !== V.EMPLOYER) {
          r.check_note = `cross-checked: also on employer site (${primary.key})`;
        }
      }
    }
  }
  return dupes;
}

const CLOSED_PHRASES = [
  "no longer available",
  "no longer accepting applications",
  "position has been filled",
  "this job has expired",
  "job has expired",
  "vacancy has expired",
  "job is no longer active",
  "this job is closed",
  "posting has been closed",
  "applications are closed",
];

/**
 * Verdict for a plain page fetch of a non-ATS listing. Only explicit evidence
 * changes the status; a page that loads proves it is still listed, not that the
 * job is open, so the status stays what it was.
 * @param {{ status: number | null, body?: string, error?: string }} res
 * @returns {{ verdict: "expired" | "listed" | "blocked" | "unreachable", note: string }}
 */
export function classifyPageCheck(res) {
  if (res.status === 404 || res.status === 410) return { verdict: "expired", note: `HTTP ${res.status}` };
  if (res.status === 401 || res.status === 403 || res.status === 429) return { verdict: "blocked", note: `HTTP ${res.status} (site refused automated check)` };
  if (res.status == null) return { verdict: "unreachable", note: res.error ? `unreachable: ${res.error}` : "unreachable" };
  if (res.status >= 200 && res.status < 300) {
    const body = String(res.body || "").toLowerCase();
    const hit = CLOSED_PHRASES.find((p) => body.includes(p));
    if (hit) return { verdict: "expired", note: `page says "${hit}"` };
    return { verdict: "listed", note: "page still listed" };
  }
  return { verdict: "unreachable", note: `HTTP ${res.status}` };
}

/**
 * Minimal robots.txt check for one path, for the `*` group and an optional
 * named agent. Longest matching rule wins; Allow wins ties. Supports `*` and
 * `$` in paths. An unparseable or empty file allows everything (RFC 9309).
 */
export function robotsAllows(robotsTxt, path, agent = "career-ops") {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(robotsTxt || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === "allow" || field === "disallow") && current) {
      current.rules.push({ allow: field === "allow", path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  const a = agent.toLowerCase();
  const named = groups.filter((g) => g.agents.some((x) => x !== "*" && a.includes(x)));
  const chosen = named.length ? named : groups.filter((g) => g.agents.includes("*"));
  let best = null;
  for (const g of chosen) {
    for (const r of g.rules) {
      if (r.path === "") continue; // "Disallow:" with no path allows everything
      const re = new RegExp(
        "^" +
          r.path
            .split("*")
            .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*")
            .replace(/\\\$$/, "$"),
      );
      if (re.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
    }
  }
  return best ? best.allow : true;
}

/** Hosts never checked automatically: their terms forbid it, or AGENTS.md does. */
export const NO_AUTOMATED_CHECK_HOSTS = [/(^|\.)linkedin\.com$/i];
