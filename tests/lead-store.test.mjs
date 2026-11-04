import { test } from "node:test";
import assert from "node:assert/strict";
import {
  V,
  classifyPageCheck,
  initialVerification,
  leadIdentity,
  mergeLeads,
  normalizeTitle,
  parseLeads,
  robotsAllows,
  serializeLeads,
} from "../lib/lead-store.mjs";

const norm = (s) => s.toLowerCase().replace(/\b(llc|fze|fzco|uae|ltd)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const lead = (o) => ({ state: "new", first_seen: "2026-11-04", emirate: "Dubai", ...o });

test("initial verification follows the source type", () => {
  assert.equal(initialVerification("employer"), V.EMPLOYER);
  assert.equal(initialVerification("recruiter"), V.RECRUITER);
  assert.equal(initialVerification("job_board"), V.JOB_BOARD);
  assert.equal(initialVerification("search_engine"), V.SEARCH);
  assert.equal(initialVerification("manual"), V.PENDING);
});

test("TSV round-trips and strips tabs/newlines from untrusted values", () => {
  const rows = [lead({ key: "k1", url: "https://x/1", title: "Logistics\tCoordinator\nDubai", employer: "DSV" })];
  const back = parseLeads(serializeLeads(rows));
  assert.equal(back[0].title, "Logistics Coordinator Dubai");
  assert.equal(back[0].employer, "DSV");
  assert.equal(back[0].key, "k1");
});

test("normalizeTitle removes hiring noise and location suffixes", () => {
  assert.equal(normalizeTitle("URGENT HIRING: Sr. Logistics Coordinator - Dubai"), "senior logistics coordinator");
  assert.equal(normalizeTitle("Walk-in Interviews | Warehouse Associate"), "warehouse associate");
  assert.equal(normalizeTitle("Customs Specialist (Air & Sea)"), "customs specialist");
});

test("confidential employers never get a cross-source identity", () => {
  for (const employer of ["?", "", "Confidential", "A leading logistics company"]) {
    assert.equal(leadIdentity({ employer, title: "Logistics Coordinator", emirate: "Dubai" }, norm), null, employer);
  }
});

test("same URL updates; same vacancy elsewhere becomes a duplicate of the best-verified listing", () => {
  const store = [];
  mergeLeads(store, [lead({ key: "bayt/1", url: "u1", title: "Logistics Coordinator", employer: "DSV Solutions LLC", source: "Bayt", verification: V.JOB_BOARD })], norm);
  const r = mergeLeads(
    store,
    [
      lead({ key: "bayt/1", url: "u1", title: "Logistics Coordinator", employer: "DSV Solutions LLC", source: "Bayt", verification: V.JOB_BOARD }),
      lead({ key: "dsv/9", url: "u2", title: "Logistics Coordinator - Dubai", employer: "DSV Solutions", source: "DSV", verification: V.EMPLOYER, first_seen: "2026-11-05" }),
    ],
    norm,
  );
  assert.deepEqual(r, { added: 1, updated: 1, duplicates: 1 });
  const bayt = store.find((x) => x.key === "bayt/1");
  const dsv = store.find((x) => x.key === "dsv/9");
  assert.equal(dsv.duplicate_of, "", "employer listing is primary");
  assert.equal(bayt.duplicate_of, "dsv/9");
  assert.match(bayt.check_note, /cross-checked/);
});

test("a merge never downgrades verification, and different emirates stay separate", () => {
  const store = [lead({ key: "a", url: "a", title: "Inventory Controller", employer: "Aramex", verification: V.EMPLOYER })];
  mergeLeads(store, [lead({ key: "a", url: "a", title: "Inventory Controller", employer: "Aramex", verification: V.SEARCH })], norm);
  assert.equal(store[0].verification, V.EMPLOYER);
  mergeLeads(store, [lead({ key: "b", url: "b", title: "Inventory Controller", employer: "Aramex", source: "Bayt", verification: V.JOB_BOARD, emirate: "Abu Dhabi" })], norm);
  assert.equal(store.find((x) => x.key === "b").duplicate_of, "");
});

test("classifyPageCheck only changes status on explicit evidence", () => {
  assert.equal(classifyPageCheck({ status: 404 }).verdict, "expired");
  assert.equal(classifyPageCheck({ status: 200, body: "Sorry, this job has expired." }).verdict, "expired");
  assert.equal(classifyPageCheck({ status: 200, body: "Apply now. Requirements: Mirsal 2" }).verdict, "listed");
  assert.equal(classifyPageCheck({ status: 403 }).verdict, "blocked");
  assert.equal(classifyPageCheck({ status: null, error: "ENOTFOUND" }).verdict, "unreachable");
  assert.equal(classifyPageCheck({ status: 500 }).verdict, "unreachable");
});

test("robotsAllows honours Disallow, Allow, wildcards and agent groups", () => {
  const txt = `User-agent: *\nDisallow: /jobs/\nAllow: /jobs/public/\nDisallow: /*.pdf$\n\nUser-agent: career-ops\nDisallow: /secret`;
  assert.equal(robotsAllows("", "/anything"), true);
  assert.equal(robotsAllows(txt, "/jobs/123", "otherbot"), false);
  assert.equal(robotsAllows(txt, "/jobs/public/9", "otherbot"), true);
  assert.equal(robotsAllows(txt, "/files/a.pdf", "otherbot"), false);
  assert.equal(robotsAllows(txt, "/files/a.pdfx", "otherbot"), true);
  // A named group replaces the * group for that agent.
  assert.equal(robotsAllows(txt, "/jobs/123", "career-ops/1.0"), true);
  assert.equal(robotsAllows(txt, "/secret/x", "career-ops/1.0"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow:", "/x"), true);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /", "/x"), false);
});

test("same-title postings on the same source stay separate openings", () => {
  const store = [];
  const r = mergeLeads(
    store,
    [
      lead({ key: "sr/1", url: "1", title: "Assistant Distribution Center", employer: "Talabat", source: "Talabat", verification: V.EMPLOYER }),
      lead({ key: "sr/2", url: "2", title: "Assistant Distribution Center", employer: "Talabat", source: "Talabat", verification: V.EMPLOYER }),
      lead({ key: "bayt/3", url: "3", title: "Assistant Distribution Center", employer: "Talabat", source: "Bayt", verification: V.JOB_BOARD }),
    ],
    norm,
  );
  assert.equal(r.duplicates, 1);
  assert.equal(store.find((x) => x.key === "sr/2").duplicate_of, "");
  assert.equal(store.find((x) => x.key === "bayt/3").duplicate_of, "sr/1");
});
