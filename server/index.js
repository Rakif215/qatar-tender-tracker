import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { pool } from "./db.js";
import { ingestFromFile, ingestFromRecords } from "./ingest.js";
import { estimateBidRange, predictLikelyBidders } from "./intelligence.js";
import { analyzeTender } from "./similarity.js";

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
    statusGroup = "awarded",
    limit = "100",
    offset = "0",
    sortBy = "award_date",
    sortDir = "desc",
    category,
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

  if (statusGroup === "awarded") {
    where.push("t.status = 'awarded'");
  } else if (statusGroup === "non-awarded") {
    where.push("(t.status is null or t.status <> 'awarded')");
  } else if (status) {
    values.push(status);
    where.push(`t.status = $${values.length}`);
  }

  if (dateFrom) {
    values.push(dateFrom);
    if (statusGroup === "non-awarded") {
      where.push(`t.closing_date >= $${values.length}`);
    } else {
      where.push(`t.award_date >= $${values.length}`);
    }
  }

  if (dateTo) {
    values.push(dateTo);
    if (statusGroup === "non-awarded") {
      where.push(`t.closing_date <= $${values.length}`);
    } else {
      where.push(`t.award_date <= $${values.length}`);
    }
  }

  if (method) {
    values.push(method);
    where.push(`t.procurement_method = $${values.length}`);
  }

  if (entity) {
    values.push(entity);
    where.push(`e.name = $${values.length}`);
  }

  if (amountMin) {
    values.push(Number(amountMin));
    where.push(`t.awarded_value >= $${values.length}`);
  }

  if (amountMax) {
    values.push(Number(amountMax));
    where.push(`t.awarded_value <= $${values.length}`);
  }

  if (category) {
    values.push(category);
    where.push(`cat.slug = $${values.length}`);
  }

  // Allowed sort columns to prevent SQL injection
  const allowedSortColumns = {
    award_date: "t.award_date",
    closing_date: "t.closing_date",
    awarded_value: "t.awarded_value",
    entity: "e.name",
    title: "t.title",
    tender_number: "t.tender_number",
  };
  const sortColumn = allowedSortColumns[sortBy] ?? (statusGroup === "non-awarded" ? "t.tender_number" : "t.award_date");
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
    left join tender_category cat on cat.category_id = t.category_id
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
      t.published_date as "publishedDate",
      t.first_seen as "firstSeen",
      t.award_date as "awardDate",
      t.closing_date as "closingDate",
      t.awarded_value::float as "awardedAmount",
      t.currency as "awardedAmountCurrency",
      t.source_url as "sourceUrl",
      t.tender_detail_url as "tenderDetailUrl",
      winner.name as "winningCompany",
      cat.slug as "categorySlug",
      cat.name as "categoryName",
      cat.color as "categoryColor",
      cat.icon as "categoryIcon",
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
    left join tender_category cat on cat.category_id = t.category_id
    ${where.length ? `where ${where.join(" and ")}` : ""}
    group by t.tender_id, e.name, winner.name, cat.slug, cat.name, cat.color, cat.icon
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

// ─── Category Intelligence API Routes ────────────────────────────────────────

app.get("/api/categories", async (_request, response) => {
  try {
    const result = await pool.query(`
      select 
        c.category_id as "categoryId",
        c.slug,
        c.name,
        c.color,
        c.icon,
        c.sort_order as "sortOrder",
        count(t.tender_id)::int as "tenderCount",
        coalesce(sum(t.awarded_value), 0)::float as "totalAwardedValue"
      from tender_category c
      left join tender t on t.category_id = c.category_id
      group by c.category_id
      order by c.sort_order
    `);
    response.json({ items: result.rows });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/categories/:slug/stats", async (request, response) => {
  const { slug } = request.params;
  try {
    const catRes = await pool.query("select * from tender_category where slug = $1", [slug]);
    if (catRes.rowCount === 0) {
      return response.status(404).json({ error: `Category '${slug}' not found` });
    }
    const category = catRes.rows[0];

    const statsRes = await pool.query(`
      select
        count(t.tender_id)::int as "tenderCount",
        count(case when t.status = 'awarded' then 1 end)::int as "awardedCount",
        coalesce(sum(t.awarded_value), 0)::float as "totalAwardedValue",
        coalesce(avg(t.awarded_value), 0)::float as "avgAwardedValue",
        coalesce(percentile_cont(0.5) within group (order by t.awarded_value), 0)::float as "medianAwardedValue",
        coalesce(min(t.awarded_value), 0)::float as "minAwardedValue",
        coalesce(max(t.awarded_value), 0)::float as "maxAwardedValue"
      from tender t
      where t.category_id = $1
    `, [category.category_id]);

    const entityRes = await pool.query(`
      select
        e.name as entity,
        count(t.tender_id)::int as "tenderCount",
        coalesce(sum(t.awarded_value), 0)::float as "totalAwardedValue"
      from tender t
      join entity e on e.entity_id = t.entity_id
      where t.category_id = $1
      group by e.name
      order by "totalAwardedValue" desc, "tenderCount" desc
      limit 10
    `, [category.category_id]);

    const bidderRes = await pool.query(`
      select
        coalesce(avg(bidders.cnt), 0)::float as "avgBiddersPerTender"
      from (
        select count(distinct company_id) as cnt
        from bid b
        join tender t on t.tender_id = b.tender_id
        where t.category_id = $1
        group by b.tender_id
      ) bidders
    `, [category.category_id]);

    response.json({
      category: {
        categoryId: category.category_id,
        slug: category.slug,
        name: category.name,
        color: category.color,
        icon: category.icon,
        description: category.description,
      },
      stats: statsRes.rows[0],
      entities: entityRes.rows,
      avgBiddersPerTender: bidderRes.rows[0]?.avgBiddersPerTender ?? 0
    });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/categories/:slug/competitors", async (request, response) => {
  const { slug } = request.params;
  try {
    const catRes = await pool.query("select category_id from tender_category where slug = $1", [slug]);
    if (catRes.rowCount === 0) {
      return response.status(404).json({ error: `Category '${slug}' not found` });
    }
    const categoryId = catRes.rows[0].category_id;

    // Fetch total awarded value in this category first
    const totalAwardedRes = await pool.query(
      "select coalesce(sum(awarded_value), 0)::float as total from tender where category_id = $1",
      [categoryId]
    );
    const totalAwarded = totalAwardedRes.rows[0].total || 1; // avoid division by zero

    const competitorsRes = await pool.query(`
      select
        c.company_id as "companyId",
        c.name as "companyName",
        c.commercial_registration_number as "commercialRegistrationNumber",
        count(b.bid_id)::int as "totalBids",
        count(case when b.is_winner then 1 end)::int as "wins",
        case 
          when count(b.bid_id) > 0 then (count(case when b.is_winner then 1 end)::float / count(b.bid_id)::float * 100)::float 
          else 0.0 
        end as "winRate",
        coalesce(avg(b.bid_value), 0)::float as "avgBid",
        coalesce(avg(case when b.is_winner then b.approved_value end), 0)::float as "avgWinningBid",
        coalesce(sum(case when b.is_winner then b.approved_value else 0 end), 0)::float as "totalWonAmount",
        (coalesce(sum(case when b.is_winner then b.approved_value else 0 end), 0)::float / $2::float * 100)::float as "marketShare",
        array_to_string(array_agg(distinct e.name), ', ') as "entitiesServed"
      from bid b
      join company c on c.company_id = b.company_id
      join tender t on t.tender_id = b.tender_id
      left join entity e on e.entity_id = t.entity_id
      where t.category_id = $1
      group by c.company_id, c.name, c.commercial_registration_number
      order by "wins" desc, "totalBids" desc
    `, [categoryId, totalAwarded]);

    response.json({ items: competitorsRes.rows });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

// ─── Company Intelligence API Routes ─────────────────────────────────────────

app.get("/api/companies", async (request, response) => {
  const { q = "", limit = "50" } = request.query;
  try {
    const queryStr = q.trim() ? `%${q.trim()}%` : "%";
    const result = await pool.query(`
      select
        c.company_id as "companyId",
        c.name as "companyName",
        c.commercial_registration_number as "commercialRegistrationNumber",
        count(b.bid_id)::int as "totalBids",
        count(case when b.is_winner then 1 end)::int as "wins",
        case 
          when count(b.bid_id) > 0 then (count(case when b.is_winner then 1 end)::float / count(b.bid_id)::float * 100)::float 
          else 0.0 
        end as "winRate",
        coalesce(sum(case when b.is_winner then b.approved_value else 0 end), 0)::float as "totalWonAmount"
      from company c
      left join bid b on b.company_id = c.company_id
      where c.name ilike $1
      group by c.company_id, c.name, c.commercial_registration_number
      order by "wins" desc, "totalBids" desc
      limit $2
    `, [queryStr, Number(limit)]);
    response.json({ items: result.rows });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/companies/:id", async (request, response) => {
  const { id } = request.params;
  try {
    const companyRes = await pool.query(
      `select company_id as "companyId", name, commercial_registration_number as "commercialRegistrationNumber", classification
       from company where company_id = $1`,
      [id]
    );
    if (companyRes.rowCount === 0) {
      return response.status(404).json({ error: `Company with ID ${id} not found` });
    }
    const company = companyRes.rows[0];

    const statsRes = await pool.query(`
      select
        count(b.bid_id)::int as "totalBids",
        count(case when b.is_winner then 1 end)::int as "wins",
        coalesce(avg(b.bid_value), 0)::float as "avgBid",
        coalesce(sum(case when b.is_winner then b.approved_value else 0 end), 0)::float as "totalWonAmount",
        count(distinct t.entity_id)::int as "entitiesServedCount"
      from bid b
      join tender t on t.tender_id = b.tender_id
      where b.company_id = $1
    `, [id]);

    response.json({
      company,
      stats: statsRes.rows[0]
    });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/companies/:id/bids", async (request, response) => {
  const { id } = request.params;
  try {
    const bidsRes = await pool.query(`
      select
        b.bid_id as "bidId",
        b.bid_value::float as "bidValue",
        b.approved_value::float as "approvedValue",
        b.is_winner as "isWinner",
        b.source,
        b.notes,
        b.created_at as "createdAt",
        t.tender_id as "tenderId",
        t.tender_number as "tenderNumber",
        t.title as "tenderTitle",
        t.award_date as "awardDate",
        t.closing_date as "closingDate",
        e.name as entity,
        cat.slug as "categorySlug",
        cat.name as "categoryName",
        cat.color as "categoryColor"
      from bid b
      join tender t on t.tender_id = b.tender_id
      left join entity e on e.entity_id = t.entity_id
      left join tender_category cat on cat.category_id = t.category_id
      where b.company_id = $1
      order by t.award_date desc, t.closing_date desc
    `, [id]);
    response.json({ items: bidsRes.rows });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/companies/:id/category-stats", async (request, response) => {
  const { id } = request.params;
  try {
    const statsRes = await pool.query(`
      select
        cat.slug,
        cat.name as "categoryName",
        cat.color as "categoryColor",
        cat.icon as "categoryIcon",
        count(b.bid_id)::int as "totalBids",
        count(case when b.is_winner then 1 end)::int as "wins",
        case 
          when count(b.bid_id) > 0 then (count(case when b.is_winner then 1 end)::float / count(b.bid_id)::float * 100)::float 
          else 0.0 
        end as "winRate",
        coalesce(sum(case when b.is_winner then b.approved_value else 0 end), 0)::float as "totalWonAmount"
      from bid b
      join tender t on t.tender_id = b.tender_id
      join tender_category cat on cat.category_id = t.category_id
      where b.company_id = $1
      group by cat.slug, cat.name, cat.color, cat.icon
      order by "totalBids" desc
    `, [id]);
    response.json({ items: statsRes.rows });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

// ─── Predictive Intelligence API Routes ──────────────────────────────────────

app.get("/api/intelligence/bid-estimate", async (request, response) => {
  const { category, entity } = request.query;
  if (!category) {
    return response.status(400).json({ error: "Missing required parameter 'category'" });
  }
  try {
    const estimate = await estimateBidRange(category, entity || null);
    response.json(estimate);
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/intelligence/likely-bidders", async (request, response) => {
  const { category, entity } = request.query;
  if (!category) {
    return response.status(400).json({ error: "Missing required parameter 'category'" });
  }
  try {
    const bidders = await predictLikelyBidders(category, entity || null);
    response.json({ items: bidders });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/intelligence/analyze-tender", async (request, response) => {
  const { text, topN } = request.body ?? {};
  if (!text?.trim()) {
    return response.status(400).json({ error: "Missing 'text' in request body" });
  }
  try {
    const result = await analyzeTender(text.trim(), topN || 20);
    response.json(result);
  } catch (error) {
    console.error("Analyze tender error:", error);
    response.status(500).json({ error: error.message });
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

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
  console.log(`  Apify webhook: POST http://localhost:${port}/api/webhooks/apify`);
});
