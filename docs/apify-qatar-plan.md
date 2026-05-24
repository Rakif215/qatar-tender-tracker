# Apify Plan for Qatar Monaqasat

## Current Constraint

Requests to `https://monaqasat.mof.gov.qa/` and `https://monaqasat.mof.gov.qa/TendersOnlineServices` timed out from the India-side environment on 2026-05-18. This looks like a network/geography access issue before we even reach normal bot detection.

An Apify default-cloud smoke run on 2026-05-18 also timed out on both listing URLs with 0/2 pages fetched. Plain Apify cloud egress is therefore not enough by itself.

Apify Proxy with the plain `QA` country code failed because no usable default proxies were available. Apify Proxy with group `RESIDENTIAL` and country code `QA` successfully fetched the first listing page on 2026-05-18, so the current working acquisition route is:

```json
{
  "useApifyProxy": true,
  "apifyProxyGroups": ["RESIDENTIAL"],
  "apifyProxyCountryCode": "QA",
  "maxConcurrency": 1
}
```

## Recommended Acquisition Setup

1. Run the collector from a location that can reach the site.
   - First try Apify with Qatar or nearby Middle East residential/datacenter proxy options.
   - If Apify cannot provide a working egress path, use a small Qatar-hosted VM/VPN endpoint and run the same actor code there.

2. Start with lightweight HTML fetching.
   - Monaqasat appears to be an ASP.NET server-rendered portal.
   - Use a Cheerio-based Apify Actor first because it is cheaper, easier to throttle, and less suspicious than opening a full browser for every page.

3. Use Playwright only as fallback.
   - If the listing or detail pages depend on JavaScript, add a second Actor or route handler using Playwright.
   - Keep concurrency low and preserve cookies/session state.

4. Store raw HTML.
   - Every fetched list/detail page should be stored in an Apify key-value store.
   - Parsed tender rows should go to an Apify dataset.
   - The raw archive lets us repair parsers without re-hitting the government portal.

5. Push clean data into PostgreSQL.
   - Apify is the acquisition/orchestration layer.
   - PostgreSQL remains the searchable product database.
   - A webhook or scheduled ingestion job should pull the dataset after a successful actor run.

## What I Need From You

- An Apify account/API token, if you want me to deploy and run this on Apify.
- Confirmation whether you have any Qatar-accessible network option: Qatar VM, VPN, office machine, or client-side machine.
- One successful raw HTML sample from:
  - `/TendersOnlineServices/AvailableMinistriesTenders/1`
  - `/TendersOnlineServices/AwardedTenders/1`
  - one `/TendersOnlineServices/TenderDetails/{id}` page
  - one `/TendersOnlineServices/TenderCompaniesDetails/{id}` page
- Confirmation of whether the client UI should be private/internal only or login-protected for multiple client users.

## Bot-Blocking Approach

- Use very low concurrency at first: 1-2 requests.
- Add delay and retry/backoff.
- Prefer stable direct HTML requests before browser automation.
- Do not bypass login, paid tender packs, CAPTCHA, or access controls.
- If blocked, switch to a legitimate Qatar-side network rather than trying aggressive evasion.

## First Milestone

- Get one successful Qatar-side fetch.
- Save the raw HTML.
- Build the parser against real markup.
- Load 20-50 sample records into the UI.
- Then decide whether Apify alone is enough or whether we need a Qatar-hosted collector.
