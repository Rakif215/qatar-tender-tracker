import fs from "node:fs/promises";

const datasetIdOrUrl = process.argv[2] ?? process.env.APIFY_DATASET_ID;
const outputPath = process.argv[3] ?? `data/apify-dataset-${Date.now()}.json`;
const token = process.env.APIFY_TOKEN;

if (!datasetIdOrUrl) {
  console.error("Usage: APIFY_TOKEN=... npm run apify:dataset -- <datasetId-or-url> [output.json]");
  process.exit(1);
}

const url = datasetIdOrUrl.startsWith("http")
  ? datasetIdOrUrl
  : `https://api.apify.com/v2/datasets/${datasetIdOrUrl}/items?clean=true&format=json`;

const requestUrl = new URL(url);
if (token && !requestUrl.searchParams.has("token")) {
  requestUrl.searchParams.set("token", token);
}

const response = await fetch(requestUrl);
if (!response.ok) {
  throw new Error(`Apify dataset download failed: ${response.status} ${response.statusText}`);
}

const text = await response.text();
JSON.parse(text);
await fs.mkdir(new URL("../data/", import.meta.url), { recursive: true });
await fs.writeFile(outputPath, text);
console.log(`Downloaded Apify dataset to ${outputPath}`);
