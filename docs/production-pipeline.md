# Monaqasat Production Data Pipeline

This pipeline keeps the scraper, database, API, and dashboard separate:

1. Apify actor crawls Monaqasat and emits dataset records.
2. Dataset JSON is downloaded locally or by a scheduled job.
3. `server/ingest.js` validates and upserts data into normalized PostgreSQL tables.
4. Express API reads normalized tables and returns the dashboard contract.

## Database

Run migrations:

```sh
DATABASE_URL=postgres://rakifkhan@localhost:5432/qatar_tenders npm run db:migrate
```

Core tables:

- `entity`
- `company`
- `tender`
- `bid`
- `raw_page`
- `ingestion_run`

Compatibility views:

- `tenders`
- `tender_companies`

## Import From Apify Dataset

Download a dataset:

```sh
APIFY_TOKEN=... npm run apify:dataset -- DATASET_ID data/latest-apify.json
```

Import it:

```sh
DATABASE_URL=postgres://rakifkhan@localhost:5432/qatar_tenders npm run db:import -- data/latest-apify.json
```

For local sample data:

```sh
DATABASE_URL=postgres://rakifkhan@localhost:5432/qatar_tenders npm run db:seed
```

## Validation

The importer flags and skips records with:

- missing `tenderId`
- missing `tenderNumber`
- missing `title`
- missing `entity`
- awarded tenders with no winner
- awarded amount not matching the winning bid value
- date order issues such as closing date after award date

Every import writes one row to `ingestion_run`.

Check latest run:

```sh
curl http://localhost:3001/api/ingestion-runs/latest
```

## Suggested Schedule

Use cron, Apify schedule, or another scheduler:

- Awarded tenders: daily during development, then weekly/monthly after backfill.
- Available/closed tenders: daily.
- Keep crawler concurrency low.

Example cron shape:

```cron
30 2 * * * cd /Users/falakpathan/Desktop/project-alfa && APIFY_TOKEN=... npm run apify:dataset -- DATASET_ID data/latest-apify.json && DATABASE_URL=postgres://rakifkhan@localhost:5432/qatar_tenders npm run db:import -- data/latest-apify.json
```

## Remaining Production Hooks

- Use the live Apify actor run API to trigger crawls automatically.
- Store full HTML bodies in S3/disk if Apify KV is not kept permanently.
- Add alerting on failed `ingestion_run` rows or high validation-error counts.
