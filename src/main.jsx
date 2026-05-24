import React, { useEffect, useMemo, useRef, useState } from "react";
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
  const [scraper, setScraper] = useState({ status: "idle", runId: null, message: "", itemCount: 0, startedAt: null });

  const pollRef = useRef(null);

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

  // Cleanup polling on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

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
    const startedAt = Date.now();
    setScraper({ status: "triggering", runId: null, message: "Initializing scraper on Qatar government portal…", itemCount: 0, startedAt });
    try {
      const res = await apiJson("/api/scraper/trigger", null, "POST");
      const runId = res.runId;
      setScraper({ status: "running", runId, message: "Scraper launched — discovering tender pages on monaqasat.mof.gov.qa…", itemCount: 0, startedAt });

      // Clear any existing poll
      if (pollRef.current) clearInterval(pollRef.current);

      let consecutiveZeroPolls = 0;
      let lastItemCount = 0;

      // Poll every 5 seconds
      pollRef.current = setInterval(async () => {
        try {
          const s = await apiJson(`/api/scraper/status/${runId}`);
          const done = ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(s.status);
          const itemCount = s.itemCount || 0;
          const elapsed = Math.floor((Date.now() - startedAt) / 1000);

          if (itemCount === 0) {
            consecutiveZeroPolls++;
          } else {
            consecutiveZeroPolls = 0;
          }

          if (itemCount > lastItemCount) {
            lastItemCount = itemCount;
          }

          // Construct a more informative message based on phase
          let message;
          if (done) {
            if (s.status === "SUCCEEDED") {
              message = `Scraper finished — collected ${itemCount || lastItemCount} tenders. Importing to database…`;
            } else {
              message = `Scraper ended with status: ${s.status}`;
            }
          } else if (itemCount > 0) {
            message = `Collecting tenders… ${itemCount} found so far`;
          } else if (elapsed < 20) {
            message = "Starting up scraper and loading the portal…";
          } else if (elapsed < 60) {
            message = "Navigating government portal and discovering tender pages…";
          } else if (elapsed < 120) {
            message = "Crawling tender listings — this portal can be slow to respond…";
          } else {
            message = "Still working — the portal sometimes takes a while to load all pages…";
          }

          setScraper((prev) => ({
            ...prev,
            itemCount: itemCount || prev.itemCount,
            message,
          }));

          if (done) {
            clearInterval(pollRef.current);
            pollRef.current = null;

            if (s.status === "SUCCEEDED" && s.datasetId) {
              try {
                await apiJson("/api/ingest/apify-dataset", null, "POST", { datasetId: s.datasetId });
                // Wait a bit for ingestion to start processing
                await sleep(3000);
                setScraper({
                  status: "done",
                  runId,
                  message: `✅ ${itemCount || lastItemCount} tenders imported successfully — dashboard updated!`,
                  itemCount: itemCount || lastItemCount,
                  startedAt,
                });
                // Refresh data
                refreshStats();
                refreshTenders();
                // Auto-hide after 8 seconds
                setTimeout(() => setScraper({ status: "idle", runId: null, message: "", itemCount: 0, startedAt: null }), 8000);
              } catch (ingestErr) {
                setScraper({
                  status: "error",
                  runId,
                  message: `Scraper succeeded but ingestion failed: ${ingestErr.message}`,
                  itemCount: 0,
                  startedAt: null,
                });
                setTimeout(() => setScraper({ status: "idle", runId: null, message: "", itemCount: 0, startedAt: null }), 6000);
              }
            } else {
              setScraper((prev) => ({
                ...prev,
                status: s.status === "SUCCEEDED" ? "done" : "error",
              }));
              setTimeout(() => setScraper({ status: "idle", runId: null, message: "", itemCount: 0, startedAt: null }), 5000);
            }
          }
        } catch (_) {
          // Network blip — just skip this poll cycle
        }
      }, 5000);
    } catch (e) {
      setScraper({ status: "error", runId: null, message: "Failed to start scraper. Check Apify API token.", itemCount: 0, startedAt: null });
      setTimeout(() => setScraper({ status: "idle", runId: null, message: "", itemCount: 0, startedAt: null }), 5000);
    }
  }

  const activeFilterCount = Object.values(appliedFilters).filter(Boolean).length;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const scraperBusy = scraper.status === "triggering" || scraper.status === "running";

  return (
    <div className="app">

      {/* ── Navigation ── */}
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

      {/* ── Scraper Status Banner ── */}
      {scraper.message && (
        <div className={`scraperBanner ${scraper.status}`}>
          {scraperBusy && <Loader2 size={14} className="spinning" />}
          {scraper.status === "done" && <span className="bannerCheck">✅</span>}
          {scraper.status === "error" && <span className="bannerCheck">⚠️</span>}
          <div className="scraperBannerContent">
            <div className="scraperBannerMessage">
              <span>{scraper.message}</span>
            </div>
            {scraperBusy && scraper.startedAt && (
              <div className="scraperProgressWrap">
                <div className="scraperProgress">
                  <div
                    className="scraperProgressBar"
                    style={{ width: scraper.itemCount > 0 ? "60%" : `${Math.min(((Date.now() - scraper.startedAt) / 180000) * 40, 40)}%` }}
                  />
                </div>
                <ElapsedTimer startedAt={scraper.startedAt} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Hero Section ── */}
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
                  <th className="col-expand" style={{ width: 40 }}></th>
                  <SortTh column="tender_number" current={sortBy} dir={sortDir} onSort={handleSort} className="col-number">Tender No.</SortTh>
                  <th className="col-title">Title</th>
                  <SortTh column="entity" current={sortBy} dir={sortDir} onSort={handleSort} className="col-entity">Entity</SortTh>
                  <th className="col-method">Method</th>
                  <th className="col-winner">Winner</th>
                  <SortTh column="awarded_value" current={sortBy} dir={sortDir} onSort={handleSort} className="col-amount">Amount</SortTh>
                  <SortTh column="award_date" current={sortBy} dir={sortDir} onSort={handleSort} className="col-date">Award Date</SortTh>
                  <th className="col-link" style={{ width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} className="skeletonRow">
                      <td className="col-expand"><span className="skeleton" /></td>
                      <td className="col-number"><span className="skeleton" /></td>
                      <td className="col-title"><span className="skeleton" /></td>
                      <td className="col-entity"><span className="skeleton" /></td>
                      <td className="col-method"><span className="skeleton" /></td>
                      <td className="col-winner"><span className="skeleton" /></td>
                      <td className="col-amount"><span className="skeleton" /></td>
                      <td className="col-date"><span className="skeleton" /></td>
                      <td className="col-link"><span className="skeleton" /></td>
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
                      <td className="expandCell col-expand">
                        {expandedId === tender.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </td>
                      <td className="tenderNo col-number" title={tender.tenderNumber || ""}>{tender.tenderNumber || "—"}</td>
                      <td className="tenderTitle col-title" title={tender.title || ""}>{tender.title || "Untitled"}</td>
                      <td className="tenderEntity col-entity" title={tender.entity || ""}>{tender.entity || "—"}</td>
                      <td className="col-method"><span className="methodChip" title={tender.procurementMethod || ""}>{tender.procurementMethod || "—"}</span></td>
                      <td className="col-winner"><span className="winnerChip" title={tender.winningCompany || ""}>{tender.winningCompany || "—"}</span></td>
                      <td className="money col-amount">{formatMoney(tender.awardedAmount, tender.awardedAmountCurrency)}</td>
                      <td className="dateCell col-date">{formatDate(tender.awardDate)}</td>
                      <td className="linkCell col-link">
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

function ElapsedTimer({ startedAt }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return <span className="scraperElapsed">{mins}:{secs.toString().padStart(2, "0")} elapsed</span>;
}

function BidsRow({ tender }) {
  const companies = mergeCompanies(tender.companies ?? []);
  return (
    <tr className="bidsRow">
      <td></td>
      <td colSpan="100%">
        <div className="bidsBox">
          <div className="tenderDetailGrid">
            <div className="tenderDetailInfo">
              <h4 className="detailHeading">Tender Details</h4>
              <div className="detailField">
                <span className="detailLabel">Tender Number</span>
                <span className="detailValue">{tender.tenderNumber || "—"}</span>
              </div>
              <div className="detailField">
                <span className="detailLabel">Title</span>
                <span className="detailValue titleText">{tender.title || "Untitled"}</span>
              </div>
              <div className="detailField">
                <span className="detailLabel">Issuing Entity</span>
                <span className="detailValue">{tender.entity || "—"}</span>
              </div>
              <div className="detailField">
                <span className="detailLabel">Method</span>
                <span className="detailValue"><span className="methodChip">{tender.procurementMethod || "—"}</span></span>
              </div>
              <div className="detailField">
                <span className="detailLabel">Award Date</span>
                <span className="detailValue">{formatDate(tender.awardDate)}</span>
              </div>
              <div className="detailField">
                <span className="detailLabel">Awarded Value</span>
                <span className="detailValue money">{formatMoney(tender.awardedAmount, tender.awardedAmountCurrency)}</span>
              </div>
              {tender.tenderDetailUrl && (
                <div style={{ marginTop: "12px" }}>
                  <a href={tender.tenderDetailUrl} target="_blank" rel="noopener noreferrer" className="btnGhost btnSm" style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
                    <ExternalLink size={13} /> View Original Source
                  </a>
                </div>
              )}
            </div>

            <div className="tenderDetailBids">
              <div className="bidsHeader">
                <strong>Competing Bids</strong>
                <span>{companies.length} participant{companies.length !== 1 ? "s" : ""}</span>
              </div>
              {companies.length > 0 ? (
                <div style={{ overflowX: "auto" }}>
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
                </div>
              ) : (
                <p className="noBids">No bid details published for this tender.</p>
              )}
            </div>
          </div>
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

function SortTh({ column, current, dir, onSort, className = "", children }) {
  const active = current === column;
  return (
    <th className={`sortable ${active ? "sortActive" : ""} ${className}`} onClick={() => onSort(column)}>
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

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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
