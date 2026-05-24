import { fileURLToPath } from "node:url";
import path from "node:path";
import { ingestFromFile } from "./ingest.js";
import { pool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const samplePath = path.resolve(__dirname, "../data/sample-tenders.json");

console.log(`Seeding database from ${samplePath} …`);
const stats = await ingestFromFile(samplePath);
await pool.end();
console.log(`Done. Imported ${stats.imported} tenders (${stats.newTenders} new, ${stats.updatedTenders} updated). Failed: ${stats.failed}.`);
