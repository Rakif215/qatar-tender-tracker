import { Actor, log } from "apify";
import { CheerioCrawler, KeyValueStore, RequestQueue } from "crawlee";

const BASE_URL = "https://monaqasat.mof.gov.qa";
const START_PATHS = [
  "/TendersOnlineServices/AvailableMinistriesTenders/1",
  "/TendersOnlineServices/AwardedTenders/1",
];

await Actor.init();

const input = await Actor.getInput() ?? {};
const maxRequestsPerCrawl = input.maxRequestsPerCrawl ?? 200;
const maxRequestRetries = input.maxRequestRetries ?? 1;

const startPage = input.startPage ?? 1;
const onlyAwarded = input.onlyAwarded ?? false;
const onlyAvailable = input.onlyAvailable ?? false;

let startPaths = [];
if (onlyAwarded) {
  startPaths.push(`/TendersOnlineServices/AwardedTenders/${startPage}`);
} else if (onlyAvailable) {
  startPaths.push(`/TendersOnlineServices/AvailableMinistriesTenders/${startPage}`);
} else {
  startPaths.push(`/TendersOnlineServices/AvailableMinistriesTenders/${startPage}`);
  startPaths.push(`/TendersOnlineServices/AwardedTenders/${startPage}`);
}

const startUrls = input.startUrls?.length
  ? input.startUrls.map((item) => item.url ?? item)
  : startPaths.map((path) => `${BASE_URL}${path}`);

const proxyConfiguration = input.useApifyProxy
  ? await Actor.createProxyConfiguration({
      groups: input.apifyProxyGroups?.length ? input.apifyProxyGroups : undefined,
      countryCode: input.apifyProxyCountryCode || undefined,
    })
  : undefined;

const queue = await RequestQueue.open();
for (const url of startUrls) {
  await queue.addRequest({ url, userData: { label: labelFromUrl(url), sourceType: sourceTypeFromUrl(url) } });
}

const rawStore = await KeyValueStore.open("monaqasat-raw-html");
const detailByTenderNumber = new Map();
const emittedTenderNumbers = new Set();

const crawler = new CheerioCrawler({
  requestQueue: queue,
  proxyConfiguration,
  maxRequestsPerCrawl,
  maxRequestRetries: input.maxRequestRetries ?? 5,
  requestHandlerTimeoutSecs: 90,
  navigationTimeoutSecs: input.navigationTimeoutSecs ?? 45,
  // Single concurrent worker — required by the technical spec and government site politeness
  maxConcurrency: 1,
  minConcurrency: 1,
  // Block images, fonts, and tracking scripts to save residential proxy bandwidth ($8/GB)
  preNavigationHooks: [
    async ({ request, session }) => {
      log.info(`Fetching [${request.userData.label}] ${request.url}`);
      // Polite delay: 2–4 seconds between requests (spec: 1 req / 2–5 s)
      const delayMs = 2000 + Math.floor(Math.random() * 2000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    },
  ],
  async requestHandler({ request, $, body }) {
    const htmlKey = rawKey(request.url);
    await rawStore.setValue(htmlKey, body.toString(), {
      contentType: "text/html; charset=utf-8",
    });

    if (request.userData.label === "DETAIL") {
      const tender = {
        ...parseTenderDetail($, request.url),
        rawHtmlKey: htmlKey,
      };
      if (tender.tenderNumber) detailByTenderNumber.set(tender.tenderNumber, tender);

      if (request.userData.sourceType === "AWARDED" && tender.tenderId) {
        await queue.addRequest(
          {
            url: `${BASE_URL}/TendersOnlineServices/TenderCompaniesDetails/${tender.tenderId}`,
            userData: { label: "REPORT", sourceType: "AWARDED" },
          },
          { forefront: true },
        );
      } else {
        await pushRecord({
          ...tender,
          pageType: "tender_detail",
          sourceUrl: request.url,
          rawHtmlKey: htmlKey,
        });
      }
      return;
    }

    if (request.userData.label === "REPORT") {
      const report = parseTenderCompaniesReport($, request.url);
      const detail = report.tenderNumber ? detailByTenderNumber.get(report.tenderNumber) : undefined;
      await pushRecord({
        ...detail,
        ...report,
        pageType: "award_report",
        sourceUrl: request.url,
        tenderDetailUrl: report.tenderId
          ? `${BASE_URL}/TendersOnlineServices/TenderDetails/${report.tenderId}`
          : undefined,
        rawHtmlKey: htmlKey,
      });
      if (report.tenderNumber) emittedTenderNumbers.add(report.tenderNumber);
      return;
    }

    const discovered = discoverTenderLinks($);
    for (const link of discovered.detailUrls) {
      await queue.addRequest({
        url: new URL(link, BASE_URL).toString(),
        userData: { label: "DETAIL", sourceType: request.userData.sourceType },
      });
    }
    if (!onlyAvailable) {
      for (const link of discovered.reportUrls) {
        await queue.addRequest(
          {
            url: new URL(link, BASE_URL).toString(),
            userData: { label: "REPORT", sourceType: "AWARDED" },
          },
          { forefront: true },
        );
      }
    }
    for (const link of discovered.pageUrls) {
      const pageUrl = new URL(link, BASE_URL).toString();
      const sourceType = sourceTypeFromUrl(pageUrl);
      if (onlyAwarded && sourceType !== "AWARDED") continue;
      if (onlyAvailable && sourceType !== "AVAILABLE") continue;
      await queue.addRequest({
        url: pageUrl,
        userData: { label: "LIST", sourceType },
      });
    }
  },
  failedRequestHandler({ request, error }) {
    log.error(`Failed ${request.url}: ${error.message}`);
  },
});

await crawler.run();
for (const tender of detailByTenderNumber.values()) {
  if (!emittedTenderNumbers.has(tender.tenderNumber)) {
    await pushRecord({
      ...tender,
      pageType: "tender_detail",
      sourceUrl: tender.sourceUrl,
      rawHtmlKey: tender.rawHtmlKey,
    });
  }
}
await Actor.exit();

function discoverTenderLinks($) {
  const detailUrls = new Set();
  const reportUrls = new Set();
  const pageUrls = new Set();

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;

    if (href.includes("/TendersOnlineServices/TenderDetails/")) {
      detailUrls.add(href);
    }

    if (href.includes("/TendersOnlineServices/TenderCompaniesDetails/")) {
      reportUrls.add(href);
    }

    if (
      href.includes("/TendersOnlineServices/AvailableMinistriesTenders/") ||
      href.includes("/TendersOnlineServices/AwardedTenders/")
    ) {
      pageUrls.add(href);
    }
  });

  return {
    detailUrls: [...detailUrls],
    reportUrls: [...reportUrls],
    pageUrls: [...pageUrls],
  };
}

function parseTenderDetail($, url) {
  const tenderId = getTenderIdFromUrl(url);
  const tables = extractTables($);
  const primary = tables.find((row) => row["Tender number"] && row.Subject) ?? {};
  
  const tenderNumber = primary["Tender number"] ?? null;
  if (tenderNumber && (tenderNumber.includes("Type Subject") || tenderNumber.includes("Tender number") || tenderNumber.length > 50)) {
    return {};
  }

  const secondary = tables.find((row) => row["Brief Description"]) ?? {};

  return {
    tenderId,
    tenderNumber,
    title: primary.Subject ?? ($("h1, h2, .page-title").first().text().trim() || null),

    entity: primary.Ministry ?? null,
    entityTenderNumber: primary["Entity's tender number"] ?? null,
    procurementMethod: primary.Type ?? null,
    requestTypes: primary["Request Types"] ?? null,
    envelopesSystem: primary["Envelopes system"] ?? null,
    tenderBond: parseMoney(primary["Tender Bond"]),
    documentValue: parseMoney(primary["Documents value (QR)"]),
    currency: "QAR",
    closingDate: parseDate(primary["Closing Date"]),
    briefDescription: secondary["Brief Description"] ?? null,
    targetedTendererType: secondary["Targeted Tenderer Type"] ?? null,
    serviceDeliveryMethod: secondary["Service Delivery Method"] ?? null,
    auctionType: secondary["Auction Type"] ?? null,
    localValueSystem: secondary["Local Value System"] ?? null,
    tenderValidityPeriodDays: parseInteger(secondary["Tender Validity Period"]),
    evaluationBasis: secondary["Evaluation Basis"] ?? null,
    sourceUrl: url,
  };
}

function parseTenderCompaniesReport($, url) {
  const tenderNumber = textById($, "lbl_num");
  if (tenderNumber && (tenderNumber.includes("Type Subject") || tenderNumber.includes("Tender number") || tenderNumber.length > 50)) {
    return {};
  }

  const awardedCompanies = getSectionTableRows($, "Awarded companies data").map((row) => ({
    companyName: cleanText(row["Company name"]),
    commercialRegistrationNumber: cleanText(row["Commercial Registration Number"]),
    commercialRegistrationNumbers: splitRegistrationNumbers(row["Commercial Registration Number"]),
    approvedValue: parseMoney(row["Approved Value"]),
    approvedValueCurrency: currencyFromText(row["Approved Value"]) ?? "QAR",
    financialResult: parseMoney(row["Financial Result"]),
    approvedItems: cleanText(row["Approved Items"]),
    isWinner: true,
  }));

  const openedCompanies = getSectionTableRows($, "Technical/Financial Opened Companies Data").map((row) => ({
    companyName: cleanText(row["Company name"]),
    commercialRegistrationNumber: cleanText(row["Commercial Registration Number"]),
    commercialRegistrationNumbers: splitRegistrationNumbers(row["Commercial Registration Number"]),
    proposalAmount: parseMoney(row["Proposal amount"]),
    proposalCurrency: currencyFromText(row["Proposal amount"]) ?? "QAR",
    localValueRatio: parseMoney(row["Local Value Ratio"]),
    financialResult: parseMoney(row["Financial Result"]),
    notes: cleanText(row.Notes),
    isWinner: awardedCompanies.some(
      (winner) => normalizeName(winner.companyName) === normalizeName(row["Company name"]),
    ),
  }));

  return {
    tenderId: getTenderIdFromUrl(url),
    tenderNumber,
    title: textById($, "lbl_subject"),

    entity: textById($, "lblRequesterEntity"),
    entityTenderNumber: textById($, "lblEntityTenderNumber"),
    procurementMethod: textById($, "lbl_type"),
    requestTypes: textById($, "lblTenderClassification"),
    envelopesSystem: textById($, "lblTenderEnvSystem"),
    tenderBond: parseMoney(textById($, "lblTenderInsurance")),
    documentValue: parseMoney(textById($, "lbltenderDocumentValue")),
    currency: "QAR",
    publishedDate: parseDate(textById($, "lblTenderAnnouncementDate")),
    closingDate: parseDate(textById($, "lbltenderClosingDate")),
    technicalOpenDate: parseDate(textById($, "lblTechnicalOpenDate")),
    awardDate: parseDate(textById($, "lblAwardedDate")),
    awardedAmount: parseMoney(textById($, "lbl_award")),
    awardedAmountCurrency: "QAR",
    winningCompany: awardedCompanies[0]?.companyName ?? null,
    awardedCompanies,
    openedCompanies,
    sourceUrl: url,
  };
}

function getSectionTableRows($, headingText) {
  const heading = $("h3")
    .filter((_, element) => cellText($, element).toLowerCase().includes(headingText.toLowerCase()))
    .first();

  if (!heading.length) return [];

  const table = heading.nextAll(".custom--table--responsive").first().find("table").first();
  return extractTableRows($, table);
}

function extractTables($) {
  const rows = [];

  $("table").each((_, table) => {
    rows.push(...extractTableRows($, $(table)));
  });

  return rows;
}

function extractTableRows($, table) {
  const headers = table
    .find("thead th")
    .map((_, header) => cellText($, header))
    .get();

  if (!headers.length) return [];

  return table
    .find("tbody tr")
    .map((_, row) => {
      const cells = $(row)
        .find("td")
        .map((__, cell) => cellText($, cell))
        .get();

      if (!cells.length) return null;

      const record = {};
      headers.forEach((header, index) => {
        record[header] = cells[index] ?? "";
      });
      return record;
    })
    .get()
    .filter(Boolean);
}

async function pushRecord(record) {
  await Actor.pushData({
    ...record,
    fetchedAt: new Date().toISOString(),
  });
}

function cellText($, element) {
  return $(element).text().replace(/\s+/g, " ").trim();
}

function cleanText(value) {
  return value ? value.replace(/\s+/g, " ").trim() : null;
}

function parseMoney(value) {
  if (!value) return null;
  const normalized = value.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return normalized ? Number(normalized[0]) : null;
}

function parseInteger(value) {
  if (!value) return null;
  const normalized = value.match(/\d+/);
  return normalized ? Number(normalized[0]) : null;
}

function parseDate(value) {
  if (!value) return null;
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return value;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

function textById($, id) {
  return cleanText($(`#${id}`).text());
}

function splitRegistrationNumbers(value) {
  return cleanText(value)?.split("|").map((item) => item.trim()).filter(Boolean) ?? [];
}

function currencyFromText(value) {
  return value?.match(/\b[A-Z]{3}\b/)?.[0] ?? null;
}

function normalizeName(value) {
  return cleanText(value)?.toLowerCase() ?? "";
}

function sourceTypeFromUrl(url) {
  return url.includes("/AwardedTenders/") || url.includes("/TenderCompaniesDetails/") ? "AWARDED" : "AVAILABLE";
}

function labelFromUrl(url) {
  if (url.includes("/TenderCompaniesDetails/")) return "REPORT";
  if (url.includes("/TenderDetails/")) return "DETAIL";
  return "LIST";
}

function getTenderIdFromUrl(url) {
  return Number(url.match(/TendersOnlineServices\/(?:TenderDetails|TenderCompaniesDetails)\/(\d+)/)?.[1]) || null;
}

function rawKey(url) {
  return Buffer.from(url).toString("base64url");
}
