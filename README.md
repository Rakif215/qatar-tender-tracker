# Monaqasat Intelligence

Who wins Qatar's public tenders, which ministries buy from whom, and which contracts come up again.
Built from the public award reports on [monaqasat.mof.gov.qa](https://monaqasat.mof.gov.qa) (Ministry of Finance).

**Live:** https://project-alfa-sand.vercel.app

## What it does

1. **Raw data** – a polite scraper collects every public award report (no login, one request every 2–4 s, raw pages kept).
2. **Intelligence** – cleaned and matched data turned into views a bidder can use:
   market by category, who buys from whom, supplier concentration, does the cheapest offer win,
   company and ministry profiles (win rate, price position, head-to-head), and a re-tender radar
   (award date + contract length stated in the title).
3. **Ask** – retrieval-augmented answers: TF-IDF finds the relevant awards, an LLM answers only from
   them and cites each record. The public site shows the retrieval summary; the local version uses Claude via its CLI.

Current data: 2,427 awarded tenders (May 2026 – Nov 2026, plus older records), 1,215 companies, 54 buyers.

## Pipeline

| Step | Code |
|---|---|
| Scrape award lists and reports (Crawlee + Cheerio, runs on Apify or locally) | `actors/monaqasat-collector/src/main.js` |
| Activity names for awards published without a subject | `actors/monaqasat-collector/src/activities.js` |
| Clean, de-duplicate, match companies (name rules + commercial registration number), categorise | `scripts/build-data.mjs`, `server/categorize.js` |
| Second-pass categories for titles the rules miss (LLM, cached) | `scripts/classify-other.mjs` → `data/categories-ai.json` |
| Analysis | `src/analytics.js` |
| TF-IDF retrieval | `src/tfidf.js` (browser), `server/similarity.js` (original server version) |
| Ask server (retrieval + LLM answer with citations) | `server/ask-server.mjs` |
| Dashboard (React, Recharts) | `src/main.jsx`, `src/visuals.jsx` |

The original PostgreSQL ingestion (`server/ingest.js`, `db/schema.sql`), Express API (`server/index.js`, `api/index.js`)
and Apify webhook flow are kept for the database-backed version.

## Run it

```sh
npm install
npm run data        # build public/tender-data/ from data/*.json
npm run dev         # site on :5173 + Ask server on :3011 (Ask needs the `claude` CLI, logged in)
```

Scrape again (local, free; or deploy the actor to Apify):

```sh
cd actors/monaqasat-collector && npm install
echo '{"onlyAwarded":true,"skipDetails":true,"maxListPage":110}' > storage/key_value_stores/default/INPUT.json
node src/main.js
```

## Limits

- Only awards published on Monaqasat are covered; many tenders publish no offer amounts.
- Company matching and categories are rule-based plus a cached LLM pass; some may be wrong.
- The re-tender radar only covers contracts whose title states a length, and contracts can be extended.
