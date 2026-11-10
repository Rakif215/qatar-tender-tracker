#!/usr/bin/env node
/**
 * Build the dashboard dataset.
 *
 * Reads one or more scraper outputs (Apify dataset JSON files or a local
 * Crawlee dataset folder), cleans them, merges the same company under one id,
 * and writes public/tender-data/tenders.json for the static dashboard.
 *
 *   node scripts/build-data.mjs data/crawled-apify.json actors/monaqasat-collector/storage/datasets/default
 *
 * Later inputs win when the same tender appears twice (newer scrape).
 */
import fs from "node:fs";
import path from "node:path";
import { CATEGORIES, FALLBACK_CATEGORY, categorize } from "../server/categorize.js";

// Optional: --activities <file> adds official activity names for records without a subject.
const args = process.argv.slice(2);
const actIdx = args.indexOf("--activities");
const activities = actIdx >= 0 ? JSON.parse(fs.readFileSync(args[actIdx + 1], "utf8")) : {};
// Second-pass categories from scripts/classify-other.mjs (Claude, cached), used when the keyword rules give "other".
const aiCats = fs.existsSync("data/categories-ai.json") ? JSON.parse(fs.readFileSync("data/categories-ai.json", "utf8")) : {};
const inputs = actIdx >= 0 ? args.filter((a, i) => i !== actIdx && i !== actIdx + 1) : args;
if (!inputs.length) {
  console.error("Usage: node scripts/build-data.mjs <dataset.json | dataset-folder> ...");
  process.exit(1);
}

function readInput(p) {
  const stat = fs.statSync(p);
  if (stat.isDirectory()) {
    return fs.readdirSync(p)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(p, f), "utf8")));
  }
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  return Array.isArray(data) ? data : data.items ?? [];
}

const checks = {
  recordsRead: 0,
  notAwardReport: 0,
  missingNumber: 0,
  duplicateRecords: 0,
  badDatesCleared: 0,
  emptyRecords: 0,
  noWinner: 0,
  titlesFromActivities: 0,
  categoriesFromAI: 0,
  untitled: 0,
  amountMismatch: 0,
};

// ── 1. Read and keep one record per tender (newest input wins) ───────────────
const byNumber = new Map();
for (const input of inputs) {
  for (const r of readInput(input)) {
    checks.recordsRead++;
    if (r.pageType && r.pageType !== "award_report") { checks.notAwardReport++; continue; }
    if (!r.tenderNumber) { checks.missingNumber++; continue; }
    if (byNumber.has(r.tenderNumber)) checks.duplicateRecords++;
    byNumber.set(r.tenderNumber, r);
  }
}

// ── 2. Company matching: same company, different spellings ───────────────────
const LEGAL = /\b(w\.?\s?l\.?\s?l|wll|llc|l\.l\.c|ltd|limited|co|company|corporation|corp|est|establishment|trading|group|qpsc|q\.p\.s\.c|qsc|q\.s\.c|spc|the)\b/g;
function normName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,()\-_/'"]/g, " ")
    .replace(LEGAL, " ")
    .replace(/[^a-z0-9؀-ۿ]+/g, " ")
    .trim();
}
function firstCr(c) {
  const list = c.commercialRegistrationNumbers?.length
    ? c.commercialRegistrationNumbers
    : String(c.commercialRegistrationNumber ?? "").split("|");
  const crs = list.map((x) => String(x).trim()).filter((x) => /^\d{3,}$/.test(x));
  // Joint bids list several registration numbers: don't use them to merge companies.
  return crs.length === 1 ? crs[0] : null;
}

const nameToCr = new Map();
const allCompanyRows = [];
for (const r of byNumber.values()) {
  for (const c of [...(r.awardedCompanies ?? []), ...(r.openedCompanies ?? [])]) {
    if (!c?.companyName) continue;
    allCompanyRows.push(c);
    const cr = firstCr(c);
    const n = normName(c.companyName);
    if (cr && n && !nameToCr.has(n)) nameToCr.set(n, cr);
  }
}

const companies = []; // index = id
const keyToId = new Map();
const spellings = new Map(); // id -> Set of raw names
function companyId(c) {
  const n = normName(c.companyName);
  const cr = firstCr(c) ?? nameToCr.get(n);
  const key = cr ? `cr:${cr}` : `n:${n}`;
  let id = keyToId.get(key);
  if (id === undefined) {
    id = companies.length;
    keyToId.set(key, id);
    companies.push({ name: c.companyName.trim(), cr: cr ?? null });
    spellings.set(id, new Set());
  }
  spellings.get(id).add(c.companyName.trim());
  return id;
}

// Contract length stated in the title ("for Three (3) years", "12 months") → months.
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, eighteen: 18, "twenty-four": 24, "thirty-six": 36 };
const DUR = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|eighteen|twenty-four|thirty-six)\s*(?:\(\s*\d+\s*\)\s*)?[- ]?(years?|yrs?|months?)\b/i;
function durationMonths(title) {
  const m = String(title ?? "").match(DUR);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : WORDS[m[1].toLowerCase()];
  const months = /^m/i.test(m[2]) ? n : n * 12;
  return months > 0 && months <= 120 ? months : null;
}

// ── 3. Clean each tender ─────────────────────────────────────────────────────
function cleanDate(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m || Number(m[1]) < 2000) { checks.badDatesCleared++; return null; }
  return `${m[1]}-${m[2]}-${m[3]}`;
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

const tenders = [];
for (const r of byNumber.values()) {
  const winners = (r.awardedCompanies ?? []).filter((c) => c?.companyName).map((c) => ({
    c: companyId(c),
    v: num(c.approvedValue),
  }));
  const bidders = (r.openedCompanies ?? []).filter((c) => c?.companyName).map((c) => ({
    c: companyId(c),
    a: num(c.proposalAmount),
    w: winners.some((x) => x.c === companyId(c)) ? 1 : 0,
  }));
  let title = (r.title ?? "").replace(/\s+/g, " ").trim();
  const noSubject = !title || title.length <= 2 || /^\d+$/.test(title);
  if (noSubject && !winners.length && !bidders.length) { checks.emptyRecords++; continue; }
  // The portal publishes some awards (mostly direct agreements) with "0" or "-" as subject.
  // Their detail page lists official activities, which describe what was bought.
  let titleSource = "subject";
  if (noSubject) {
    const acts = activities[r.tenderNumber]?.activities?.map((a) => a.name).filter(Boolean) ?? [];
    if (acts.length) {
      title = acts.slice(0, 3).join("; ") + (acts.length > 3 ? " …" : "");
      titleSource = "activities";
      checks.titlesFromActivities++;
    } else {
      title = "";
      checks.untitled++;
    }
  }
  if (!winners.length) checks.noWinner++;
  const amount = num(r.awardedAmount);
  const winnerSum = winners.reduce((s, x) => s + (x.v ?? 0), 0);
  if (amount && winnerSum && Math.abs(amount - winnerSum) / amount > 0.01) checks.amountMismatch++;

  tenders.push({
    id: r.tenderId ?? null,
    no: r.tenderNumber,
    t: title,
    ts: titleSource === "subject" ? undefined : titleSource,
    cat: (() => { const k = categorize(title).categorySlug; if (k === "other" && aiCats[r.tenderNumber]) { checks.categoriesFromAI++; return aiCats[r.tenderNumber]; } return k; })(),
    dur: durationMonths(title),
    e: (r.entity ?? "").trim() || null,
    m: r.procurementMethod ?? null,
    k: r.requestTypes ?? null,
    pd: cleanDate(r.publishedDate),
    cd: cleanDate(r.closingDate),
    ad: cleanDate(r.awardDate),
    amt: amount,
    win: winners,
    bid: bidders,
  });
}
tenders.sort((a, b) => (b.ad ?? "").localeCompare(a.ad ?? ""));

const merged = [...spellings.values()].filter((s) => s.size > 1).length;
const dates = tenders.map((t) => t.ad).filter(Boolean).sort();
const out = {
  builtAt: new Date().toISOString(),
  source: "monaqasat.mof.gov.qa (public award reports)",
  period: { from: dates[0] ?? null, to: dates.at(-1) ?? null },
  checks: {
    ...checks,
    tenders: tenders.length,
    companyRows: allCompanyRows.length,
    companies: companies.length,
    companiesWithSeveralSpellings: merged,
  },
  categories: Object.fromEntries([...CATEGORIES, FALLBACK_CATEGORY].map((c) => [c.slug, c.name])),
  companies: companies.map((c, i) => ({ ...c, alt: [...spellings.get(i)].filter((s) => s !== c.name).slice(0, 4) })),
  tenders,
};

fs.mkdirSync("public/tender-data", { recursive: true });
// A sample of records exactly as scraped, newest first, for the "Raw data" tab.
const RAW_KEYS = ["tenderId", "tenderNumber", "title", "entity", "procurementMethod", "requestTypes", "publishedDate", "closingDate", "awardDate", "awardedAmount", "winningCompany", "awardedCompanies", "openedCompanies", "sourceUrl", "fetchedAt"];
const rawSample = [...byNumber.values()]
  .sort((a, b) => String(b.awardDate ?? "").localeCompare(String(a.awardDate ?? "")))
  .slice(0, 150)
  .map((r) => Object.fromEntries(RAW_KEYS.filter((k) => r[k] !== undefined).map((k) => [k, r[k]])));
fs.writeFileSync("public/tender-data/raw-sample.json", JSON.stringify({ builtAt: out.builtAt, inputs: inputs.map((p) => path.basename(p)), records: rawSample }));
fs.writeFileSync("public/tender-data/tenders.json", JSON.stringify(out));
console.log(JSON.stringify({ period: out.period, ...out.checks }, null, 2));
