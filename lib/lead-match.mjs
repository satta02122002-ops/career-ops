// Zero-token quick match of a job lead against the candidate's CV and targets.
//
// This is a PRE-SCORE for the discovery dashboard (leads.mjs), not an
// evaluation. It reads the lead's title, location and, when available, JD text,
// and returns a 0-5 score with the skills that match, the requirements the CV
// does not show, and one line of explanation. The full A-H evaluation
// (modes/oferta.md) stays the decision; this only decides what to look at first.
//
// Source of truth: a skill counts as the candidate's only when one of its terms
// appears in cv.md. SKILLS below is a vocabulary of what to look for, never a
// list of claims. Title families and level words are defaults that
// config/profile.yml → lead_match can override.
//
// Pure: no I/O. Callers pass the CV text and the resolved options.

/** Skill vocabulary: label → terms (lowercase, matched on word boundaries). */
export const SKILLS = [
  ["SAP S/4HANA", ["s/4hana", "s4hana", "sap s/4"]],
  ["SAP MM", ["sap mm", "materials management", "mm module", "mm & wm", "mm and wm", "mm/wm"]],
  ["SAP WM / EWM", ["sap wm", "sap ewm", "ewm", "wm module", "mm & wm", "mm and wm", "mm/wm"]],
  ["SAP (general)", ["sap"]],
  ["WMS", ["wms", "warehouse management system"]],
  ["Mirsal 2", ["mirsal"]],
  ["UAE customs clearance", ["customs clearance", "dubai customs", "bill of entry", "bills of entry", "customs declaration", "customs"]],
  ["Freight forwarding", ["freight forwarding", "forwarder", "sea freight", "air freight", "ocean freight"]],
  ["Import / export documentation", ["import", "export", "commercial invoice", "packing list", "certificate of origin", "certificates of origin"]],
  ["Incoterms", ["incoterms"]],
  ["HS codes", ["hs code", "hs codes", "tariff classification"]],
  ["Free zones (JAFZA)", ["jafza", "jebel ali free zone", "free zone", "free-zone", "dafza"]],
  ["3PL / contract logistics", ["3pl", "third-party logistics", "third party logistics", "contract logistics", "contract-logistics"]],
  ["Warehouse operations", ["warehouse", "put-away", "putaway", "receiving", "picking", "dispatch"]],
  ["Inventory control", ["inventory", "stock control", "stock controller", "cycle count", "cycle counting", "stock accuracy"]],
  ["FIFO / FEFO", ["fifo", "fefo"]],
  ["Transportation coordination", ["transport", "transportation", "trucking", "carrier", "carriers", "fleet"]],
  ["Shipping / carrier rates", ["shipping line", "shipping lines", "rate negotiation", "freight rates", "negotiated rates"]],
  ["Storage & VAS billing", ["billing", "invoicing", "value-added services", "vas"]],
  ["Excel / VBA", ["excel", "vba"]],
  ["Power BI", ["power bi"]],
  ["Reporting & KPIs", ["reporting", "kpi", "kpis", "dashboard", "dashboards"]],
  ["Lean / 5S", ["5s", "lean", "kaizen", "six sigma"]],
  ["Material master / bin control", ["material master", "bin allocation", "storage location"]],
  ["Procurement / purchasing", ["procurement", "purchasing", "purchase order", "purchase orders", "sourcing"]],
  ["Demand / supply planning", ["demand planning", "supply planning", "forecasting", "mrp"]],
  ["Dangerous goods (DG)", ["dangerous goods", "iata dgr", "hazmat"]],
  ["Cold chain", ["cold chain", "temperature-controlled", "temperature controlled"]],
  ["Arabic", ["arabic"]],
];

/** Title families in scope (any term in the title). */
export const DEFAULT_TITLE_FAMILIES = [
  ["Logistics", ["logistics", "logistic"]],
  ["Supply chain", ["supply chain", "scm"]],
  ["Warehouse", ["warehouse", "warehousing", "distribution center", "distribution centre", "fulfilment", "fulfillment"]],
  ["Inventory", ["inventory", "stock control", "stock controller"]],
  ["Materials", ["material", "materials"]],
  ["SAP MM / WM", ["sap mm", "sap wm", "sap ewm", "mm/wm", "key user"]],
  ["Freight & customs", ["freight", "forwarding", "customs", "clearance", "shipping", "import", "export", "ocean", "air cargo", "cargo"]],
  ["Operations", ["operations coordinator", "operations executive", "operations officer", "operations specialist", "operations supervisor"]],
  ["Transport", ["transport", "transportation", "fleet coordinator", "dispatch"]],
];

/** Adjacent families: plausible but not a target (scored lower, never rejected). */
export const ADJACENT_FAMILIES = [
  ["Procurement", ["procurement", "purchasing", "buyer"]],
  ["Planning", ["planner", "planning", "demand"]],
  ["Operations (general)", ["operations"]],
];

export const DEFAULT_LEVELS = {
  inScope: ["coordinator", "executive", "specialist", "officer", "supervisor", "analyst", "controller", "key user", "lead", "team leader", "assistant manager", "senior"],
  stretch: ["manager"],
  tooSenior: ["director", "head of", "vice president", "vp ", "chief", "general manager", "regional manager", "global"],
  belowLevel: ["driver", "helper", "picker", "packer", "labourer", "laborer", "loader", "forklift", "reach truck", "operator", "operative", "cleaner", "intern", "trainee", "warehouse associate", "warehouse assistant", "warehouse worker", "storekeeper", "store keeper", "assistant distribution center", "assistant distribution centre"],
};

const EMIRATES = [
  ["Dubai", ["dubai", "jebel ali", "jafza", "dafza", "dubai south", "al quoz", "deira", "dip ", "dubai investment park", "dubai logistics city"]],
  ["Abu Dhabi", ["abu dhabi", "kizad", "khalifa port", "musaffah", "mussafah", "al ain"]],
  ["Sharjah", ["sharjah", "saif zone", "hamriyah"]],
  ["Ajman", ["ajman"]],
  ["Ras Al Khaimah", ["ras al khaimah", "ras al-khaimah", "rak "]],
  ["Fujairah", ["fujairah"]],
  ["Umm Al Quwain", ["umm al quwain", "umm al-quwain"]],
];

const lc = (s) => ` ${String(s ?? "").toLowerCase().replace(/\s+/g, " ")} `;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** Word-boundary match for a term inside padded lowercase text. */
function has(text, term) {
  const t = term.trim();
  return new RegExp(`(^|[^a-z0-9])${escapeRe(t)}([^a-z0-9]|$)`).test(text);
}
const anyTerm = (text, terms) => terms.find((t) => has(text, t)) ?? null;

/** Which emirate a free-text location names ("UAE" when only the country is named). */
export function emirateOf(location) {
  const text = lc(location);
  for (const [name, terms] of EMIRATES) if (anyTerm(text, terms)) return name;
  if (anyTerm(text, ["united arab emirates", "uae", "u.a.e"])) return "UAE (unspecified)";
  if (!String(location ?? "").trim()) return "Unknown";
  return "Outside UAE";
}

/** Skill labels whose terms appear in the CV text. */
export function cvSkills(cvText) {
  const text = lc(cvText);
  return new Set(SKILLS.filter(([, terms]) => anyTerm(text, terms)).map(([label]) => label));
}

/**
 * @param {{ title: string, location?: string, description?: string, yearsMin?: number | null }} lead
 * @param {{ cvSkillSet: Set<string>, candidateYears?: number, stretchYears?: number, titleFamilies?: [string, string[]][], levels?: typeof DEFAULT_LEVELS }} opts
 */
export function matchLead(lead, opts) {
  const titleText = lc(lead.title);
  const jdText = lc(lead.description || "");
  const hasJd = jdText.trim().length > 80;
  const families = opts.titleFamilies || DEFAULT_TITLE_FAMILIES;
  const levels = opts.levels || DEFAULT_LEVELS;
  const notes = [];
  const caps = [];

  // 1. Title family (0-2).
  const family = families.find(([, terms]) => anyTerm(titleText, terms));
  const adjacent = family ? null : ADJACENT_FAMILIES.find(([, terms]) => anyTerm(titleText, terms));
  let titlePts = family ? 2 : adjacent ? 1 : 0;
  if (!family && !adjacent && hasJd) {
    // A different title can still be the same work: let the JD speak.
    const jdFamily = families.find(([, terms]) => anyTerm(jdText, terms));
    if (jdFamily) {
      titlePts = 0.75;
      notes.push(`title differs, but the JD is ${jdFamily[0].toLowerCase()} work`);
    }
  }

  // 2. Level (-0.5 .. +0.5, with caps).
  let levelPts = 0;
  const below = anyTerm(titleText, levels.belowLevel);
  const senior = anyTerm(titleText, levels.tooSenior);
  if (below) {
    caps.push([1.5, `hands-on "${below.trim()}" role below your level`]);
  } else if (senior) {
    caps.push([2.0, `"${senior.trim()}" is well above your level`]);
  } else if (anyTerm(titleText, levels.stretch) && !anyTerm(titleText, ["assistant manager"])) {
    // Checked before in-scope words: "Senior Manager" is a manager seat.
    levelPts = 0.25;
    notes.push("manager level is a stretch");
  } else if (anyTerm(titleText, levels.inScope)) {
    levelPts = 0.5;
  }

  // 3. Skills (0-1.5). With a JD: share of the JD's skills the CV shows.
  // Title only: credit for skills named in the title.
  const scope = hasJd ? jdText : titleText;
  const asked = SKILLS.filter(([, terms]) => anyTerm(scope, terms)).map(([label]) => label);
  const matched = asked.filter((s) => opts.cvSkillSet.has(s));
  const missing = asked.filter((s) => !opts.cvSkillSet.has(s));
  let skillPts;
  if (hasJd) skillPts = asked.length ? 1.5 * (matched.length / Math.max(asked.length, 3)) : 0.5;
  else skillPts = Math.min(1, 0.5 + 0.25 * matched.length);

  // 4. Location (0.2-1).
  const emirate = emirateOf(lead.location);
  const locPts = { Dubai: 1, "UAE (unspecified)": 0.8, Unknown: 0.5, "Outside UAE": 0.2 }[emirate] ?? 0.6;
  if (emirate === "Outside UAE") notes.push("outside the UAE");
  else if (!["Dubai", "UAE (unspecified)", "Unknown"].includes(emirate)) notes.push(`based in ${emirate}`);

  // 5. Deal-breakers and experience, only when the JD says so.
  if (hasJd) {
    if (/(valid|uae)[^.]{0,40}driving licen[cs]e|driving licen[cs]e[^.]{0,30}(required|must|mandatory)/.test(jdText)) {
      caps.push([2.5, "requires a UAE driving licence"]);
    }
    if (/\b(6|six)[- ]day(s)?\b[^.]{0,20}(week|working)|\bsix days a week\b/.test(jdText)) caps.push([2.5, "6-day working week"]);
    if (/\b(night shift|rotating shift|rotational shift|night shifts)\b/.test(jdText)) caps.push([2.5, "night or rotating shifts"]);
  }
  let expPts = 0;
  const years = opts.candidateYears ?? null;
  if (years != null && Number.isFinite(lead.yearsMin)) {
    const stretch = opts.stretchYears ?? 2;
    if (lead.yearsMin > years + stretch) {
      expPts = -0.5;
      notes.push(`asks for ${lead.yearsMin}+ years (you have ${years})`);
    } else if (lead.yearsMin > years) {
      notes.push(`asks for ${lead.yearsMin}+ years, a small stretch`);
    }
  }

  let score = titlePts + levelPts + skillPts + locPts + expPts;
  // Without the JD the score is a guess from the title: never above 4.0.
  if (!hasJd) score = Math.min(score, 4);
  for (const [cap] of caps) score = Math.min(score, cap);
  score = Math.round(Math.max(0, Math.min(5, score)) * 10) / 10;

  const lead1 = family
    ? `${family[0]} role`
    : adjacent
      ? `adjacent ${adjacent[0].toLowerCase()} role`
      : titlePts > 0
        ? "different title"
        : "not a target role family";
  const explanation = [
    lead1,
    ...caps.map(([, why]) => why),
    matched.length ? `matches ${matched.slice(0, 4).join(", ")}` : null,
    missing.length ? `CV lacks ${missing.slice(0, 3).join(", ")}` : null,
    ...notes,
    hasJd ? null : "title-only (no JD text read yet)",
  ]
    .filter(Boolean)
    .join("; ");

  return { score, emirate, matched, missing, explanation, basis: hasJd ? "jd" : "title" };
}
