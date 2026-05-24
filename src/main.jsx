import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight,
  Download, ExternalLink, Loader2, RefreshCw, Search,
  SlidersHorizontal, X, Zap,
} from "lucide-react";
import "./styles.css";

// Works on local (Vite proxies /api → localhost:3001) and Vercel (serverless routing)
const API_BASE = "";
const PAGE_SIZE = 50;

const initialFilters = { q: "", entity: "", method: "", dateFrom: "", dateTo: "", amountMin: "", amountMax: "" };

function App() {
  const [filters, setFilters] = useState(initialFilters);
  const [appliedFilters, setAppliedFilters] = useState(initialFilters);
  const [methods, setMethods] = useState([]);
  const [entities, setEntities] = useState([]);
  const [tenders, setTenders] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [sortBy, setSortBy] = useState("award_date");
  const [sortDir, setSortDir] = useState("desc");
  const [expandedId, setExpandedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);
  const [error, setError] = useState("");
  const [stats, setStats] = useState(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [scraper, setScraper] = useState({ status: "idle", runId: null, message: "" });

  function refreshStats() {
    apiJson("/api/stats").then(setStats).catch(() => {});
  }

  function refreshTenders() {
    setAppliedFilters((f) => ({ ...f }));
    setPage(0);
  }

  // Load filter options + stats on mount
  useEffect(() => {
    Promise.all([
      apiJson("/api/procurement-methods").catch(() => ({ items: [] })),
      apiJson("/api/entities").catch(() => ({ items: [] })),
      apiJson("/api/stats").catch(() => null),
    ]).then(([methodData, entityData, statsData]) => {
      setMethods(methodData.items ?? []);
      setEntities(entityData.items ?? []);
      setStats(statsData);
      setStatsLoading(false);
    });
  }, []);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    Object.entries(appliedFilters).forEach(([k, v]) => { if (v) params.set(k, v); });
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(page * PAGE_SIZE));
    params.set("sortBy", sortBy);
    params.set("sortDir", sortDir);
    return params.toString();
  }, [appliedFilters, page, sortBy, sortDir]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    apiJson(`/api/tenders?${queryString}`, controller.signal)
      .then((data) => { setTenders(data.items ?? []); setTotal(data.total ?? 0); setExpandedId(null); })
      .catch((err) => { if (err.name !== "AbortError") setError(err.message || "Could not load tenders"); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [queryString]);

  function updateFilter(key, value) { setFilters((f) => ({ ...f, [key]: value })); }
  function applyFilters(e) { e?.preventDefault(); setPage(0); setAppliedFilters(filters); }
  function resetFilters() { setFilters(initialFilters); setAppliedFilters(initialFilters); setPage(0); }
  function handleSort(col) {
    if (sortBy === col) setSortDir((d) => d === "desc" ? "asc" : "desc");
    else { setSortBy(col); setSortDir("desc"); }
    setPage(0);
  }

  function exportCsv() {
    const headers = ["Tender No.", "Title", "Entity", "Method", "Award Date", "Awarded Amount (QAR)", "Winning Company"];
    const rows = tenders.map((t) => [
      t.tenderNumber ?? "",
      `"${(t.title ?? "").replace(/"/g, '""')}"`,
      `"${(t.entity ?? "").replace(/"/g, '""')}"`,
      t.procurementMethod ?? "",
      t.awardDate ? t.awardDate.slice(0, 10) : "",
      t.awardedAmount ?? "",
      `"${(t.winningCompany ?? "").replace(/"/g, '""')}"`,
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `qatar-tenders-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  async function triggerScraper() {
    setScraper({ status: "triggering", runId: null, message: "Starting scraper on Qatar government portal…" });
    try {
      const res = await apiJson("/api/scraper/trigger", null, "POST");
      const runId = res.runId;
      setScraper({ status: "running", runId, message: "Scraper running — collecting tenders from monaqasat.mof.gov.qa…" });

      // Poll every 6 seconds
      const poll = setInterval(async () => {
        try {
          const s = await apiJson(`/api/scraper/status/${runId}`);
          const done = ["SUCCEEDED", "FAILED", "ABORTED"].includes(s.status);
          setScraper((prev) => ({
            ...prev,
            message: done
              ? s.status === "SUCCEEDED"
                ? `Scraped ${s.itemCount} tenders — importing to database…`
                : `Scraper ended: ${s.status}`
              : `Running… ${s.itemCount ?? 0} tenders collected so far`,
          }));
          if (done) {
            clearInterval(poll);
            if (s.status === "SUCCEEDED" && s.datasetId) {
              await apiJson("/api/ingest/apify-dataset", null, "POST", { datasetId: s.datasetId });
              setScraper({ status: "done", runId, message: `✅ ${s.itemCount} tenders imported — dashboard updated!` });
              setTimeout(() => { refreshStats(); refreshTenders(); }, 1200);
              setTimeout(() => setScraper({ status: "idle", runId: null, message: "" }), 7000);
            } else {
              setTimeout(() => setScraper({ status: "idle", runId: null, message: "" }), 4000);
            }
          }
        } catch (_) {}
      }, 6000);
    } catch (e) {
      setScraper({ status: "error", runId: null, message: "Failed to start scraper. Check API token." });
      setTimeout(() => setScraper({ status: "idle", runId: null, message: "" }), 4000);
    }
  }

  const activeFilterCount = Object.values(appliedFilters).filter(Boolean).length;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const scraperBusy = scraper.status === "triggering" || scraper.status === "running";

  return (
    <div className="app">

      {/* ── Nav ── */}
      <nav className="nav">
        <div className="navInner">
          <div className="navBrand">
            <div className="navLogo"><span>M</span></div>
            <div>
              <div className="navTitle">Monaqasat Tracker</div>
              <div className="navSub">Qatar Public Procurement Intelligence</div>
            </div>
          </div>
          <div className="navRight">
            {stats?.lastRun && (
              <div className="freshnessBadge">
                <RefreshCw size={12} />
                <span>Updated {formatRelativeTime(stats.lastRun.finishedAt ?? stats.lastRun.startedAt)}</span>
              </div>
            )}
            <button
              className={`scraperBtn ${scraperBusy ? "scraperBusy" : ""}`}
              onClick={triggerScraper}
              disabled={scraperBusy}
              title="Pull fresh data from monaqasat.mof.gov.qa"
            >
              {scraperBusy ? <Loader2 size={15} className="spinning" /> : <Zap size={15} />}
              {scraperBusy ? "Scraping…" : "Fetch Live Data"}
            </button>
          </div>
        </div>
      </nav>

      {/* ── Scraper status banner ── */}
      {scraper.message && (
        <div className={`scraperBanner ${scraper.status}`}>
          {scraperBusy && <Loader2 size={14} className="spinning" />}
          {scraper.status === "done" && <span className="bannerCheck">✅</span>}
          <span>{scraper.message}</span>
        </div>
      )}

      {/* ── Hero ── */}
      <div className="hero">
        <div className="heroInner">
          <div className="heroText">
            <p className="heroEyebrow">Live Data from monaqasat.mof.gov.qa</p>
            <h1 className="heroTitle">Qatar Tender Awards</h1>
            <p className="heroDesc">Search and explore public procurement awards published by the Qatar Ministry of Finance.</p>
          </div>
          <div className="statsGrid">
            <StatCard label="Total Tenders"  value={stats?.totalTenders}      loading={statsLoading} />
            <StatCard label="Awarded"         value={stats?.awardedTenders}    loading={statsLoading} />
            <StatCard label="Companies"       value={stats?.totalCompanies}    loading={statsLoading} />
            <StatCard label="Total Awarded"   value={stats?.totalAwardedValue} loading={statsLoading} isCurrency />
          </div>
        </div>
      </div>

      {/* ── Search + Filters ── */}
      <div className="searchSection">
        <div className="searchSectionInner">
          <form className="searchRow" onSubmit={applyFilters}>
            <div className="searchInputWrap">
              <Search size={18} className="searchIcon" />
              <input
                id="tender-search"
                className="searchInput"
                value={filters.q}
                onChange={(e) => updateFilter("q", e.target.value)}
                placeholder="Search tender number, title, entity, company…"
              />
              {filters.q && (
                <button type="button" className="searchClear" onClick={() => updateFilter("q", "")}>
                  <X size={16} />
                </button>
              )}
            </div>
            <button
              type="button"
              className={`filterToggle ${filtersOpen ? "active" : ""} ${activeFilterCount > 0 ? "hasFilters" : ""}`}
              onClick={() => setFiltersOpen((o) => !o)}
            >
              <SlidersHorizontal size={17} />
              Filters
              {activeFilterCount > 0 && <span className="filterCount">{activeFilterCount}</span>}
            </button>
            <button className="searchBtn" type="submit">Search</button>
          </form>

          {filtersOpen && (
            <div className="filtersPanel">
              <div className="filtersGrid">
                <Field label="Government Entity">
                  <select value={filters.entity} onChange={(e) => updateFilter("entity", e.target.value)}>
                    <option value="">All entities</option>
                    {entities.map((en) => <option key={en} value={en}>{en}</option>)}
                  </select>
                </Field>
                <Field label="Procurement Method">
                  <select value={filters.method} onChange={(e) => updateFilter("method", e.target.value)}>
                    <option value="">All methods</option>
                    {methods.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </Field>
                <Field label="Award Date From">
                  <input type="date" value={filters.dateFrom} onChange={(e) => updateFilter("dateFrom", e.target.value)} />
                </Field>
                <Field label="Award Date To">
                  <input type="date" value={filters.dateTo} onChange={(e) => updateFilter("dateTo", e.target.value)} />
                </Field>
                <Field label="Min Amount (QAR)">
                  <input value={filters.amountMin} onChange={(e) => updateFilter("amountMin", onlyNumeric(e.target.value))} placeholder="e.g. 500000" />
                </Field>
                <Field label="Max Amount (QAR)">
                  <input value={filters.amountMax} onChange={(e) => updateFilter("amountMax", onlyNumeric(e.target.value))} placeholder="e.g. 5000000" />
                </Field>
              </div>
              <div className="filterActions">
                <button className="btnPrimary" onClick={applyFilters}>Apply Filters</button>
                <button className="btnGhost" onClick={resetFilters}>Clear All</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Results ── */}
      <div className="resultsSection">
        <div className="resultsSectionInner">
          {error && <div className="errorBanner">{error}</div>}

          <div className="resultsHeader">
            <div className="resultsMeta">
              {loading
                ? <span className="resultsCount">Loading…</span>
                : <span className="resultsCount"><strong>{total.toLocaleString()}</strong> results{activeFilterCount > 0 ? " (filtered)" : ""}</span>
              }
              <span className="resultsHint">Click any row to see competing bids</span>
            </div>
            <button className="btnGhost btnSm" onClick={exportCsv} disabled={loading || !tenders.length}>
              <Download size={15} /> Export CSV
            </button>
          </div>

          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 40 }}></th>
                  <SortTh column="tender_number" current={sortBy} dir={sortDir} onSort={handleSort}>Tender No.</SortTh>
                  <th>Title</th>
                  <SortTh column="entity" current={sortBy} dir={sortDir} onSort={handleSort}>Entity</SortTh>
                  <th>Method</th>
                  <th>Winner</th>
                  <SortTh column="awarded_value" current={sortBy} dir={sortDir} onSort={handleSort}>Amount</SortTh>
                  <SortTh column="award_date" current={sortBy} dir={sortDir} onSort={handleSort}>Award Date</SortTh>
                  <th style={{ width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} className="skeletonRow">
                      {Array.from({ length: 9 }).map((__, j) => <td key={j}><span className="skeleton" /></td>)}
                    </tr>
                  ))
                ) : tenders.length === 0 ? (
                  <tr>
                    <td colSpan="9" className="emptyCell">
                      <div className="emptyState">
                        <Search size={40} />
                        <p>No tenders match your filters.</p>
                        <button className="btnGhost" onClick={resetFilters}>Clear filters</button>
                      </div>
                    </td>
                  </tr>
                ) : tenders.map((tender) => (
                  <React.Fragment key={tender.id}>
                    <tr
                      className={`tenderRow ${expandedId === tender.id ? "expanded" : ""}`}
                      onClick={() => setExpandedId(expandedId === tender.id ? null : tender.id)}
                    >
                      <td className="expandCell">
                        {expandedId === tender.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </td>
                      <td className="tenderNo">{tender.tenderNumber || "—"}</td>
                      <td className="tenderTitle">{tender.title || "Untitled"}</td>
                      <td className="tenderEntity">{tender.entity || "—"}</td>
                      <td><span className="methodChip">{tender.procurementMethod || "—"}</span></td>
                      <td><span className="winnerChip">{tender.winningCompany || "—"}</span></td>
                      <td className="money">{formatMoney(tender.awardedAmount, tender.awardedAmountCurrency)}</td>
                      <td className="dateCell">{formatDate(tender.awardDate)}</td>
                      <td className="linkCell">
                        {tender.tenderDetailUrl && (
                          <a href={tender.tenderDetailUrl} target="_blank" rel="noopener noreferrer"
                            className="sourceLink" onClick={(e) => e.stopPropagation()} title="Open on Monaqasat">
                            <ExternalLink size={14} />
                          </a>
                        )}
                      </td>
                    </tr>
                    {expandedId === tender.id && <BidsRow tender={tender} />}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="pagination">
              <button className="btnGhost btnSm" disabled={page === 0} onClick={() => setPage(0)}>First</button>
              <button className="btnGhost btnSm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Prev</button>
              <span className="pageInfo">Page {page + 1} of {totalPages}</span>
              <button className="btnGhost btnSm" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>Next →</button>
              <button className="btnGhost btnSm" disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>Last</button>
            </div>
          )}
        </div>
      </div>

      <footer className="footer">
        <div className="footerInner">
          <p>Data sourced from <a href="https://monaqasat.mof.gov.qa" target="_blank" rel="noopener noreferrer">monaqasat.mof.gov.qa</a> — Qatar Ministry of Finance</p>
          <p className="footerSub">For research and transparency purposes only.</p>
        </div>
      </footer>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function BidsRow({ tender }) {
  const companies = mergeCompanies(tender.companies ?? []);
  return (
    <tr className="bidsRow">
      <td></td>
      <td colSpan="8">
        <div className="bidsBox">
          <div className="bidsHeader">
            <strong>Competing Bids</strong>
            <span>{companies.length} participant{companies.length !== 1 ? "s" : ""}</span>
          </div>
          {companies.length > 0 ? (
            <table className="bidsTable">
              <thead>
                <tr><th>Company</th><th>Bid / Approved</th><th>Result</th><th>Reg. Number</th></tr>
              </thead>
              <tbody>
                {companies.map((c) => (
                  <tr key={`${c.companyName}-${c.source}`} className={c.isWinner ? "winnerRow" : ""}>
                    <td>{c.isWinner && <span className="winnerTag">Winner</span>}{c.companyName}</td>
                    <td className="money">{formatMoney(c.proposalAmount ?? c.approvedValue, tender.awardedAmountCurrency)}</td>
                    <td>{c.isWinner ? "Awarded" : c.notes || "Participant"}</td>
                    <td className="regNum">{c.commercialRegistrationNumber || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="noBids">No bid details published for this tender.</p>
          )}
        </div>
      </td>
    </tr>
  );
}

function StatCard({ label, value, loading, isCurrency }) {
  const display = isCurrency
    ? value != null ? `QAR ${formatCompact(value)}` : "—"
    : value != null ? Number(value).toLocaleString() : "—";
  return (
    <div className="statCard">
      <div className="statValue">{loading ? <span className="skeleton statSkeleton" /> : display}</div>
      <div className="statLabel">{label}</div>
    </div>
  );
}

function SortTh({ column, current, dir, onSort, children }) {
  const active = current === column;
  return (
    <th className={`sortable ${active ? "sortActive" : ""}`} onClick={() => onSort(column)}>
      <span>{children}</span>
      {active ? (dir === "desc" ? <ArrowDown size={14} /> : <ArrowUp size={14} />) : <ArrowUpDown size={13} className="sortIcon" />}
    </th>
  );
}

function Field({ label, children }) {
  return (
    <label className="field">
      <span className="fieldLabel">{label}</span>
      {children}
    </label>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function apiJson(path, signal, method = "GET", body) {
  return fetch(`${API_BASE}${path}`, {
    method,
    signal,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  });
}

function mergeCompanies(companies) {
  const map = new Map();
  for (const c of companies) {
    const key = c.companyName?.trim().toLowerCase();
    if (!key) continue;
    const ex = map.get(key);
    map.set(key, ex ? { ...ex, ...c, approvedValue: ex.approvedValue ?? c.approvedValue, proposalAmount: c.proposalAmount ?? ex.proposalAmount, isWinner: ex.isWinner || c.isWinner } : c);
  }
  return [...map.values()].sort((a, b) => {
    if (a.isWinner !== b.isWinner) return a.isWinner ? -1 : 1;
    return (a.proposalAmount ?? a.approvedValue ?? Infinity) - (b.proposalAmount ?? b.approvedValue ?? Infinity);
  });
}

function formatMoney(value, currency = "QAR") {
  if (value == null || value === "") return "—";
  return new Intl.NumberFormat("en-QA", { style: "currency", currency: currency || "QAR", maximumFractionDigits: 0 }).format(Number(value));
}

function formatCompact(value) {
  const n = Number(value);
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toLocaleString();
}

function formatDate(value) {
  if (!value) return "—";
  try { return new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "short", day: "2-digit" }).format(new Date(value)); }
  catch { return value; }
}

function formatRelativeTime(value) {
  if (!value) return "unknown";
  const diff = Date.now() - new Date(value).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function onlyNumeric(value) { return value.replace(/[^\d.]/g, ""); }

createRoot(document.getElementById("root")).render(<App />);
