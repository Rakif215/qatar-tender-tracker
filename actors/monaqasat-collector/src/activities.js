// Fetch the official "Activities list" from the tender detail page for award records
// whose subject is missing ("0", "-"), politely (one request at a time, 2–4 s apart).
//   node src/activities.js <scrape-folder> <out.json>
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { execFile } from "node:child_process";

// curl, not fetch: the portal sends an incomplete certificate chain that macOS curl accepts
// (it completes the chain) but Node's fetch rejects. Certificate checks stay on.
const get = (url) => new Promise((resolve, reject) => execFile("curl", ["-sS", "--fail", "-m", "40", "-A", "Mozilla/5.0", "-H", "Cookie: .AspNetCore.Culture=c%3Den%7Cuic%3Den", url], { maxBuffer: 8e6 }, (e, out) => (e ? reject(e) : resolve(out))));

const [dir, out] = process.argv.slice(2);
const BASE = "https://monaqasat.mof.gov.qa/TendersOnlineServices/TenderDetails/";
const records = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
const missing = records.filter((r) => r.tenderId && (!r.title || r.title.trim().length <= 5 || /^\d+$/.test(r.title.trim())));
const done = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : {};
console.log(`${missing.length} records without a subject, ${Object.keys(done).length} already fetched`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
for (const r of missing) {
  if (done[r.tenderNumber]) continue;
  await sleep(2000 + Math.random() * 2000);
  try {
    const $ = cheerio.load(await get(BASE + r.tenderId));
    const activities = [];
    $("table").each((_, t) => {
      const heads = $(t).find("thead th").map((_, h) => $(h).text().trim()).get();
      const ni = heads.indexOf("Activity name"), ci = heads.indexOf("Activity code");
      if (ni < 0) return;
      $(t).find("tbody tr").each((_, tr) => {
        const td = $(tr).find("td");
        activities.push({ code: ci >= 0 ? $(td[ci]).text().trim() : null, name: $(td[ni]).text().replace(/\s+/g, " ").trim() });
      });
    });
    done[r.tenderNumber] = { tenderId: r.tenderId, activities };
  } catch (e) {
    done[r.tenderNumber] = { tenderId: r.tenderId, error: e.message };
  }
  if (++n % 20 === 0) { fs.writeFileSync(out, JSON.stringify(done)); console.log(`${n} fetched`); }
}
fs.writeFileSync(out, JSON.stringify(done));
const ok = Object.values(done).filter((d) => d.activities?.length).length;
console.log(`done: ${Object.keys(done).length} records, ${ok} with activities`);
