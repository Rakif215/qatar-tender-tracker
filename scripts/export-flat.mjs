#!/usr/bin/env node
/**
 * Flat row files for spreadsheet / dashboard tools, from public/tender-data/tenders.json.
 *   node scripts/export-flat.mjs [fromDate=2026-01-01] [outDir=exports]
 * Writes awards.json (one row per tender), winners.json (one row per winning company)
 * and offers.json (one row per company offer).
 */
import fs from "node:fs";
import path from "node:path";

const from = process.argv[2] ?? "2026-01-01";
const outDir = process.argv[3] ?? "exports";
const d = JSON.parse(fs.readFileSync("public/tender-data/tenders.json", "utf8"));
const name = (c) => d.companies[c]?.name ?? "Unknown";
const cat = (t) => d.categories[t.cat] ?? "Other / Uncategorized";
const T = d.tenders.filter((t) => t.ad && t.ad >= from);

const awards = T.map((t) => {
  const priced = t.bid.filter((b) => b.a > 0);
  const low = priced.length ? Math.min(...priced.map((b) => b.a)) : null;
  const win = priced.find((b) => b.w);
  return {
    tender_no: t.no,
    title: t.t,
    ministry: t.e ?? "Unknown",
    category: cat(t),
    award_date: t.ad,
    month: t.ad.slice(0, 7),
    value_qar: t.amt ?? null,
    winners: t.win.map((w) => name(w.c)).join("; "),
    offers: t.bid.length || null,
    lowest_offer_qar: low,
    winning_offer_qar: win?.a ?? null,
    lowest_won: low != null && win ? (win.a <= low * 1.0001 ? 1 : 0) : null,
    report_url: t.id ? `https://monaqasat.mof.gov.qa/TendersOnlineServices/TenderCompaniesDetails/${t.id}` : null,
  };
});

const winners = [];
const offers = [];
for (const t of T) {
  const known = t.win.length && t.win.every((w) => w.v != null);
  for (const w of t.win) {
    winners.push({
      tender_no: t.no, company: name(w.c), ministry: t.e ?? "Unknown", category: cat(t),
      award_date: t.ad, month: t.ad.slice(0, 7),
      value_qar: known ? w.v : (t.amt ?? 0) / t.win.length,
    });
  }
  for (const b of t.bid) {
    offers.push({
      tender_no: t.no, company: name(b.c), ministry: t.e ?? "Unknown", category: cat(t),
      award_date: t.ad, offer_qar: b.a ?? null, won: b.w,
    });
  }
}

fs.mkdirSync(outDir, { recursive: true });
for (const [f, rows] of Object.entries({ awards, winners, offers })) {
  fs.writeFileSync(path.join(outDir, `${f}.json`), JSON.stringify(rows));
  console.log(f, rows.length, `${(fs.statSync(path.join(outDir, `${f}.json`)).size / 1024).toFixed(0)} KB`);
}
