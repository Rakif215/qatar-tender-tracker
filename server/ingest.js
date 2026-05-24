import crypto from "node:crypto";
import fs from "node:fs/promises";
import { pool, withClient } from "./db.js";

// ─── Exported module API ────────────────────────────────────────────────────

export async function ingestFromFile(inputPath) {
  const raw = await fs.readFile(inputPath, "utf8");
  const records = JSON.parse(raw);

  if (!Array.isArray(records)) {
    throw new Error("Expected a JSON array exported from the Apify dataset.");
  }

  return runIngestion(records, { source: "apify-json", summary: { inputPath } });
}

export async function ingestFromRecords(records, meta = {}) {
  if (!Array.isArray(records)) {
    throw new Error("Expected an array of records.");
  }
  return runIngestion(records, {
    source: meta.source ?? "apify-webhook",
    summary: meta,
  });
}

// ─── CLI entrypoint — only runs when called directly, not when imported ──────

const isMain = process.argv[1]?.endsWith("ingest.js");
if (isMain) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: node server/ingest.js path/to/data.json");
    process.exit(1);
  }
  const runSummary = await ingestFromFile(inputPath);
  await pool.end();
  console.log(JSON.stringify(runSummary, null, 2));
}

// ─── Core ingestion logic ───────────────────────────────────────────────────

async function runIngestion(records, { source, summary }) {
  return withClient(async (client) => {
    await client.query("begin");
    const run = await client.query(
      `
        insert into ingestion_run (source, summary)
        values ($1, $2)
        returning run_id
      `,
      [source, summary],
    );
    const runId = run.rows[0].run_id;
    const stats = {
      runId,
      seen: records.length,
      imported: 0,
      failed: 0,
      newTenders: 0,
      updatedTenders: 0,
      validationErrors: [],
    };

    try {
      for (const [index, record] of records.entries()) {
        const errors = validateRecord(record);

        if (errors.length) {
          stats.failed += 1;
          stats.validationErrors.push({
            index,
            tenderId: record.tenderId ?? null,
            tenderNumber: record.tenderNumber ?? null,
            errors,
          });
          continue;
        }

        const result = await upsertRecord(client, record);
        stats.imported += 1;
        if (result.created) stats.newTenders += 1;
        else stats.updatedTenders += 1;
      }

      const status = stats.failed ? "completed_with_errors" : "succeeded";
      await client.query(
        `
          update ingestion_run
          set
            status = $2,
            finished_at = now(),
            records_seen = $3,
            records_imported = $4,
            records_failed = $5,
            new_tenders = $6,
            updated_tenders = $7,
            validation_errors = $8,
            summary = $9
          where run_id = $1
        `,
        [
          runId,
          status,
          stats.seen,
          stats.imported,
          stats.failed,
          stats.newTenders,
          stats.updatedTenders,
          JSON.stringify(stats.validationErrors),
          JSON.stringify({
            ...summary,
            importedAt: new Date().toISOString(),
          }),
        ],
      );

      await client.query("commit");
      return stats;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function upsertRecord(client, record) {
  const entityId = record.entity ? await upsertEntity(client, record.entity) : null;
  const winnerName = record.winningCompany ?? record.awardedCompanies?.find((company) => company.isWinner)?.companyName;
  const awardedCompanyId = winnerName ? await upsertCompany(client, { companyName: winnerName }) : null;
  const tenderHash = contentHash(record);

  const existing = await client.query("select tender_id from tender where tender_id = $1", [record.tenderId]);
  const tender = await client.query(
    `
      insert into tender (
        tender_id,
        tender_number,
        title,
        entity_id,
        procurement_method,
        category,
        status,
        currency,
        published_date,
        closing_date,
        technical_open_date,
        financial_open_date,
        award_date,
        awarded_value,
        awarded_company_id,
        source_url,
        tender_detail_url,
        last_seen,
        fetched_at,
        raw,
        updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, coalesce($8, 'QAR'), $9, $10, $11, $12, $13,
        $14, $15, $16, $17, now(), $18, $19, now()
      )
      on conflict (tender_id) do update set
        tender_number = excluded.tender_number,
        title = excluded.title,
        entity_id = excluded.entity_id,
        procurement_method = excluded.procurement_method,
        category = excluded.category,
        status = excluded.status,
        currency = excluded.currency,
        published_date = excluded.published_date,
        closing_date = excluded.closing_date,
        technical_open_date = excluded.technical_open_date,
        financial_open_date = excluded.financial_open_date,
        award_date = excluded.award_date,
        awarded_value = excluded.awarded_value,
        awarded_company_id = excluded.awarded_company_id,
        source_url = excluded.source_url,
        tender_detail_url = excluded.tender_detail_url,
        last_seen = now(),
        fetched_at = excluded.fetched_at,
        raw = excluded.raw,
        updated_at = now()
      returning tender_id
    `,
    [
      record.tenderId,
      record.tenderNumber,
      record.title,
      entityId,
      record.procurementMethod,
      record.requestTypes ?? null,
      statusFromRecord(record),
      record.awardedAmountCurrency ?? record.currency ?? "QAR",
      toDate(record.publishedDate),
      toTimestamp(record.closingDate),
      toTimestamp(record.technicalOpenDate),
      toTimestamp(record.financialOpenDate),
      toDate(record.awardDate),
      record.awardedAmount ?? null,
      awardedCompanyId,
      record.sourceUrl,
      record.tenderDetailUrl,
      toTimestamp(record.fetchedAt),
      record,
    ],
  );

  await upsertRawPage(client, record, tenderHash);

  const tenderId = tender.rows[0].tender_id;
  await replaceBids(client, tenderId, record);

  return { created: !existing.rowCount };
}

async function replaceBids(client, tenderId, record) {
  await client.query("delete from bid where tender_id = $1", [tenderId]);

  const awarded = record.awardedCompanies ?? [];
  const opened = record.openedCompanies ?? [];

  for (const company of awarded) {
    await insertBid(client, tenderId, company, "awarded");
  }

  for (const company of opened) {
    await insertBid(client, tenderId, company, "opened");
  }
}

async function insertBid(client, tenderId, company, source) {
  if (!company.companyName) return;
  const companyId = await upsertCompany(client, company);
  await client.query(
    `
      insert into bid (
        tender_id,
        company_id,
        bid_value,
        approved_value,
        currency,
        is_winner,
        local_value_ratio,
        financial_result,
        notes,
        source,
        raw,
        updated_at
      )
      values ($1, $2, $3, $4, coalesce($5, 'QAR'), $6, $7, $8, $9, $10, $11, now())
      on conflict (tender_id, company_id, source) do update set
        bid_value = excluded.bid_value,
        approved_value = excluded.approved_value,
        currency = excluded.currency,
        is_winner = excluded.is_winner,
        local_value_ratio = excluded.local_value_ratio,
        financial_result = excluded.financial_result,
        notes = excluded.notes,
        raw = excluded.raw,
        updated_at = now()
    `,
    [
      tenderId,
      companyId,
      company.proposalAmount ?? company.approvedValue ?? null,
      company.approvedValue ?? null,
      company.proposalCurrency ?? company.approvedValueCurrency ?? "QAR",
      Boolean(company.isWinner),
      company.localValueRatio ?? null,
      company.financialResult ?? null,
      company.notes ?? null,
      source,
      company,
    ],
  );
}

async function upsertEntity(client, name) {
  const normalized = normalizeName(name);
  const result = await client.query(
    `
      insert into entity (name, name_normalized, updated_at)
      values ($1, $2, now())
      on conflict (name_normalized) do update set
        name = excluded.name,
        updated_at = now()
      returning entity_id
    `,
    [cleanText(name), normalized],
  );
  return result.rows[0].entity_id;
}

async function upsertCompany(client, company) {
  const name = cleanText(company.companyName ?? company.name);
  const normalized = normalizeName(name);
  const result = await client.query(
    `
      insert into company (
        name,
        name_raw,
        name_normalized,
        commercial_registration_number,
        updated_at
      )
      values ($1, $2, $3, $4, now())
      on conflict (name_normalized) do update set
        name = excluded.name,
        name_raw = coalesce(company.name_raw, excluded.name_raw),
        commercial_registration_number = coalesce(excluded.commercial_registration_number, company.commercial_registration_number),
        updated_at = now()
      returning company_id
    `,
    [name, company.companyName ?? company.name, normalized, company.commercialRegistrationNumber ?? null],
  );
  return result.rows[0].company_id;
}

async function upsertRawPage(client, record, hash) {
  const pageType = record.pageType ?? (record.awardedCompanies ? "companies" : "details");
  const url = record.sourceUrl ?? record.tenderDetailUrl ?? `monaqasat:${record.tenderId}`;
  await client.query(
    `
      insert into raw_page (
        source_tender_id,
        page_type,
        url,
        http_status,
        fetched_at,
        html_path,
        raw_html_key,
        content_hash,
        content
      )
      values ($1, $2, $3, $4, coalesce($5, now()), $6, $7, $8, $9)
      on conflict (source_tender_id, page_type, content_hash) do nothing
    `,
    [
      record.tenderId,
      pageType,
      url,
      record.httpStatus ?? 200,
      toTimestamp(record.fetchedAt),
      record.htmlPath ?? null,
      record.rawHtmlKey ?? null,
      hash,
      record,
    ],
  );
}

function validateRecord(record) {
  const errors = [];
  if (!record || typeof record !== "object") return ["record is not an object"];
  if (!record.tenderId) errors.push("missing tenderId");
  if (!record.tenderNumber) errors.push("missing tenderNumber");
  if (record.tenderNumber && (record.tenderNumber.includes("Type Subject") || record.tenderNumber.length > 50)) {
    errors.push("tenderNumber looks like a table header or is invalid");
  }
  if (!record.title) errors.push("missing title");
  if (!record.entity) errors.push("missing entity");


  if (record.pageType === "award_report" || record.awardedAmount || record.awardedCompanies?.length) {
    const winners = [
      ...(record.awardedCompanies ?? []),
      ...(record.openedCompanies ?? []),
    ].filter((company) => company.isWinner);

    if (!record.winningCompany && !winners.length) errors.push("awarded tender missing winner");
    if (record.awardedAmount && winners[0]) {
      const winnerValue = winners[0].approvedValue ?? winners[0].proposalAmount;
      if (winnerValue && Math.abs(Number(record.awardedAmount) - Number(winnerValue)) > 0.01) {
        errors.push("awardedAmount does not match winning bid value");
      }
    }
  }

  if (record.publishedDate && record.closingDate && new Date(record.publishedDate) > new Date(record.closingDate)) {
    errors.push("publishedDate is after closingDate");
  }

  if (record.closingDate && record.awardDate && new Date(record.closingDate) > new Date(record.awardDate)) {
    errors.push("closingDate is after awardDate");
  }

  return errors;
}

function statusFromRecord(record) {
  if (record.pageType === "award_report" || record.awardDate || record.awardedAmount) return "awarded";
  return record.status ?? "unknown";
}

function toDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  // Must look like YYYY-MM-DD or DD/MM/YYYY
  if (!/^\d{4}-\d{2}-\d{2}/.test(s) && !/^\d{2}\/\d{2}\/\d{4}/.test(s)) return null;
  return s.slice(0, 10);
}

function toTimestamp(value) {
  if (!value) return null;
  const s = String(value).trim();
  // Must look like a date/datetime — reject anything that doesn't start with a digit or ISO prefix
  if (!/^\d/.test(s)) return null;
  // Reject if it's clearly too long to be a date (e.g. a title got in here)
  if (s.length > 30) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return s;
}

function contentHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeName(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/\b(wll|w\.l\.l|llc|ltd|limited|co|company|corporation|corp)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
