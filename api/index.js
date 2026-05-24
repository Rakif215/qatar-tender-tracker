/**
 * Vercel Serverless Function — wraps the entire Express app.
 * Vercel routes all /api/* requests here via vercel.json rewrites.
 *
 * All environment variables (DATABASE_URL, APIFY_TOKEN, WEBHOOK_SECRET)
 * must be set in the Vercel project dashboard → Settings → Environment Variables.
 */

import "dotenv/config";
import cors from "cors";
import express from "express";
import { Pool } from "pg";
import { ingestFromRecords } from "../server/ingest.js";

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// ── DB pool ───────────────────────────────────────────────────────────────────
// On Vercel, DATABASE_URL must be set as an environment variable.
// Use Neon (neon.tech) — free serverless Postgres that works perfectly with Vercel.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon requires SSL in production
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 5, // keep pool small for serverless
});

async function withClient(callback) {
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("select 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get("/api/stats", async (_req, res) => {
  try {
    const [counts, lastRun] = await Promise.all([
      pool.query(`
        select
          (select count(*) from tender)::int as "totalTenders",
          (select count(*) from tender where status = 'awarded')::int as "awardedTenders",
          (select count(*) from company)::int as "totalCompanies",
          (select count(*) from entity)::int as "totalEntities",
          (select coalesce(sum(awarded_value),0)::float from tender where awarded_value is not null) as "totalAwardedValue"
      `),
      pool.query(`
        select run_id as "runId", status, started_at as "startedAt",
               finished_at as "finishedAt", records_imported as "recordsImported",
               new_tenders as "newTenders", updated_tenders as "updatedTenders"
        from ingestion_run order by started_at desc limit 1
      `),
    ]);
    res.json({ ...counts.rows[0], lastRun: lastRun.rows[0] ?? null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Tenders ───────────────────────────────────────────────────────────────────
app.get("/api/tenders", async (req, res) => {
  const {
    q, dateFrom, dateTo, method, amountMin, amountMax, entity,
    limit = "50", offset = "0", sortBy = "award_date", sortDir = "desc",
  } = req.query;

  const values = [];
  const where = [];

  if (q?.trim()) {
    values.push(`%${q.trim()}%`);
    const i = values.length;
    where.push(`(t.tender_number ilike $${i} or t.title ilike $${i} or e.name ilike $${i} or winner.name ilike $${i} or exists (select 1 from bid bq join company cq on cq.company_id=bq.company_id where bq.tender_id=t.tender_id and cq.name ilike $${i}))`);
  }
  if (dateFrom) { values.push(dateFrom); where.push(`t.award_date >= $${values.length}`); }
  if (dateTo)   { values.push(dateTo);   where.push(`t.award_date <= $${values.length}`); }
  if (method)   { values.push(method);   where.push(`t.procurement_method = $${values.length}`); }
  if (entity)   { values.push(entity);   where.push(`e.name = $${values.length}`); }
  if (amountMin){ values.push(Number(amountMin)); where.push(`t.awarded_value >= $${values.length}`); }
  if (amountMax){ values.push(Number(amountMax)); where.push(`t.awarded_value <= $${values.length}`); }

  const cols = { award_date:"t.award_date", awarded_value:"t.awarded_value", entity:"e.name", title:"t.title", tender_number:"t.tender_number" };
  const col = cols[sortBy] ?? "t.award_date";
  const dir = sortDir === "asc" ? "asc" : "desc";
  const wh  = where.length ? `where ${where.join(" and ")}` : "";

  values.push(Math.min(Number(limit)||50, 200));
  const li = values.length;
  values.push(Math.max(Number(offset)||0, 0));
  const oi = values.length;
  const countVals = values.slice(0, values.length - 2);

  try {
    const [rows, count] = await Promise.all([
      pool.query(`
        select t.tender_id as id, t.tender_number as "tenderNumber", t.title, t.status,
               e.name as entity, t.procurement_method as "procurementMethod",
               t.award_date as "awardDate", t.awarded_value::float as "awardedAmount",
               t.currency as "awardedAmountCurrency", t.source_url as "sourceUrl",
               t.tender_detail_url as "tenderDetailUrl", winner.name as "winningCompany",
               coalesce(json_agg(json_build_object('id',b.bid_id,'companyName',c.name,'commercialRegistrationNumber',c.commercial_registration_number,'approvedValue',b.approved_value::float,'proposalAmount',b.bid_value::float,'localValueRatio',b.local_value_ratio::float,'financialResult',b.financial_result::float,'notes',b.notes,'isWinner',b.is_winner,'source',b.source) order by b.is_winner desc, coalesce(b.bid_value,b.approved_value) asc nulls last, c.name asc) filter (where b.bid_id is not null),'[]'::json) as companies
        from tender t
        left join entity e on e.entity_id=t.entity_id
        left join company winner on winner.company_id=t.awarded_company_id
        left join bid b on b.tender_id=t.tender_id
        left join company c on c.company_id=b.company_id
        ${wh} group by t.tender_id,e.name,winner.name
        order by ${col} ${dir} nulls last, t.updated_at desc
        limit $${li} offset $${oi}
      `, values),
      pool.query(`select count(distinct t.tender_id)::int as total from tender t left join entity e on e.entity_id=t.entity_id left join company winner on winner.company_id=t.awarded_company_id ${wh}`, countVals),
    ]);
    res.json({ items: rows.rows, total: count.rows[0].total, limit: Number(limit), offset: Number(offset) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Filter options ────────────────────────────────────────────────────────────
app.get("/api/procurement-methods", async (_req, res) => {
  try {
    const r = await pool.query(`select distinct procurement_method as method from tender where procurement_method is not null and procurement_method<>'' order by procurement_method`);
    res.json({ items: r.rows.map(row => row.method) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/entities", async (_req, res) => {
  try {
    const r = await pool.query(`select distinct e.name as entity from tender t join entity e on e.entity_id=t.entity_id where e.name is not null and e.name<>'' order by e.name`);
    res.json({ items: r.rows.map(row => row.entity) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Latest ingestion run ──────────────────────────────────────────────────────
app.get("/api/ingestion-runs/latest", async (_req, res) => {
  try {
    const r = await pool.query(`select run_id as "runId", source, status, started_at as "startedAt", finished_at as "finishedAt", records_seen as "recordsSeen", records_imported as "recordsImported", records_failed as "recordsFailed", new_tenders as "newTenders", updated_tenders as "updatedTenders", validation_errors as "validationErrors" from ingestion_run order by started_at desc limit 1`);
    res.json({ item: r.rows[0] ?? null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Apify webhook — auto-ingest after every successful actor run ───────────────
app.post("/api/webhooks/apify", async (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const provided = req.headers["x-apify-webhook-secret"] ?? req.query.secret;
    if (provided !== secret) return res.status(401).json({ error: "Invalid webhook secret" });
  }

  const { eventType, eventData } = req.body ?? {};
  if (eventType && eventType !== "ACTOR.RUN.SUCCEEDED") {
    return res.json({ ok: true, skipped: true });
  }

  const datasetId = eventData?.defaultDatasetId ?? req.body?.resource?.defaultDatasetId;
  const apifyToken = process.env.APIFY_TOKEN;
  if (!datasetId || !apifyToken) return res.status(400).json({ error: "Missing datasetId or APIFY_TOKEN" });

  // Respond immediately so Apify doesn't timeout waiting
  res.json({ ok: true, message: "Ingestion started", datasetId });

  try {
    const url = `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&format=json&token=${apifyToken}`;
    const apifyRes = await fetch(url);
    if (!apifyRes.ok) throw new Error(`Apify download failed: ${apifyRes.status}`);
    const records = await apifyRes.json();
    await ingestFromRecords(records, { source: "apify-webhook", datasetId });
    console.log(`Webhook ingest complete: ${records.length} records`);
  } catch (e) {
    console.error("Webhook ingest error:", e.message);
  }
});

// ── Manual trigger: pull latest Apify dataset by ID ──────────────────────────
app.post("/api/ingest/apify-dataset", async (req, res) => {
  const { datasetId } = req.body ?? {};
  const apifyToken = process.env.APIFY_TOKEN;
  if (!datasetId) return res.status(400).json({ error: "Missing datasetId" });
  if (!apifyToken) return res.status(500).json({ error: "APIFY_TOKEN not set" });

  res.json({ ok: true, message: "Ingestion started", datasetId });

  try {
    const url = `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&format=json&token=${apifyToken}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Apify download failed: ${r.status}`);
    const records = await r.json();
    const stats = await ingestFromRecords(records, { source: "manual-trigger", datasetId });
    console.log(`Manual ingest done: ${stats.imported} imported, ${stats.failed} failed`);
  } catch (e) {
    console.error("Manual ingest error:", e.message);
  }
});

// ── Trigger a new Apify actor run ─────────────────────────────────────────────
app.post("/api/scraper/trigger", async (req, res) => {
  const apifyToken = process.env.APIFY_TOKEN;
  const actorId = process.env.APIFY_ACTOR_ID;
  if (!apifyToken || !actorId) return res.status(500).json({ error: "APIFY_TOKEN or APIFY_ACTOR_ID not set" });

  try {
    const r = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${apifyToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        useApifyProxy: true,
        apifyProxyGroups: ["RESIDENTIAL"],
        apifyProxyCountryCode: "QA",
        maxConcurrency: 1,
        maxRequestsPerCrawl: 300,
        ...(req.body ?? {}),
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message ?? "Failed to trigger run" });
    res.json({ ok: true, runId: data.data?.id, datasetId: data.data?.defaultDatasetId, status: data.data?.status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Scraper run status ────────────────────────────────────────────────────────
app.get("/api/scraper/status/:runId", async (req, res) => {
  const apifyToken = process.env.APIFY_TOKEN;
  if (!apifyToken) return res.status(500).json({ error: "APIFY_TOKEN not set" });

  try {
    const r = await fetch(`https://api.apify.com/v2/actor-runs/${req.params.runId}?token=${apifyToken}`);
    const data = await r.json();
    res.json({
      status: data.data?.status,
      startedAt: data.data?.startedAt,
      finishedAt: data.data?.finishedAt,
      datasetId: data.data?.defaultDatasetId,
      itemCount: data.data?.stats?.outputItemCount ?? 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default app;
