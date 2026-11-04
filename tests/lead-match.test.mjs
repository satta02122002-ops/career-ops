import { test } from "node:test";
import assert from "node:assert/strict";
import { cvSkills, emirateOf, matchLead } from "../lib/lead-match.mjs";

const CV = `Logistics Coordinator at Acme Forwarding, JAFZA. Coordinated shipments by sea, air and road.
Cleared import and export cargo through UAE customs via Mirsal 2, preparing commercial invoices and Bills of Entry.
Negotiated rates with shipping lines. Ran warehouse value-added services with FIFO batch allocation, reconciling WMS
against physical stock. Built an Excel-based billing tracker. SAP S/4HANA MM & WM Key User. Inventory accuracy via
cycle counting. Excel VBA, Power BI, KPI dashboards. 5S, Lean. Incoterms 2020, HS Codes, free zones. Transport.`;

const skills = cvSkills(CV);
const opts = { cvSkillSet: skills, candidateYears: 6, stretchYears: 2 };
const jd = (body) => `${body} `.repeat(1) + " Lorem ipsum dolor sit amet. ".repeat(10);

test("cvSkills only credits skills whose terms appear in the CV", () => {
  for (const s of ["Mirsal 2", "SAP MM", "Inventory control", "Excel / VBA", "Free zones (JAFZA)"]) assert.ok(skills.has(s), s);
  for (const s of ["Arabic", "Dangerous goods (DG)", "Procurement / purchasing", "Cold chain"]) assert.equal(skills.has(s), false, s);
});

test("emirateOf maps free-zone areas and countries", () => {
  assert.equal(emirateOf("Jebel Ali Free Zone, Dubai"), "Dubai");
  assert.equal(emirateOf("JAFZA"), "Dubai");
  assert.equal(emirateOf("Musaffah, Abu Dhabi, UAE"), "Abu Dhabi");
  assert.equal(emirateOf("SAIF Zone"), "Sharjah");
  assert.equal(emirateOf("United Arab Emirates"), "UAE (unspecified)");
  assert.equal(emirateOf("Riyadh, Saudi Arabia"), "Outside UAE");
  assert.equal(emirateOf(""), "Unknown");
});

test("a Dubai customs coordinator role scores high with matching skills named", () => {
  const r = matchLead(
    {
      title: "Customs Clearance Coordinator",
      location: "Dubai, UAE",
      description: jd("Handle customs clearance on Mirsal 2, bills of entry, HS codes and Incoterms for import and export shipments in JAFZA. Excel reporting."),
    },
    opts,
  );
  assert.ok(r.score >= 4, `score ${r.score}`);
  assert.ok(r.matched.includes("Mirsal 2"));
  assert.equal(r.basis, "jd");
});

test("missing requirements are listed, never counted as matched", () => {
  const r = matchLead(
    { title: "Logistics Executive", location: "Dubai", description: jd("Dangerous goods handling, cold chain, Arabic speaker, customs clearance.") },
    opts,
  );
  assert.ok(r.missing.includes("Dangerous goods (DG)"));
  assert.ok(r.missing.includes("Arabic"));
  assert.equal(r.matched.includes("Arabic"), false);
  assert.match(r.explanation, /CV lacks/);
});

test("a title unlike past titles is not rejected when the JD is the same work", () => {
  const r = matchLead(
    { title: "Trade Compliance Associate", location: "Dubai", description: jd("Daily logistics: customs clearance via Mirsal, warehouse stock reconciliation, carrier coordination, Excel.") },
    opts,
  );
  assert.ok(r.score >= 2.5, `score ${r.score}`);
  assert.match(r.explanation, /title differs/);
});

test("deal-breakers cap the score", () => {
  const licence = matchLead({ title: "Logistics Coordinator", location: "Dubai", description: jd("Must have a valid UAE driving licence. Customs, Mirsal.") }, opts);
  assert.ok(licence.score <= 2.5);
  assert.match(licence.explanation, /driving licence/);
  const picker = matchLead({ title: "Warehouse Picker", location: "Dubai" }, opts);
  assert.ok(picker.score <= 1.5);
  const director = matchLead({ title: "Director of Supply Chain", location: "Dubai" }, opts);
  assert.ok(director.score <= 2.0);
});

test("experience far above the band lowers the score and says why", () => {
  const base = { title: "Supply Chain Specialist", location: "Dubai", description: jd("Inventory control and SAP MM.") };
  const ok = matchLead({ ...base, yearsMin: 5 }, opts);
  const far = matchLead({ ...base, yearsMin: 12 }, opts);
  assert.ok(far.score < ok.score);
  assert.match(far.explanation, /12\+ years/);
});

test("title-only leads are scored and labelled as such", () => {
  const r = matchLead({ title: "Inventory Controller", location: "Jebel Ali" }, opts);
  assert.equal(r.basis, "title");
  assert.match(r.explanation, /title-only/);
  assert.ok(r.score >= 3);
  const outside = matchLead({ title: "Inventory Controller", location: "Doha, Qatar" }, opts);
  assert.ok(outside.score < r.score);
});

test("manager seats outrank 'senior', floor roles and global roles are capped, title-only tops out at 4.0", () => {
  assert.ok(matchLead({ title: "Warehouse Operative", location: "Dubai" }, opts).score <= 1.5);
  assert.ok(matchLead({ title: "Walk-in Interviews | Warehouse Associate", location: "Dubai" }, opts).score <= 1.5);
  assert.ok(matchLead({ title: "Global Senior Manager - Freight Forwarding", location: "Dubai" }, opts).score <= 2.0);
  const sm = matchLead({ title: "Senior Manager, Logistics", location: "Dubai" }, opts);
  assert.match(sm.explanation, /manager level is a stretch/);
  assert.ok(matchLead({ title: "Senior Freight Forwarding & Customs Coordinator", location: "Dubai" }, opts).score <= 4.0);
  assert.equal(matchLead({ title: "Supply Chain Analyst", location: "Dubai", description: "Demand planning, forecasting, SAP MM, Power BI dashboards, inventory analysis. Arabic preferred." }, opts).basis, "jd");
});
