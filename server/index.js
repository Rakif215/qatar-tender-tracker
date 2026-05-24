import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { pool } from "./db.js";
import { ingestFromFile, ingestFromRecords } from "./ingest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT ?? 3001);

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// ─── Health ─────────────────────────────────────────────────────────────────

app.get("/api/health", async (_request, response) => {
  try {
    await pool.query("select 1");
    response.json({ ok: true });
  } catch (error) {
    response.status(503).json({ ok: false, error: error.message });
  }
});

// ─── Stats (dashboard header counts) ────────────────────────────────────────

app.get("/api/stats", async (_request, response) => {
  try {
    const [counts, lastRun] = await Promise.all([
      pool.query(`
        select
          (select count(*) from tender)::int as "totalTenders",
          (select count(*) from tender where status = 'awarded')::int as "awardedTenders",
          (select count(*) from company)::int as "totalCompanies",
          (select count(*) from entity)::int as "totalEntities",
          (select coalesce(sum(awarded_value), 0)::float from tender where awarded_value is not null) as "totalAwardedValue"
      `),
      pool.query(`
        select
          run_id as "runId",
          status,
          started_at as "startedAt",
          finished_at as "finishedAt",
          records_imported as "recordsImported",
          new_tenders as "newTenders",
          updated_tenders as "updatedTenders"
        from ingestion_run
        order by started_at desc
        limit 1
      `),
    ]);
    response.json({
      ...counts.rows[0],
      lastRun: lastRun.rows[0] ?? null,
    });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

// ─── Tenders ─────────────────────────────────────────────────────────────────

app.get("/api/tenders", async (request, response) => {
  const {
    q,
    dateFrom,
    dateTo,
    method,
    amountMin,
    amountMax,
    entity,
    status,
    limit = "100",
    offset = "0",
    sortBy = "award_date",
    sortDir = "desc",
  } = request.query;

  const values = [];
  const where = [];

  if (q?.trim()) {
    values.push(`%${q.trim()}%`);
    const index = values.length;
    where.push(`(
      t.tender_number ilike $${index}
      or t.title ilike $${index}
      or e.name ilike $${index}
      or winner.name ilike $${index}
      or exists (
        select 1
        from bid bq
        join company cq on cq.company_id = bq.company_id
        where bq.tender_id = t.tender_id and cq.name ilike $${index}
      )
    )`);
  }

  if (dateFrom) {
    values.push(dateFrom);
    where.push(`t.award_date >= $${values.length}`);
  }

  if (dateTo) {
    values.push(dateTo);
    where.push(`t.award_date <= $${values.length}`);
  }

  if (method) {
    values.push(method);
    where.push(`t.procurement_method = $${values.length}`);
  }

  if (entity) {
    values.push(entity);
    where.push(`e.name = $${values.length}`);
  }

  if (status) {
    values.push(status);
    where.push(`t.status = $${values.length}`);
  }

  if (amountMin) {
    values.push(Number(amountMin));
    where.push(`t.awarded_value >= $${values.length}`);
  }

  if (amountMax) {
    values.push(Number(amountMax));
    where.push(`t.awarded_value <= $${values.length}`);
  }

  // Allowed sort columns to prevent SQL injection
  const allowedSortColumns = {
    award_date: "t.award_date",
    awarded_value: "t.awarded_value",
    entity: "e.name",
    title: "t.title",
    tender_number: "t.tender_number",
  };
  const sortColumn = allowedSortColumns[sortBy] ?? "t.award_date";
  const sortDirection = sortDir === "asc" ? "asc" : "desc";

  values.push(Math.min(Number(limit) || 100, 500));
  const limitIndex = values.length;

  values.push(Math.max(Number(offset) || 0, 0));
  const offsetIndex = values.length;

  // Count query (same WHERE, no LIMIT)
  const countValues = values.slice(0, values.length - 2);
  const countSql = `
    select count(distinct t.tender_id)::int as total
    from tender t
    left join entity e on e.entity_id = t.entity_id
    left join company winner on winner.company_id = t.awarded_company_id
    ${where.length ? `where ${where.join(" and ")}` : ""}
  `;

  const sql = `
    select
      t.tender_id as id,
      t.tender_id as "tenderId",
      t.tender_number as "tenderNumber",
      t.title,
      t.status,
      e.name as entity,
      t.procurement_method as "procurementMethod",
      t.award_date as "awardDate",
      t.awarded_value::float as "awardedAmount",
      t.currency as "awardedAmountCurrency",
      t.source_url as "sourceUrl",
      t.tender_detail_url as "tenderDetailUrl",
      winner.name as "winningCompany",
      coalesce(
        json_agg(
          json_build_object(
            'id', b.bid_id,
            'companyName', c.name,
            'commercialRegistrationNumber', c.commercial_registration_number,
            'approvedValue', b.approved_value::float,
            'proposalAmount', b.bid_value::float,
            'localValueRatio', b.local_value_ratio::float,
            'financialResult', b.financial_result::float,
            'notes', b.notes,
            'isWinner', b.is_winner,
            'source', b.source
          )
          order by b.is_winner desc, coalesce(b.bid_value, b.approved_value) asc nulls last, c.name asc
        ) filter (where b.bid_id is not null),
        '[]'::json
      ) as companies
    from tender t
    left join entity e on e.entity_id = t.entity_id
    left join company winner on winner.company_id = t.awarded_company_id
    left join bid b on b.tender_id = t.tender_id
    left join company c on c.company_id = b.company_id
    ${where.length ? `where ${where.join(" and ")}` : ""}
    group by t.tender_id, e.name, winner.name
    order by ${sortColumn} ${sortDirection} nulls last, t.updated_at desc
    limit $${limitIndex}
    offset $${offsetIndex}
  `;

  try {
    const [result, countResult] = await Promise.all([
      pool.query(sql, values),
      pool.query(countSql, countValues),
    ]);
    response.json({
      items: result.rows,
      total: countResult.rows[0].total,
      limit: Number(limit),
      offset: Number(offset),
    });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

// ─── Filter options ──────────────────────────────────────────────────────────

app.get("/api/procurement-methods", async (_request, response) => {
  try {
    const result = await pool.query(`
      select distinct procurement_method as method
      from tender
      where procurement_method is not null and procurement_method <> ''
      order by procurement_method
    `);
    response.json({ items: result.rows.map((row) => row.method) });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/entities", async (_request, response) => {
  try {
    const result = await pool.query(`
      select distinct e.name as entity
      from tender t
      join entity e on e.entity_id = t.entity_id
      where e.name is not null and e.name <> ''
      order by e.name
    `);
    response.json({ items: result.rows.map((row) => row.entity) });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

// ─── Ingestion runs ──────────────────────────────────────────────────────────

app.get("/api/ingestion-runs/latest", async (_request, response) => {
  try {
    const result = await pool.query(`
      select
        run_id as "runId",
        source,
        status,
        started_at as "startedAt",
        finished_at as "finishedAt",
        records_seen as "recordsSeen",
        records_imported as "recordsImported",
        records_failed as "recordsFailed",
        new_tenders as "newTenders",
        updated_tenders as "updatedTenders",
        validation_errors as "validationErrors"
      from ingestion_run
      order by started_at desc
      limit 1
    `);
    response.json({ item: result.rows[0] ?? null });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

// ─── Apify webhook — triggered after each successful actor run ───────────────
//
// Configure in your Apify actor settings:
//   Webhook URL: http://your-server/api/webhooks/apify
//   Events: ACTOR.RUN.SUCCEEDED
//
app.post("/api/webhooks/apify", async (request, response) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const provided = request.headers["x-apify-webhook-secret"] ?? request.query.secret;
    if (provided !== secret) {
      return response.status(401).json({ error: "Invalid webhook secret" });
    }
  }

  const { eventType, eventData } = request.body ?? {};

  // Only process successful runs
  if (eventType && eventType !== "ACTOR.RUN.SUCCEEDED") {
    return response.json({ ok: true, skipped: true, reason: "Not a succeeded event" });
  }

  const datasetId = eventData?.defaultDatasetId ?? request.body?.resource?.defaultDatasetId;
  const apifyToken = process.env.APIFY_TOKEN;

  if (!datasetId || !apifyToken) {
    console.error("Webhook: missing datasetId or APIFY_TOKEN", { datasetId, hasToken: !!apifyToken });
    return response.status(400).json({ error: "Missing datasetId or APIFY_TOKEN" });
  }

  // Respond immediately — download + ingest runs async so Apify doesn't timeout
  response.json({ ok: true, message: "Ingestion started", datasetId });

  try {
    console.log(`Webhook: downloading Apify dataset ${datasetId} …`);
    const datasetUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&format=json&token=${apifyToken}`;
    const apifyResponse = await fetch(datasetUrl);

    if (!apifyResponse.ok) {
      throw new Error(`Apify dataset download failed: ${apifyResponse.status} ${apifyResponse.statusText}`);
    }

    const records = await apifyResponse.json();
    console.log(`Webhook: downloaded ${records.length} records, starting ingestion …`);

    const stats = await ingestFromRecords(records, {
      source: "apify-webhook",
      datasetId,
      triggeredAt: new Date().toISOString(),
    });

    console.log(`Webhook: ingestion complete — ${stats.imported} imported, ${stats.failed} failed`);
  } catch (error) {
    console.error("Webhook ingestion error:", error);
  }
});

// ─── Manual trigger (dev convenience — POST with Apify dataset ID) ───────────
app.post("/api/ingest/apify-dataset", async (request, response) => {
  const { datasetId } = request.body ?? {};
  const apifyToken = process.env.APIFY_TOKEN;

  if (!datasetId) return response.status(400).json({ error: "Missing datasetId in request body" });
  if (!apifyToken) return response.status(500).json({ error: "APIFY_TOKEN not configured" });

  response.json({ ok: true, message: "Ingestion started", datasetId });

  try {
    const url = `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&format=json&token=${apifyToken}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Apify download failed: ${res.status}`);
    const records = await res.json();
    const stats = await ingestFromRecords(records, { source: "manual-trigger", datasetId });
    console.log(`Manual ingest: ${stats.imported} imported, ${stats.failed} failed`);
  } catch (error) {
    console.error("Manual ingest error:", error);
  }
});

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
  console.log(`  Apify webhook: POST http://localhost:${port}/api/webhooks/apify`);
});
