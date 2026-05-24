/**
 * pull-and-ingest.js
 * CLI helper: pulls the latest dataset from a given Apify run and ingests it.
 * Usage:
 *   node server/pull-and-ingest.js                        ← uses the most recent run
 *   node server/pull-and-ingest.js <datasetId>            ← uses a specific dataset
 */

import "dotenv/config";
import { ingestFromRecords } from "./ingest.js";
import { pool } from "./db.js";

const token   = process.env.APIFY_TOKEN;
const actorId = process.env.APIFY_ACTOR_ID;

if (!token || !actorId) {
  console.error("❌  APIFY_TOKEN and APIFY_ACTOR_ID must be set in .env");
  process.exit(1);
}

let datasetId = process.argv[2];

// If no dataset ID given, look up the latest successful run
if (!datasetId) {
  console.log("🔍  Looking up the latest successful Apify run…");
  const res  = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${token}&limit=20&desc=true`);
  const data = await res.json();
  const run  = data.data?.items?.find((r) => r.status === "SUCCEEDED");
  if (!run) {
    console.error("❌  No successful runs found for this actor.");
    process.exit(1);
  }
  datasetId = run.defaultDatasetId;
  console.log(`✅  Latest run: ${run.id}  |  Dataset: ${datasetId}  |  Started: ${run.startedAt}`);
}

console.log(`⬇️   Downloading dataset ${datasetId}…`);
const url  = `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&format=json&token=${token}&limit=1000`;
const resp = await fetch(url);
if (!resp.ok) { console.error(`❌  Apify returned ${resp.status}`); process.exit(1); }

const records = await resp.json();
console.log(`📦  ${records.length} records downloaded — importing…`);

const summary = await ingestFromRecords(records, { source: "pull-and-ingest", datasetId });
await pool.end();

console.log("\n✅  Import complete:");
console.log(`   Seen:    ${summary.seen}`);
console.log(`   Imported:${summary.imported}`);
console.log(`   New:     ${summary.newTenders}`);
console.log(`   Updated: ${summary.updatedTenders}`);
console.log(`   Failed:  ${summary.failed}`);
