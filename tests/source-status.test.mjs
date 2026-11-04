import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatus, parseStatus, serializeStatus } from "../source-status.mjs";

const portals = {
  tracked_companies: [
    { name: "DSV", careers_url: "x" },
    { name: "Hays", careers_url: "y", source_type: "recruiter" },
    { name: "Aramex", careers_url: "z", scan_method: "websearch" },
  ],
};
const receipt = {
  sources: [
    { name: "DSV", provider: "successfactors", board: false, status: "reachable", found: 120, added: 2 },
    { name: "Hays", provider: "radancy", board: false, status: "network", found: null, added: 0 },
  ],
  not_scanned: [{ name: "Aramex", reason: "no_provider", method: "websearch" }],
  errors: [{ company: "Hays", error: "fetch failed" }],
};
const leads = [
  { source: "DSV", url: "https://jobs.dsv.com/1" },
  { source: "Bayt", url: "https://www.bayt.com/en/uae/jobs/1" },
  { source: "Google", url: "https://www.gulftalent.com/uae/jobs/2" },
  { source: "Cooper Fitch", url: "https://cooperfitch.ae/job/3" },
];

test("only a board that answered counts as scanned; blocked and unscanned are reported as such", () => {
  const rows = buildStatus({ prev: [], receipt, portals, leads, now: "2026-11-04T02:30:00Z" });
  const by = Object.fromEntries(rows.map((r) => [r.source, r]));
  assert.equal(by.DSV.status, "ok");
  assert.equal(by.DSV.last_success, "2026-11-04T02:30:00Z");
  assert.equal(by.DSV.found_last, "120");
  assert.equal(by.DSV.leads_total, "1");
  assert.match(by.Hays.status, /^error: network/);
  assert.equal(by.Hays.type, "recruiter");
  assert.equal(by.Hays.last_success, "");
  assert.equal(by.Hays.error, "fetch failed");
  assert.equal(by.Aramex.status, "not_scanned (search only)");
  assert.equal(by.Aramex.last_success, "");
});

test("search-only platforms are always listed with the leads they contributed", () => {
  const by = Object.fromEntries(buildStatus({ prev: [], receipt, portals, leads, now: "t" }).map((r) => [r.source, r]));
  for (const s of ["Google Search", "Bayt", "GulfTalent", "Naukrigulf", "LinkedIn", "Indeed UAE"]) assert.equal(by[s].status, "search_only", s);
  assert.equal(by.Bayt.leads_total, "1");
  assert.equal(by.GulfTalent.leads_total, "1", "counted by host even when the source label differs");
  assert.equal(by["Cooper Fitch"].status, "leads only");
});

test("a failed run keeps the last success date from the previous run", () => {
  const first = buildStatus({ prev: [], receipt, portals, leads, now: "2026-11-04T02:30:00Z" });
  const failing = { ...receipt, sources: [{ name: "DSV", provider: "successfactors", status: "auth", found: null, added: 0 }], errors: [{ company: "DSV", error: "403" }] };
  const second = buildStatus({ prev: parseStatus(serializeStatus(first)), receipt: failing, portals, leads, now: "2026-11-04T14:30:00Z" });
  const dsv = second.find((r) => r.source === "DSV");
  assert.match(dsv.status, /refused/);
  assert.equal(dsv.last_success, "2026-11-04T02:30:00Z");
  assert.equal(dsv.last_attempt, "2026-11-04T14:30:00Z");
});
