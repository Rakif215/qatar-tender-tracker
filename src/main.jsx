import React, { useEffect, useMemo, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity, BarChart3, Building2, CheckCircle2, ChevronDown,
  FileText, Globe, Info, Loader2, RefreshCw, Search,
  TrendingUp, User, Users, X, Award, DollarSign, Target,
  Zap, PieChart, Trophy, Calendar, Eye
} from "lucide-react";
import {
  PieChart as RePieChart, Pie, Cell,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  AreaChart, Area,
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
} from "recharts";
import "./styles.css";

const API = "";

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(v, c = "QAR") {
  if (v == null || v === 0) return "—";
  return new Intl.NumberFormat("en-QA", { style: "currency", currency: c, maximumFractionDigits: 0 }).format(Number(v));
}
function fmtK(v) {
  const n = Number(v); if (!n) return "—";
  if (n >= 1e9) return `${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n/1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n/1e3).toFixed(0)}K`;
  return n.toLocaleString();
}
function fmtDate(v) {
  if (!v) return "—";
  try { const d = new Date(v); return d.getFullYear() < 2000 ? "—" : new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "short", day: "2-digit" }).format(d); }
  catch { return v; }
}
function fetchJ(p) { return fetch(`${API}${p}`).then(r => r.json()); }

const CHART_COLORS = ["#3B82F6","#10B981","#8B5CF6","#F59E0B","#EC4899","#06B6D4","#EF4444","#14B8A6","#F97316","#6366F1","#84CC16","#A855F7"];

// ── Custom Tooltip ──────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="custom-tooltip">
      <div className="tooltip-label">{label}</div>
      {payload.map((p, i) => (
        <div className="tooltip-row" key={i}>
          <span style={{ color: p.color }}>{p.name}:</span>
          <span style={{ fontWeight: 600 }}>{typeof p.value === "number" ? p.value.toLocaleString() : p.value}</span>
        </div>
      ))}
    </div>
  );
}

// ── KPI Card ────────────────────────────────────────────────────────────────

function KpiCard({ icon: Icon, label, value, color, loading }) {
  return (
    <div className="kpi-card">
      <div className="kpi-icon" style={color ? { background: `${color}18`, color } : {}}>
        <Icon size={20} />
      </div>
      <div className="kpi-content">
        <span className="kpi-label">{label}</span>
        <span className="kpi-value">{loading ? <Loader2 size={16} className="spin" /> : value}</span>
      </div>
    </div>
  );
}

// ── Win Rate Bar ────────────────────────────────────────────────────────────

function WinRateBar({ rate }) {
  const color = rate >= 70 ? "#10B981" : rate >= 40 ? "#F59E0B" : "#EF4444";
  return (
    <div className="win-rate-bar">
      <div className="win-rate-bar-track">
        <div className="win-rate-bar-fill" style={{ width: `${Math.min(rate, 100)}%`, backgroundColor: color }} />
      </div>
      <span className="win-rate-bar-text" style={{ color }}>{rate.toFixed(1)}%</span>
    </div>
  );
}

// ── Empty / Loading ─────────────────────────────────────────────────────────

function LoadingState({ msg = "Loading..." }) {
  return <div className="empty-state"><Loader2 size={28} className="spin" /><p>{msg}</p></div>;
}
function EmptyState({ icon: Icon = FileText, msg = "No data" }) {
  return <div className="empty-state"><Icon size={28} /><p>{msg}</p></div>;
}

// ══════════════════════════════════════════════════════════════════════════════
// ── APP ─────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function App() {
  const [tab, setTab] = useState("company");
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);

  // ── Tab 4: Company Profiles ──
  const [companySearch, setCompanySearch] = useState("");
  const [companiesList, setCompaniesList] = useState([]);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [selectedCompanyId, setSelectedCompanyId] = useState(null);
  const [companyDetail, setCompanyDetail] = useState(null);
  const [companyBids, setCompanyBids] = useState([]);
  const [companyCategories, setCompanyCategories] = useState([]);
  const [companyDetailLoading, setCompanyDetailLoading] = useState(false);

  // ── Categories & Entities (for other tabs) ──
  const [categories, setCategories] = useState([]);
  const [entities, setEntities] = useState([]);

  // ── Initial Load ──
  useEffect(() => {
    Promise.all([
      fetchJ("/api/stats").catch(() => null),
      fetchJ("/api/entities").catch(() => ({ items: [] })),
      fetchJ("/api/categories").catch(() => ({ items: [] })),
    ]).then(([s, e, c]) => {
      setStats(s); setStatsLoading(false);
      setEntities(e.items ?? []);
      setCategories(c.items ?? []);
    });
  }, []);

  // ── Company Search ──
  useEffect(() => {
    setCompaniesLoading(true);
    const t = setTimeout(() => {
      fetchJ(`/api/companies?q=${encodeURIComponent(companySearch)}&limit=30`)
        .then(d => {
          setCompaniesList(d.items ?? []);
          if (d.items?.length && !selectedCompanyId) setSelectedCompanyId(d.items[0].companyId);
        })
        .catch(console.error)
        .finally(() => setCompaniesLoading(false));
    }, 300);
    return () => clearTimeout(t);
  }, [companySearch]);

  // ── Company Detail ──
  useEffect(() => {
    if (!selectedCompanyId) return;
    setCompanyDetailLoading(true);
    Promise.all([
      fetchJ(`/api/companies/${selectedCompanyId}`).catch(() => null),
      fetchJ(`/api/companies/${selectedCompanyId}/bids`).catch(() => ({ items: [] })),
      fetchJ(`/api/companies/${selectedCompanyId}/category-stats`).catch(() => ({ items: [] })),
    ]).then(([d, b, c]) => {
      setCompanyDetail(d);
      setCompanyBids(b.items ?? []);
      setCompanyCategories(c.items ?? []);
      setCompanyDetailLoading(false);
    });
  }, [selectedCompanyId]);

  const tabs = [
    { id: "market", label: "Market Explorer", icon: BarChart3 },
    { id: "entity", label: "Entity Insights", icon: Building2 },
    { id: "intelligence", label: "Competitor Analysis", icon: Target },
    { id: "company", label: "Company Profiles", icon: Users },
  ];

  return (
    <div className="app-layout">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">M</div>
          <div className="sidebar-logo-text">
            <span className="sidebar-logo-title">Monaqasat</span>
            <span className="sidebar-logo-subtitle">Tender Intelligence</span>
          </div>
        </div>
        <nav className="sidebar-nav">
          {tabs.map(t => (
            <button key={t.id} className={`sidebar-item${tab === t.id ? " active" : ""}`} onClick={() => setTab(t.id)}>
              <t.icon size={18} /><span>{t.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-sync"><RefreshCw size={11} /><span>Live Data</span></div>
          <div className="sidebar-stats">
            <span>{stats?.totalTenders ?? "—"} tenders</span>
            <span>{stats?.totalCompanies ?? "—"} companies</span>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="main-content">
        <div className="top-bar">
          <div className="kpi-grid">
            <KpiCard icon={FileText} label="Total Tenders" value={stats?.totalTenders?.toLocaleString()} color="#3B82F6" loading={statsLoading} />
            <KpiCard icon={DollarSign} label="Total Awarded" value={fmtK(stats?.totalAwardedValue)} color="#10B981" loading={statsLoading} />
            <KpiCard icon={Users} label="Active Bidders" value={stats?.totalCompanies?.toLocaleString()} color="#8B5CF6" loading={statsLoading} />
            <KpiCard icon={Building2} label="Entities" value={stats?.totalEntities?.toLocaleString()} color="#F59E0B" loading={statsLoading} />
            <KpiCard icon={Award} label="Awarded" value={stats?.awardedTenders?.toLocaleString()} color="#EC4899" loading={statsLoading} />
          </div>
        </div>

        <div className="dashboard-content">
          {tab === "company" && (
            <CompanyProfiles
              companySearch={companySearch} setCompanySearch={setCompanySearch}
              companiesList={companiesList} selectedCompanyId={selectedCompanyId}
              setSelectedCompanyId={setSelectedCompanyId}
              companyDetail={companyDetail} companyBids={companyBids}
              companyCategories={companyCategories}
              loading={companiesLoading || companyDetailLoading}
            />
          )}
          {tab === "market" && <PlaceholderTab name="Market Explorer" />}
          {tab === "entity" && <PlaceholderTab name="Entity Insights" />}
          {tab === "intelligence" && <CompetitorAnalysis />}
        </div>
      </main>
    </div>
  );
}

function PlaceholderTab({ name }) {
  return (
    <div className="card">
      <div className="card-body">
        <EmptyState icon={Zap} msg={`${name} — Coming next`} />
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ── DASHBOARD 3: COMPETITOR ANALYSIS (TF-IDF Tender Search) ─────────────────
// ══════════════════════════════════════════════════════════════════════════════

function CompetitorAnalysis() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleAnalyze = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/intelligence/analyze-tender`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: query.trim(), topN: 20 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [query]);

  const handleKeyDown = (e) => { if (e.key === "Enter") handleAnalyze(); };

  // Market share donut data
  const donutData = useMemo(() => {
    if (!result?.marketShare?.length) return [];
    return result.marketShare.map((m, i) => ({
      name: m.name.length > 20 ? m.name.slice(0, 20) + "…" : m.name,
      value: m.value,
      share: m.share,
      color: CHART_COLORS[i % CHART_COLORS.length],
    }));
  }, [result]);

  // Competitor comparison bar data
  const competitorBarData = useMemo(() => {
    if (!result?.likelyBidders?.length) return [];
    return result.likelyBidders.slice(0, 10).map(b => ({
      name: b.companyName.length > 18 ? b.companyName.slice(0, 18) + "…" : b.companyName,
      bids: b.bidCount,
      wins: b.wins,
      confidence: b.confidence,
    }));
  }, [result]);

  return (
    <div className="panel-stack">
      {/* ── Search Bar ── */}
      <div className="card">
        <div className="card-body" style={{ padding: "20px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <Target size={20} style={{ color: "#3B82F6" }} />
            <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Tender Competitive Intelligence</h3>
          </div>
          <p style={{ fontSize: 13, color: "#9CA3AF", marginBottom: 16 }}>
            Paste a tender title or description below. The engine will find similar historical tenders and predict who will compete.
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            <input
              className="filter-input"
              style={{ flex: 1, fontSize: 14, padding: "10px 14px" }}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. Supply of surgical gloves and medical disposables for Hamad Medical Corporation..."
            />
            <button
              onClick={handleAnalyze}
              disabled={loading || !query.trim()}
              style={{
                padding: "10px 24px",
                background: loading ? "#1E293B" : "#3B82F6",
                color: "white",
                border: "none",
                borderRadius: 8,
                fontWeight: 600,
                fontSize: 13,
                cursor: loading ? "wait" : "pointer",
                display: "flex", alignItems: "center", gap: 8,
                transition: "all 0.2s",
                opacity: !query.trim() ? 0.5 : 1,
              }}
            >
              {loading ? <Loader2 size={16} className="spin" /> : <Search size={16} />}
              {loading ? "Analyzing..." : "Analyze"}
            </button>
          </div>
          {error && <p style={{ color: "#EF4444", fontSize: 13, marginTop: 10 }}>⚠ {error}</p>}
        </div>
      </div>

      {/* ── Results ── */}
      {result && !loading && (
        <>
          {/* Match Summary */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 12, color: "#9CA3AF" }}>
            <span className="badge badge-primary">
              <Search size={11} /> {result.matchCount} similar tenders found
            </span>
            <span className="badge">
              Matched terms: {result.queryTerms?.slice(0, 8).join(", ")}
            </span>
          </div>

          {/* Row 1: Predicted Competitors + Market Share + Bid Estimator */}
          <div className="panel-grid cols-4-6">
            {/* Left: Predicted Competitors */}
            <div className="card" style={{ borderColor: "rgba(59,130,246,0.3)" }}>
              <div className="card-header">
                <div>
                  <h3 className="card-title"><Zap size={16} /> Predicted Competitors</h3>
                  <p className="card-subtitle">Who will likely bid, ranked by confidence</p>
                </div>
              </div>
              <div className="card-body no-pad">
                {result.likelyBidders.length === 0 ? <EmptyState msg="No competitors found" /> : (
                  <div className="data-table-wrapper" style={{ maxHeight: 440 }}>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th style={{ width: 30 }}>#</th>
                          <th>Company</th>
                          <th style={{ width: 55 }}>Bids</th>
                          <th style={{ width: 50 }}>Wins</th>
                          <th style={{ width: 100 }}>Confidence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.likelyBidders.map((b, i) => (
                          <tr key={i}>
                            <td><span className="rank-badge">{i + 1}</span></td>
                            <td>
                              <div style={{ fontWeight: 600 }}>{b.companyName}</div>
                              <div style={{ fontSize: 11, color: "#6B7280" }}>{b.reason}</div>
                            </td>
                            <td>{b.bidCount}</td>
                            <td>{b.wins}</td>
                            <td>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <div className="confidence-bar" style={{ width: 60 }}>
                                  <div className="confidence-fill" style={{
                                    width: `${b.confidence}%`,
                                    backgroundColor: b.confidence >= 70 ? "#10B981" : b.confidence >= 40 ? "#F59E0B" : "#6B7280"
                                  }} />
                                </div>
                                <span style={{ fontSize: 12, fontWeight: 700, color: b.confidence >= 70 ? "#10B981" : b.confidence >= 40 ? "#F59E0B" : "#9CA3AF" }}>
                                  {b.confidence}%
                                </span>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* Right Column: Market Share + Bid Estimator stacked */}
            <div className="panel-col">
              {/* Market Share Donut */}
              <div className="card">
                <div className="card-header">
                  <div>
                    <h3 className="card-title"><PieChart size={16} /> Market Share</h3>
                    <p className="card-subtitle">Who wins these types of tenders</p>
                  </div>
                </div>
                <div className="card-body">
                  {donutData.length === 0 ? <EmptyState msg="No winner data" /> : (
                    <div className="chart-container-sm">
                      <ResponsiveContainer width="100%" height="100%">
                        <RePieChart>
                          <Pie data={donutData} cx="50%" cy="50%" innerRadius={50} outerRadius={75} paddingAngle={2} dataKey="value" animationDuration={800}>
                            {donutData.map((d, i) => <Cell key={i} fill={d.color} stroke="transparent" />)}
                          </Pie>
                          <Tooltip content={({ active, payload }) => {
                            if (!active || !payload?.length) return null;
                            const d = payload[0].payload;
                            return (
                              <div className="custom-tooltip">
                                <div className="tooltip-label">{d.name}</div>
                                <div className="tooltip-row"><span>Share:</span><span style={{ fontWeight: 600 }}>{d.share}%</span></div>
                                <div className="tooltip-row"><span>Won:</span><span style={{ fontWeight: 600 }}>{fmtK(d.value)}</span></div>
                              </div>
                            );
                          }} />
                          <Legend formatter={v => <span style={{ color: "#9CA3AF", fontSize: 11 }}>{v}</span>} />
                        </RePieChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
              </div>

              {/* Bid Price Estimator */}
              <div className="card">
                <div className="card-header">
                  <div>
                    <h3 className="card-title"><DollarSign size={16} /> Bid Price Estimate</h3>
                    <p className="card-subtitle">Expected range based on {result.bidEstimate?.sampleSize || 0} historical bids</p>
                  </div>
                </div>
                <div className="card-body">
                  {!result.bidEstimate ? <EmptyState icon={DollarSign} msg="Insufficient data" /> : (
                    <div>
                      <div style={{ textAlign: "center", marginBottom: 16 }}>
                        <div style={{ fontSize: 11, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>Expected Winning Bid</div>
                        <div style={{ fontSize: 28, fontWeight: 800, color: "#10B981", marginTop: 4 }}>
                          {fmt(result.bidEstimate.winningMedian || result.bidEstimate.median)}
                        </div>
                      </div>
                      {/* Range Bar */}
                      <div style={{ position: "relative", margin: "12px 0" }}>
                        <div style={{ height: 8, background: "rgba(255,255,255,0.06)", borderRadius: 99 }}>
                          <div style={{ height: "100%", borderRadius: 99, background: "linear-gradient(90deg, #3B82F6, #10B981)", width: "70%", marginLeft: "15%" }} />
                        </div>
                        <div style={{ position: "absolute", top: -3, left: "50%", width: 14, height: 14, borderRadius: "50%", background: "#10B981", border: "2px solid #1A1A2E", transform: "translateX(-50%)" }} />
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#6B7280" }}>
                        <span>Min: {fmtK(result.bidEstimate.min)}</span>
                        <span>P50: {fmtK(result.bidEstimate.median)}</span>
                        <span>Max: {fmtK(result.bidEstimate.max)}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Row 2: Competitor Comparison Bar Chart */}
          <div className="card">
            <div className="card-header">
              <div>
                <h3 className="card-title"><BarChart3 size={16} /> Competitor Comparison</h3>
                <p className="card-subtitle">Bids vs Wins for predicted competitors</p>
              </div>
            </div>
            <div className="card-body">
              {competitorBarData.length === 0 ? <EmptyState msg="No data" /> : (
                <div className="chart-container">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={competitorBarData} margin={{ left: 10, right: 20, top: 10, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                      <XAxis dataKey="name" tick={{ fill: "#6B7280", fontSize: 10 }} axisLine={false} tickLine={false} angle={-25} textAnchor="end" height={60} />
                      <YAxis tick={{ fill: "#6B7280", fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
                      <Tooltip content={<ChartTooltip />} />
                      <Legend formatter={v => <span style={{ color: "#9CA3AF", fontSize: 12 }}>{v}</span>} />
                      <Bar dataKey="bids" name="Bids" fill="#3B82F6" radius={[4, 4, 0, 0]} barSize={18} />
                      <Bar dataKey="wins" name="Wins" fill="#10B981" radius={[4, 4, 0, 0]} barSize={18} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>

          {/* Row 3: Similar Tenders Table */}
          <div className="card">
            <div className="card-header">
              <div>
                <h3 className="card-title"><FileText size={16} /> Similar Historical Tenders</h3>
                <p className="card-subtitle">{result.similarTenders.length} most similar tenders found in database</p>
              </div>
            </div>
            <div className="card-body no-pad">
              {result.similarTenders.length === 0 ? <EmptyState msg="No similar tenders" /> : (
                <div className="data-table-wrapper" style={{ maxHeight: 400 }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th style={{ width: 60 }}>Match</th>
                        <th>Tender</th>
                        <th style={{ width: 140 }}>Entity</th>
                        <th style={{ width: 60 }}>Bids</th>
                        <th style={{ width: 130 }}>Winner</th>
                        <th style={{ width: 110 }}>Awarded</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.similarTenders.map((t, i) => (
                        <tr key={i}>
                          <td>
                            <span style={{
                              fontSize: 12, fontWeight: 700,
                              color: t.similarity >= 70 ? "#10B981" : t.similarity >= 40 ? "#F59E0B" : "#6B7280"
                            }}>{t.similarity}%</span>
                          </td>
                          <td>
                            <div className="tender-number">{t.tenderNumber || "—"}</div>
                            <div className="tender-title-text">{t.title}</div>
                          </td>
                          <td className="entity-text">{t.entity}</td>
                          <td><span className="badge">{t.bidderCount}</span></td>
                          <td>
                            {t.winnerName ? (
                              <span style={{ fontWeight: 600, fontSize: 12 }}>{t.winnerName}</span>
                            ) : <span style={{ color: "#6B7280" }}>—</span>}
                          </td>
                          <td className="price-text">{fmt(t.awardedValue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Initial state — show example queries */}
      {!result && !loading && (
        <div className="card">
          <div className="card-body" style={{ padding: "40px 24px" }}>
            <div style={{ textAlign: "center", maxWidth: 500, margin: "0 auto" }}>
              <Target size={40} style={{ color: "#3B82F6", opacity: 0.5, marginBottom: 16 }} />
              <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Paste a Tender to Start</h3>
              <p style={{ fontSize: 13, color: "#6B7280", lineHeight: 1.6, marginBottom: 20 }}>
                The TF-IDF engine will find the most similar historical tenders and show you who competed, at what price, and who's most likely to bid again.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, textAlign: "left" }}>
                <p style={{ fontSize: 11, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Try these examples:</p>
                {[
                  "Supply of medical equipment and surgical instruments",
                  "IT network infrastructure and server maintenance",
                  "Construction of roads and drainage systems",
                  "Pharmaceutical products and laboratory reagents",
                  "Security and surveillance systems installation",
                ].map((ex, i) => (
                  <button
                    key={i}
                    onClick={() => { setQuery(ex); }}
                    style={{
                      background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.15)",
                      borderRadius: 8, padding: "8px 14px", cursor: "pointer", textAlign: "left",
                      color: "#93C5FD", fontSize: 13, transition: "all 0.2s",
                    }}
                    onMouseOver={e => e.target.style.background = "rgba(59,130,246,0.15)"}
                    onMouseOut={e => e.target.style.background = "rgba(59,130,246,0.08)"}
                  >
                    → {ex}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ── DASHBOARD 4: COMPANY PROFILES (with Charts) ────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function CompanyProfiles({
  companySearch, setCompanySearch, companiesList,
  selectedCompanyId, setSelectedCompanyId,
  companyDetail, companyBids, companyCategories, loading
}) {
  const [timePeriod, setTimePeriod] = useState("all");

  // ── Computed stats ──
  const winRate = companyDetail?.stats ? (companyDetail.stats.totalBids > 0 ? (companyDetail.stats.wins / companyDetail.stats.totalBids * 100) : 0) : 0;

  // ── Filter bids by time period ──
  const filteredBids = useMemo(() => {
    if (!companyBids.length) return [];
    if (timePeriod === "all") return companyBids;
    const now = new Date();
    const cutoff = new Date();
    if (timePeriod === "3m") cutoff.setMonth(now.getMonth() - 3);
    else if (timePeriod === "6m") cutoff.setMonth(now.getMonth() - 6);
    else if (timePeriod === "1y") cutoff.setFullYear(now.getFullYear() - 1);
    else if (timePeriod === "2y") cutoff.setFullYear(now.getFullYear() - 2);
    return companyBids.filter(b => {
      const d = new Date(b.awardDate || b.closingDate);
      return d >= cutoff;
    });
  }, [companyBids, timePeriod]);

  // ── Donut Data: Win vs Loss ──
  const donutData = useMemo(() => {
    if (!companyDetail?.stats) return [];
    const w = companyDetail.stats.wins || 0;
    const l = (companyDetail.stats.totalBids || 0) - w;
    return [
      { name: "Won", value: w, color: "#10B981" },
      { name: "Lost", value: Math.max(l, 0), color: "#EF4444" },
    ];
  }, [companyDetail]);

  // ── Timeline Data: Monthly bid activity ──
  const timelineData = useMemo(() => {
    if (!filteredBids.length) return [];
    const months = {};
    filteredBids.forEach(b => {
      const d = new Date(b.awardDate || b.closingDate);
      if (isNaN(d.getTime())) return;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (!months[key]) months[key] = { month: key, won: 0, lost: 0, totalValue: 0 };
      if (b.isWinner) { months[key].won += 1; months[key].totalValue += (b.approvedValue || b.bidValue || 0); }
      else months[key].lost += 1;
    });
    return Object.values(months).sort((a, b) => a.month.localeCompare(b.month));
  }, [filteredBids]);

  // ── Sector Bar Chart Data ──
  const sectorBarData = useMemo(() => {
    return companyCategories.map(c => ({
      name: (c.categoryName || "Other").slice(0, 18),
      bids: c.totalBids || 0,
      wins: c.wins || 0,
      winRate: c.winRate || 0,
      color: c.categoryColor || CHART_COLORS[0],
    }));
  }, [companyCategories]);

  // ── Bid Value Scatter Data (as area chart) ──
  const bidValueData = useMemo(() => {
    return filteredBids
      .filter(b => b.bidValue || b.approvedValue)
      .map(b => ({
        date: fmtDate(b.awardDate || b.closingDate),
        value: (b.bidValue || b.approvedValue || 0) / 1e6,
        won: b.isWinner,
        name: b.tenderNumber || "—",
      }))
      .reverse()
      .slice(0, 30);
  }, [filteredBids]);

  // ── Entity breakdown ──
  const entityBreakdown = useMemo(() => {
    const map = {};
    companyBids.forEach(b => {
      const e = b.entity || "Unknown";
      if (!map[e]) map[e] = { name: e, count: 0, wins: 0 };
      map[e].count += 1;
      if (b.isWinner) map[e].wins += 1;
    });
    return Object.values(map).sort((a, b) => b.count - a.count);
  }, [companyBids]);

  return (
    <div className="panel-stack">
      {/* ── Search & Filters ── */}
      <div className="filter-bar">
        <div className="filter-group" style={{ flex: 1 }}>
          <Search size={16} />
          <input className="filter-input" value={companySearch} onChange={e => setCompanySearch(e.target.value)} placeholder="Search company name..." />
        </div>
        <div className="filter-group">
          <select className="filter-select" value={selectedCompanyId || ""} onChange={e => setSelectedCompanyId(Number(e.target.value))}>
            {companiesList.map(c => (
              <option key={c.companyId} value={c.companyId}>
                {c.companyName} ({c.wins ?? 0}W / {c.totalBids ?? 0}B)
              </option>
            ))}
          </select>
        </div>
        <div className="time-toggle">
          {[["3m","3M"],["6m","6M"],["1y","1Y"],["2y","2Y"],["all","All"]].map(([val, lbl]) => (
            <button key={val} className={`time-btn${timePeriod === val ? " active" : ""}`} onClick={() => setTimePeriod(val)}>{lbl}</button>
          ))}
        </div>
      </div>

      {/* ── Company Header Card ── */}
      <div className="card">
        {loading ? <LoadingState /> : companyDetail ? (
          <>
            <div className="company-header">
              <div>
                <h2 className="company-name">{companyDetail.company.name}</h2>
                {companyDetail.company.commercialRegistrationNumber && (
                  <p className="company-cr">CR: {companyDetail.company.commercialRegistrationNumber}</p>
                )}
              </div>
              <span className="badge badge-primary"><Eye size={12} /> Active Bidder</span>
            </div>
            <div className="company-stats-grid">
              <div className="company-stat">
                <div className="company-stat-value" style={{ color: "#3B82F6" }}>{companyDetail.stats.totalBids}</div>
                <div className="company-stat-label">Total Bids</div>
              </div>
              <div className="company-stat">
                <div className="company-stat-value" style={{ color: "#10B981" }}>{companyDetail.stats.wins}</div>
                <div className="company-stat-label">Wins</div>
              </div>
              <div className="company-stat">
                <div className="company-stat-value" style={{ color: winRate >= 50 ? "#10B981" : "#F59E0B" }}>{winRate.toFixed(1)}%</div>
                <div className="company-stat-label">Win Rate</div>
              </div>
              <div className="company-stat">
                <div className="company-stat-value" style={{ color: "#8B5CF6" }}>{fmtK(companyDetail.stats.totalWonAmount)}</div>
                <div className="company-stat-label">Total Won</div>
              </div>
            </div>
            <div className="win-rate-visual">
              <div className="win-rate-track">
                <div className="win-rate-fill" style={{ width: `${winRate}%` }} />
              </div>
            </div>
          </>
        ) : <EmptyState icon={User} msg="Select a company" />}
      </div>

      {/* ── Row 1: Donut + Sector Bars ── */}
      <div className="panel-grid cols-5-5">
        {/* Win/Loss Donut */}
        <div className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title"><PieChart size={16} /> Win / Loss Ratio</h3>
              <p className="card-subtitle">Overall bidding outcome</p>
            </div>
          </div>
          <div className="card-body">
            {loading ? <LoadingState /> : donutData.length ? (
              <div className="chart-container-sm" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                <ResponsiveContainer width="100%" height="100%">
                  <RePieChart>
                    <Pie data={donutData} cx="50%" cy="50%" innerRadius={60} outerRadius={85} paddingAngle={3} dataKey="value" animationDuration={800}>
                      {donutData.map((d, i) => <Cell key={i} fill={d.color} stroke="transparent" />)}
                    </Pie>
                    <Tooltip content={<ChartTooltip />} />
                    <Legend
                      verticalAlign="bottom"
                      formatter={(v, entry) => <span style={{ color: "#9CA3AF", fontSize: 12 }}>{v}: {entry.payload.value}</span>}
                    />
                  </RePieChart>
                </ResponsiveContainer>
                {/* Center text */}
                <div style={{ position: "absolute", textAlign: "center", pointerEvents: "none" }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: winRate >= 50 ? "#10B981" : "#F59E0B" }}>{winRate.toFixed(0)}%</div>
                  <div style={{ fontSize: 11, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>Win Rate</div>
                </div>
              </div>
            ) : <EmptyState msg="No bid data" />}
          </div>
        </div>

        {/* Sector Breakdown Bar Chart */}
        <div className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title"><BarChart3 size={16} /> Sector Breakdown</h3>
              <p className="card-subtitle">Bids and wins by sector</p>
            </div>
          </div>
          <div className="card-body">
            {loading ? <LoadingState /> : sectorBarData.length ? (
              <div className="chart-container-sm">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={sectorBarData} layout="vertical" margin={{ left: 10, right: 20, top: 5, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" horizontal={false} />
                    <XAxis type="number" tick={{ fill: "#6B7280", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="name" width={100} tick={{ fill: "#9CA3AF", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip content={<ChartTooltip />} />
                    <Bar dataKey="bids" name="Bids" fill="#3B82F6" radius={[0, 4, 4, 0]} barSize={14} />
                    <Bar dataKey="wins" name="Wins" fill="#10B981" radius={[0, 4, 4, 0]} barSize={14} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : <EmptyState msg="No sector data" />}
          </div>
        </div>
      </div>

      {/* ── Row 2: Bid Activity Timeline ── */}
      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title"><TrendingUp size={16} /> Bid Activity Timeline</h3>
            <p className="card-subtitle">Monthly bidding activity — won vs lost</p>
          </div>
          <div className="time-toggle">
            {[["3m","3M"],["6m","6M"],["1y","1Y"],["2y","2Y"],["all","All"]].map(([val, lbl]) => (
              <button key={val} className={`time-btn${timePeriod === val ? " active" : ""}`} onClick={() => setTimePeriod(val)}>{lbl}</button>
            ))}
          </div>
        </div>
        <div className="card-body">
          {loading ? <LoadingState /> : timelineData.length ? (
            <div className="chart-container">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={timelineData} margin={{ left: 0, right: 10, top: 10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                  <XAxis dataKey="month" tick={{ fill: "#6B7280", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "#6B7280", fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend formatter={v => <span style={{ color: "#9CA3AF", fontSize: 12 }}>{v}</span>} />
                  <Bar dataKey="won" name="Won" stackId="a" fill="#10B981" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="lost" name="Lost" stackId="a" fill="#EF4444" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <EmptyState msg="No timeline data for this period" />}
        </div>
      </div>

      {/* ── Row 3: Bid Values + Entities Served ── */}
      <div className="panel-grid cols-6-4">
        {/* Bid Values Over Time */}
        <div className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title"><DollarSign size={16} /> Bid Values (QAR Millions)</h3>
              <p className="card-subtitle">Each bid plotted by value — green = won</p>
            </div>
          </div>
          <div className="card-body">
            {loading ? <LoadingState /> : bidValueData.length ? (
              <div className="chart-container-sm">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={bidValueData} margin={{ left: 0, right: 10, top: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                    <XAxis dataKey="name" tick={{ fill: "#6B7280", fontSize: 9 }} axisLine={false} tickLine={false} interval={0} angle={-35} textAnchor="end" height={50} />
                    <YAxis tick={{ fill: "#6B7280", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip content={<ChartTooltip />} />
                    <Bar dataKey="value" name="Bid (M QAR)" radius={[4, 4, 0, 0]} barSize={16}>
                      {bidValueData.map((d, i) => (
                        <Cell key={i} fill={d.won ? "#10B981" : "#3B82F6"} fillOpacity={d.won ? 1 : 0.5} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : <EmptyState msg="No bid value data" />}
          </div>
        </div>

        {/* Entities Served */}
        <div className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title"><Building2 size={16} /> Entities Served</h3>
              <p className="card-subtitle">Government bodies this company works with</p>
            </div>
          </div>
          <div className="card-body no-pad">
            {loading ? <LoadingState /> : entityBreakdown.length ? (
              <div className="data-table-wrapper" style={{ maxHeight: 260 }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Entity</th>
                      <th style={{ width: 55 }}>Bids</th>
                      <th style={{ width: 55 }}>Wins</th>
                      <th style={{ width: 80 }}>Win Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entityBreakdown.map((e, i) => {
                      const wr = e.count > 0 ? (e.wins / e.count * 100) : 0;
                      return (
                        <tr key={i}>
                          <td><strong>{e.name}</strong></td>
                          <td>{e.count}</td>
                          <td>{e.wins}</td>
                          <td><WinRateBar rate={wr} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <EmptyState msg="No entity data" />}
          </div>
        </div>
      </div>

      {/* ── Row 4: Full Bidding History Table ── */}
      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title"><FileText size={16} /> Bidding History</h3>
            <p className="card-subtitle">{filteredBids.length} bids {timePeriod !== "all" ? `(filtered to ${timePeriod})` : "(all time)"}</p>
          </div>
        </div>
        <div className="card-body no-pad">
          {loading ? <LoadingState /> : filteredBids.length === 0 ? <EmptyState msg="No bid history" /> : (
            <div className="data-table-wrapper" style={{ maxHeight: 400 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Tender</th>
                    <th style={{ width: 140 }}>Entity</th>
                    <th style={{ width: 120 }}>Bid Amount</th>
                    <th style={{ width: 80 }}>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredBids.map((bid, i) => (
                    <tr key={bid.bidId || i} className={bid.isWinner ? "row-winner" : ""}>
                      <td>
                        <div className="tender-number">{bid.tenderNumber || "—"}</div>
                        <div className="tender-title-text">{bid.tenderTitle}</div>
                        <div className="date-text">{fmtDate(bid.awardDate)}</div>
                      </td>
                      <td className="entity-text">{bid.entity}</td>
                      <td className="price-text">{fmt(bid.bidValue ?? bid.approvedValue)}</td>
                      <td>
                        {bid.isWinner ? (
                          <span className="badge badge-success"><CheckCircle2 size={11} /> Won</span>
                        ) : (
                          <span className="badge badge-neutral">Lost</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Mount ────────────────────────────────────────────────────────────────────
createRoot(document.getElementById("root")).render(<App />);
