import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { Search, ExternalLink, ArrowRight } from "lucide-react";
import {
  filterByPeriod, kpis, monthly, leaderboard, buyers, competition, companyProfile,
  retenders, pricePosition, winsByMonth, byCategory,
} from "./analytics.js";
import { buildIndex, search, summarize } from "./tfidf.js";
import { CategoryTreemap, FlowChart, PriceStrip, ShareBars } from "./visuals.jsx";
import "./styles.css";

// ── formatting ───────────────────────────────────────────────────────────────
const qar = (v) => {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1e9) return `QAR ${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `QAR ${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `QAR ${(v / 1e3).toFixed(0)}K`;
  return `QAR ${Math.round(v)}`;
};
const pct = (v) => (v == null || !Number.isFinite(v) ? "—" : `${Math.round(v * 100)}%`);
const date = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const monthLabel = (m) => new Date(`${m}-01`).toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
const REPORT = (id) => `https://monaqasat.mof.gov.qa/TendersOnlineServices/TenderCompaniesDetails/${id}`;
const tipStyle = { background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, color: "var(--ink)" };
// Names arrive in ALL CAPS or mixed; show all-caps names in title case.
const nice = (s) => (!s || /[a-z]/.test(s) ? s : s.toLowerCase().replace(/(^|[\s(\-/&])([a-zÀ-ɏ])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(Llc|Wll|W\.l\.l|Qfc|Qpsc|Q\.p\.s\.c|Spc|Hmc|Phcc|Led|Cctv|Hvac|It)\b/g, (m) => m.toUpperCase()));

const PERIODS = [{ id: 5, label: "Last 5 months" }, { id: 12, label: "Last 12 months" }, { id: 0, label: "All data" }];
const INTEL = [
  { id: "market", label: "Market" },
  { id: "competitors", label: "Competitors" },
  { id: "ministries", label: "Ministries" },
  { id: "retenders", label: "Re-tender radar" },
];
const ROUTES = ["raw", ...INTEL.map((t) => t.id), "ask", "method"];

function useRoute() {
  const read = () => (ROUTES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "market");
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return [route, (id) => { if (location.hash !== `#${id}`) location.hash = id; setRoute(id); scrollTo(0, 0); }];
}

// ── app ──────────────────────────────────────────────────────────────────────
function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [period, setPeriod] = useState(5);
  const [cat, setCat] = useState("");
  const [route, go] = useRoute();
  const [company, setCompany] = useState(null);
  const [buyer, setBuyer] = useState(null);
  const [askSeed, setAskSeed] = useState("");

  useEffect(() => {
    fetch("/tender-data/tenders.json").then((r) => r.json()).then(setData).catch((e) => setError(String(e)));
  }, []);

  const name = (c) => nice(data?.companies[c]?.name) ?? "Unknown";
  const all = useMemo(() => (data ? filterByPeriod(data.tenders, period, data.period.to) : []), [data, period]);
  const T = useMemo(() => (cat ? all.filter((t) => t.cat === cat) : all), [all, cat]);
  const index = useMemo(() => (data ? buildIndex(data.tenders) : null), [data]);

  if (error) return <div className="state">Could not load data: {error}</div>;
  if (!data) return <div className="state">Loading tender data…</div>;

  const openCompany = (c) => { setCompany(c); go("competitors"); };
  const openBuyer = (e) => { setBuyer(e); go("ministries"); };
  const ask = (q) => { setAskSeed(q); go("ask"); };
  const ctx = { data, all, T, name, openCompany, openBuyer, ask, period, cat, setCat, index };
  const intel = INTEL.some((t) => t.id === route);

  return (
    <div className="app">
      <header className="top">
        <button type="button" className="brand" onClick={() => go("market")}>
          <span className="mark">M</span>
          <span className="brand-text"><strong>Monaqasat Intelligence</strong><small>Who wins Qatar's public tenders</small></span>
        </button>
        <nav className="steps" aria-label="Sections">
          <button type="button" className={route === "raw" ? "on" : ""} onClick={() => go("raw")}><i>1</i> Raw data</button>
          <button type="button" className={intel ? "on" : ""} onClick={() => go("market")}><i>2</i> Intelligence</button>
          <button type="button" className={route === "ask" ? "on" : ""} onClick={() => go("ask")}><i>3</i> Ask</button>
          <button type="button" className={`plain ${route === "method" ? "on" : ""}`} onClick={() => go("method")}>How it works</button>
        </nav>
      </header>

      {intel && (
        <div className="subnav">
          <nav aria-label="Intelligence views">
            {INTEL.map((t) => (
              <button type="button" key={t.id} className={route === t.id ? "on" : ""} onClick={() => go(t.id)}>{t.label}</button>
            ))}
          </nav>
          <div className="filters">
            <label>Category
              <select id="f-cat" value={cat} onChange={(e) => setCat(e.target.value)}>
                <option value="">All categories</option>
                {Object.entries(data.categories).map(([slug, label]) => <option key={slug} value={slug}>{label}</option>)}
              </select>
            </label>
            <div className="period" role="group" aria-label="Period">
              {PERIODS.map((p) => <button type="button" key={p.id} className={period === p.id ? "on" : ""} onClick={() => setPeriod(p.id)}>{p.label}</button>)}
            </div>
          </div>
        </div>
      )}

      <main>
        {route === "raw" && <Raw {...ctx} />}
        {route === "market" && <Market {...ctx} />}
        {route === "competitors" && <Competitors {...ctx} selected={company} setSelected={setCompany} />}
        {route === "ministries" && <Ministries {...ctx} selected={buyer} setSelected={setBuyer} />}
        {route === "retenders" && <Retenders {...ctx} />}
        {route === "ask" && <Ask {...ctx} seed={askSeed} />}
        {route === "method" && <Method {...ctx} />}
      </main>
      <footer>
        Source: public award reports on monaqasat.mof.gov.qa (Ministry of Finance). Awards {date(data.period.from)} – {date(data.period.to)}. Data built {date(data.builtAt)}. Independent analysis, not affiliated with the Ministry.
      </footer>
    </div>
  );
}

// ── shared bits ──────────────────────────────────────────────────────────────
function Hero({ eyebrow, title, text, children, center }) {
  return (
    <section className={`hero ${center ? "center" : ""} ${children ? "" : "solo"}`}>
      <div className="hero-text">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {text && <p>{text}</p>}
      </div>
      {children}
    </section>
  );
}
function Kpis({ items }) {
  return <div className="hero-kpis">{items.map(([l, v, s]) => <div className="kpi" key={l}><span>{l}</span><strong className={String(v).length > 14 ? "long" : ""}>{v}</strong>{s && <small>{s}</small>}</div>)}</div>;
}
function Card({ title, note, right, children, className = "" }) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && <div className="card-head"><h2>{title}</h2>{right && <span>{right}</span>}</div>}
      {note && <p className="note">{note}</p>}
      {children}
    </section>
  );
}
const Link = ({ onClick, children }) => <button type="button" className="link" onClick={onClick}>{children}</button>;
function Empty({ children = "No awards match this filter." }) { return <p className="empty">{children}</p>; }

// ── 1 · raw data ─────────────────────────────────────────────────────────────
function issuesOf(r) {
  const out = [];
  const title = String(r.title ?? "").trim();
  if (!title || /^\d+$/.test(title)) out.push(["bad", "Empty title · dropped"]);
  else if (title === title.toUpperCase() && /[A-Z]{4}/.test(title)) out.push(["warn", "All capitals"]);
  if (/^1899|^1900/.test(String(r.awardDate ?? r.closingDate ?? ""))) out.push(["bad", "Impossible date · cleared"]);
  const joint = [...(r.awardedCompanies ?? []), ...(r.openedCompanies ?? [])].some((c) => (c.commercialRegistrationNumbers?.length ?? 0) > 1);
  if (joint) out.push(["warn", "Joint registration no."]);
  if (!(r.awardedCompanies ?? []).length && title) out.push(["warn", "No winner listed"]);
  return out.length ? out : [["ok", "Clean"]];
}

function Raw({ data, name }) {
  const [raw, setRaw] = useState(null);
  const [pick, setPick] = useState(null);
  useEffect(() => { fetch("/tender-data/raw-sample.json").then((r) => r.json()).then(setRaw).catch(() => setRaw({ records: [] })); }, []);
  const c = data.checks;
  const recs = raw?.records ?? [];
  const current = recs.find((r) => r.tenderNumber === pick) ?? recs.find((r) => (r.openedCompanies?.length ?? 0) >= 3) ?? recs[0];
  const clean = current && data.tenders.find((t) => t.no === current.tenderNumber);
  const steps = [
    ["Scrape", c.recordsRead.toLocaleString(), "records read", "award lists and award reports, every page saved raw"],
    ["Clean", c.tenders.toLocaleString(), "tenders kept", `${c.notAwardReport} non-award pages, ${c.duplicateRecords} duplicates, ${c.emptyRecords} empty, ${c.badDatesCleared} bad dates`],
    ["Match", c.companies.toLocaleString(), "companies", `from ${c.companyRows.toLocaleString()} company rows; ${c.companiesWithSeveralSpellings} under several spellings`],
    ["Categorise", Object.keys(data.categories).length, "categories", "keyword rules on tender titles"],
    ["Analyse", data.tenders.filter((t) => t.bid.length).length.toLocaleString(), "tenders with offers", "winners, prices, buyers, re-tenders"],
  ];
  const shown = current ? {
    tenderNumber: current.tenderNumber, title: current.title, entity: current.entity, awardDate: current.awardDate,
    awardedAmount: current.awardedAmount,
    awardedCompanies: (current.awardedCompanies ?? []).slice(0, 2).map((x) => ({ companyName: x.companyName, commercialRegistrationNumber: x.commercialRegistrationNumber, approvedValue: x.approvedValue })),
    openedCompanies: `${(current.openedCompanies ?? []).length} offers`,
    fetchedAt: current.fetchedAt,
  } : null;

  return (
    <div className="stack">
      <Hero eyebrow="Step 1 · What we collected" title={<>From {c.recordsRead.toLocaleString()} scraped pages to {c.tenders.toLocaleString()} clean tenders.</>}
        text="A polite scraper reads every public award report on monaqasat.mof.gov.qa, one page every 2–4 seconds. Each page is saved raw, then cleaned, matched and categorised." />
      <section className="pipeline" aria-label="Pipeline">
        {steps.map(([n, big, unit, detail], i) => (
          <div key={n}><span className="pl-step">{i + 1} · {n}</span><strong>{big}</strong><span className="pl-unit">{unit}</span><small>{detail}</small></div>
        ))}
      </section>
      {current && (
        <section className="compare">
          <div className="raw-box">
            <div className="box-head"><strong>As scraped</strong><span>tender {current.tenderNumber} · raw JSON</span></div>
            <pre>{JSON.stringify(shown, null, 2)}</pre>
          </div>
          <div className="card clean-box">
            <div className="box-head"><strong>After cleaning</strong><span>what the intelligence uses</span></div>
            {clean ? (
              <>
                <h3>{nice(clean.t) || clean.no}</h3>
                <dl>
                  <div><dt>Buyer</dt><dd>{clean.e ?? "—"}</dd></div>
                  <div><dt>Category</dt><dd><span className="chip">{data.categories[clean.cat]}</span></dd></div>
                  <div><dt>Awarded</dt><dd>{date(clean.ad)} · {qar(clean.amt)}</dd></div>
                  <div><dt>Winner{clean.win.length > 1 ? "s (split award)" : ""}</dt><dd>{clean.win.map((w) => name(w.c)).join(", ") || "—"}</dd></div>
                  <div><dt>Offers</dt><dd>{clean.bid.length ? `${clean.bid.length} companies${clean.bid.some((b) => b.a) ? ", priced" : ""}` : "not published"}</dd></div>
                  <div><dt>Contract length</dt><dd>{clean.dur ? `${clean.dur} months (from title)` : "not stated"}</dd></div>
                </dl>
                {clean.id && <a className="ext" href={REPORT(clean.id)} target="_blank" rel="noreferrer">Official award report <ExternalLink size={13} /></a>}
              </>
            ) : <p className="note">This record was dropped during cleaning.</p>}
          </div>
        </section>
      )}
      <Card title="Latest raw records" right="click a row to compare raw and clean">
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>Tender</th><th>Title (raw)</th><th>Entity</th><th>Award date</th><th>Issues found</th></tr></thead>
            <tbody>
              {recs.slice(0, 40).map((r) => (
                <tr key={r.tenderNumber} className={r.tenderNumber === current?.tenderNumber ? "sel" : ""} onClick={() => { setPick(r.tenderNumber); scrollTo({ top: 0, behavior: "smooth" }); }}>
                  <td className="mono">{r.tenderNumber}</td><td>{String(r.title ?? "").slice(0, 90)}</td><td>{r.entity}</td><td className="nowrap">{r.awardDate}</td>
                  <td>{issuesOf(r).map(([k, l]) => <span key={l} className={`badge ${k}`}>{l}</span>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ── 2 · market ───────────────────────────────────────────────────────────────
function Market({ data, all, T, name, openCompany, openBuyer, setCat, cat, period }) {
  const K = kpis(T);
  const cats = byCategory(all, data.categories);
  const board = leaderboard(T).sort((a, b) => b.wins - a.wins || b.value - a.value);
  const B = buyers(T).sort((a, b) => b.value - a.value);
  const comp = competition(T);
  const months = monthly(T);
  const totalAll = cats.reduce((s, r) => s + r.value, 0) || 1;
  const topNamed = cats.find((r) => r.slug !== "other");
  const flows = B.slice(0, 6).flatMap((b) => b.suppliers.slice(0, 3).map((s) => ({ from: b.e, to: `${b.e}|${s.c}`, toId: s.c, toLabel: name(s.c), value: s.value, count: s.wins })));
  const gaps = T.flatMap((t) => {
    const priced = t.bid.filter((b) => b.a > 0), w = priced.filter((b) => b.w);
    if (priced.length < 2 || !w.length) return [];
    const min = Math.min(...priced.map((b) => b.a));
    return [{ no: t.no, gap: Math.max(0, (Math.min(...w.map((b) => b.a)) / min - 1) * 100) }];
  });
  const maxDist = Math.max(1, ...comp.dist.map((d) => d.tenders));
  const span = PERIODS.find((p) => p.id === period).label;

  const title = cat
    ? <>{data.categories[cat]}: {K.tenders} awards worth {qar(K.value)}.</>
    : topNamed && topNamed.value / totalAll >= 0.25
      ? <>{topNamed.value / totalAll >= 0.45 && topNamed.value / totalAll <= 0.55 ? "Half" : pct(topNamed.value / totalAll)} of all the money went to {topNamed.name.split(" &")[0].toLowerCase()}.</>
      : topNamed ? <>{topNamed.name} is the biggest market.</> : <>The market at a glance.</>;
  const text = board[0]
    ? <>{name(board[0].c)} won the most contracts ({board[0].wins}). {K.singleBidShare != null && <>{pct(K.singleBidShare)} of tenders with published offers had a single bidder.</>}</>
    : null;

  if (!T.length) return <div className="stack"><Hero title="No awards in this selection." text="Try a longer period or another category." /></div>;
  return (
    <div className="stack">
      <Hero eyebrow={`${span} · ${K.tenders.toLocaleString()} tenders · ${qar(K.value)}`} title={title} text={text}>
        <Kpis items={[["Companies", K.companies.toLocaleString()], ["Ministries", K.buyers], ["Lowest offer won", pct(comp.lowestWinsShare)], ["Single bidder", pct(K.singleBidShare)]]} />
      </Hero>

      {!cat && (
        <Card title="Where the money is" right="box size = awarded value · click a box to filter every chart">
          <CategoryTreemap rows={cats} fmt={(v) => qar(v)} active={cat} onPick={(s) => setCat(s === cat ? "" : s)} />
        </Card>
      )}

      <Card title="Who buys from whom" note="The six biggest buyers and their three biggest suppliers. Line width = value. Click a name to open it.">
        {flows.length ? <FlowChart rows={flows} fmt={qar} onLeft={openBuyer} onRight={openCompany} /> : <Empty />}
      </Card>

      <div className="grid-12">
        <Card className="span-7" title="Does the cheapest offer win?" note="Each dot is a tender with priced offers. Further right = the winner was more expensive than the lowest offer.">
          {gaps.length ? <PriceStrip gaps={gaps} /> : <Empty>No tenders with priced offers here.</Empty>}
        </Card>
        <Card className="span-5" title="How much goes to one supplier" note="Share of a buyer's awarded value won by its biggest supplier (buyers with 5+ awards).">
          <ShareBars onPick={openBuyer} rows={B.filter((b) => b.tenders >= 5 && b.topShare != null).sort((a, b) => b.topShare - a.topShare).slice(0, 6)
            .map((b) => ({ key: b.e, label: b.e, share: b.topShare, sub: `to ${name(b.suppliers[0].c)}` }))} />
        </Card>
      </div>

      <div className="grid-12">
        <Card className="span-7" title="Top winners" right="contracts · value · win rate">
          <ol className="winners">
            {board.slice(0, 8).map((r, i) => (
              <li key={r.c}><button type="button" onClick={() => openCompany(r.c)}>
                <span className="wr">{i + 1}</span>
                <span className="wn"><b>{name(r.c)}</b><i><em style={{ width: `${(r.wins / board[0].wins) * 100}%` }} /></i></span>
                <strong>{r.wins}</strong><span className="wv">{qar(r.value)}</span><span className="wv">{pct(r.winRate)}</span>
              </button></li>
            ))}
          </ol>
        </Card>
        <Card className="span-5" title="How many companies bid" note="Tenders by number of offers, where offers are published. Gold: only one bidder.">
          <div className="dist">
            {comp.dist.map((d) => (
              <div key={d.bids}><span>{d.tenders}</span><i style={{ height: `${(d.tenders / maxDist) * 140}px` }} className={d.bids === "1" ? "single" : ""} /><b>{d.bids}</b></div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid-12">
        <Card className="span-12" title="Awards per month" note="Bars: number of awards. Line: value.">
          <div className="chart">
            <ResponsiveContainer width="100%" height={240}>
              <ComposedChart data={months} margin={{ top: 8, right: 4, left: -8, bottom: 0 }}>
                <CartesianGrid stroke="var(--grid)" vertical={false} />
                <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fill: "var(--muted)", fontSize: 12 }} stroke="var(--line)" />
                <YAxis yAxisId="n" tick={{ fill: "var(--muted)", fontSize: 12 }} width={36} stroke="var(--line)" />
                <YAxis yAxisId="v" orientation="right" hide />
                <Tooltip formatter={(v, k) => (k === "Value" ? qar(v) : v)} labelFormatter={monthLabel} contentStyle={tipStyle} />
                <Bar yAxisId="n" dataKey="tenders" name="Tenders" fill="var(--accent)" radius={[4, 4, 0, 0]} />
                <Line yAxisId="v" dataKey="value" name="Value" stroke="#c7a24a" strokeWidth={2} dot={{ r: 3 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── 2 · competitors ──────────────────────────────────────────────────────────
function Competitors({ T, data, name, selected, setSelected, openBuyer, ask }) {
  const [q, setQ] = useState("");
  const board = useMemo(() => leaderboard(T).sort((a, b) => b.wins - a.wins || b.value - a.value), [T]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return board.filter((r) => !s || name(r.c).toLowerCase().includes(s) || data.companies[r.c].alt.some((a) => a.toLowerCase().includes(s))).slice(0, 60);
  }, [board, q]);
  const current = selected != null && board.some((r) => r.c === selected) ? selected : list[0]?.c;
  if (current == null) return <div className="stack"><Hero title="No companies in this selection." text="Try a longer period or another category." /></div>;
  const r = board.find((x) => x.c === current);
  const p = companyProfile(T, current);
  const pp = pricePosition(T, current);
  const months = winsByMonth(T, current);
  const entered = p.won.length + p.lost.length;
  const topBuyer = p.buyers[0];
  const nm = name(current);
  const title = pp.n >= 5 && pp.lowestShare < 0.3 ? <>{nm} wins without being the cheapest.</>
    : pp.n >= 5 && pp.lowestShare >= 0.7 ? <>{nm} wins on price.</>
    : <>{nm} won {p.won.length} of {entered} tenders it entered.</>;
  const text = <>{p.won.length} contracts worth {qar(p.value)}{topBuyer ? <>, {topBuyer[1] === p.won.length ? "all" : `${topBuyer[1]}`} from {topBuyer[0]}</> : null}.{pp.n ? <> Its offer was the lowest in {Math.round(pp.lowestShare * pp.n)} of {pp.n} priced tenders.</> : null}</>;
  const maxMonth = Math.max(1, ...months.map((m) => m.wins));

  return (
    <div className="side-layout">
      <aside className="card side-list">
        <label className="search"><Search size={15} /><input id="company-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a company" /></label>
        <div className="side-scroll">
          {list.map((x) => (
            <button type="button" key={x.c} className={x.c === current ? "on" : ""} onClick={() => setSelected(x.c)}>
              <span className="sl-name">{name(x.c)}</span><strong>{x.wins}</strong>
              <i><em style={{ width: `${(x.wins / (board[0]?.wins || 1)) * 100}%` }} /></i>
            </button>
          ))}
        </div>
      </aside>
      <div className="stack">
        <Hero eyebrow="Company profile" title={title} text={text} />
        {data.companies[current].alt.length > 0 && <p className="note">Also written as: {data.companies[current].alt.join(" · ")}</p>}
        <Kpis items={[["Contracts won", p.won.length], ["Win rate", pct(r.winRate), `${p.won.length} of ${entered} entered`], ["Value won", qar(p.value)], ["Main buyer", topBuyer ? topBuyer[0] : "—", topBuyer ? `${topBuyer[1]} of ${p.won.length} wins` : null]]} />
        <div className="grid-12">
          <Card className="span-6" title="Price position" note={pp.n ? `Its offers compared with the lowest offer in the same tender (${pp.n} priced tenders).` : "No priced offers published for this company."}>
            {pp.n > 0 && (
              <>
                <div className="pricebar">
                  <div className="pb-track" />
                  <span className="pb-dot" style={{ left: `${Math.min(96, (pp.medianAbove ?? 0) / 2 * 100)}%` }} />
                  <span className="pb-label" style={{ left: `${Math.min(80, Math.max(12, (pp.medianAbove ?? 0) / 2 * 100))}%` }}>{pp.medianAbove < 0.005 ? "usually the lowest offer" : `median ${pct(pp.medianAbove)} above lowest`}</span>
                </div>
                <div className="pb-axis"><span>lowest offer</span><span>+100%</span><span>+200%</span></div>
                <p>Lowest offer in <b>{Math.round(pp.lowestShare * pp.n)} of {pp.n}</b> priced tenders.</p>
              </>
            )}
          </Card>
          <Card className="span-6" title="Head to head" note="Rivals met most often. Maroon: this company won, gold: the rival won.">
            {p.rivals.length ? p.rivals.slice(0, 5).map((x) => (
              <button type="button" key={x.c} className="h2h" onClick={() => setSelected(x.c)}>
                <span>{name(x.c)}</span><small>met {x.met}</small>
                <i><em style={{ width: `${(x.beat / x.met) * 100}%` }} /><b style={{ width: `${(x.lostTo / x.met) * 100}%` }} /></i>
              </button>
            )) : <Empty>No shared tenders with published offers.</Empty>}
          </Card>
        </div>
        <div className="grid-12">
          <Card className="span-7" title="Latest wins" right={<Link onClick={() => ask(`What has ${nm} won and from whom?`)}>Ask about this company <ArrowRight size={13} /></Link>}>
            <TenderList tenders={p.won.slice(0, 6)} name={name} />
          </Card>
          <Card className="span-5" title="Wins per month">
            <div className="dist small">
              {months.map((m) => <div key={m.month}><span>{m.wins}</span><i style={{ height: `${(m.wins / maxMonth) * 110}px` }} /><b>{monthLabel(m.month)}</b></div>)}
            </div>
            {p.buyers.length > 1 && <p className="note">Buyers: {p.buyers.slice(0, 4).map(([e, n], i) => <span key={e}>{i ? " · " : ""}<Link onClick={() => openBuyer(e)}>{e}</Link> ({n})</span>)}</p>}
          </Card>
        </div>
      </div>
    </div>
  );
}

function TenderList({ tenders, name, scores }) {
  if (!tenders.length) return <Empty>No awards in this selection.</Empty>;
  return (
    <ul className="tenders">
      {tenders.map((t, i) => (
        <li key={t.no}>
          <div><b>{nice(t.t) || t.no}</b><small>{t.e} · {date(t.ad)} · {t.no}{scores ? ` · match ${Math.round(scores[i] * 100)}%` : ""}</small></div>
          <div className="r"><span>{qar(t.amt)}</span><small>{t.win.map((w) => name(w.c)).join(", ")}</small></div>
        </li>
      ))}
    </ul>
  );
}

// ── 2 · ministries ───────────────────────────────────────────────────────────
function Ministries({ T, name, selected, setSelected, openCompany }) {
  const rows = buyers(T).sort((a, b) => b.value - a.value);
  const current = rows.find((r) => r.e === selected) ?? rows[0];
  if (!current) return <div className="stack"><Hero title="No buyers in this selection." /></div>;
  const recent = T.filter((t) => t.e === current.e).slice(0, 6);
  const top = current.suppliers[0];
  const maxV = current.suppliers[0]?.value || 1;
  return (
    <div className="side-layout">
      <aside className="card side-list">
        <div className="side-scroll">
          {rows.map((x) => (
            <button type="button" key={x.e} className={x.e === current.e ? "on" : ""} onClick={() => setSelected(x.e)}>
              <span className="sl-name">{x.e}</span><strong>{x.tenders}</strong>
              <i><em style={{ width: `${(x.value / (rows[0].value || 1)) * 100}%` }} /></i>
            </button>
          ))}
        </div>
      </aside>
      <div className="stack">
        <Hero eyebrow="Buyer profile" title={top && current.topShare >= 0.5 ? <>{current.e} gives {pct(current.topShare)} of its spend to one supplier.</> : <>{current.e} spreads its spend over {current.suppliers.length} suppliers.</>}
          text={top ? <>Biggest supplier: {name(top.c)} ({qar(top.value)}, {top.wins} contract{top.wins === 1 ? "" : "s"}).</> : null} />
        <Kpis items={[["Awards", current.tenders], ["Awarded value", qar(current.value)], ["Suppliers used", current.suppliers.length], ["Offers per tender", current.avgBids?.toFixed(1) ?? "—"]]} />
        <div className="grid-12">
          <Card className="span-7" title="Who it buys from" note="By awarded value. Click to open the company.">
            <ol className="winners">
              {current.suppliers.slice(0, 8).map((s, i) => (
                <li key={s.c}><button type="button" onClick={() => openCompany(s.c)}>
                  <span className="wr">{i + 1}</span>
                  <span className="wn"><b>{name(s.c)}</b><i><em style={{ width: `${(s.value / maxV) * 100}%` }} /></i></span>
                  <strong>{s.wins}</strong><span className="wv">{qar(s.value)}</span><span className="wv">{pct(s.value / (current.value || 1))}</span>
                </button></li>
              ))}
            </ol>
          </Card>
          <Card className="span-5" title="Latest awards"><TenderList tenders={recent} name={name} /></Card>
        </div>
      </div>
    </div>
  );
}

// ── 2 · re-tender radar ──────────────────────────────────────────────────────
function Retenders({ T, data, name, openCompany, openBuyer }) {
  const today = new Date().toISOString().slice(0, 10);
  const R = retenders(T, today);
  const future = R.filter((r) => r.monthsLeft >= 0);
  const in3 = future.filter((r) => r.monthsLeft <= 3).length;
  const in12 = future.filter((r) => r.monthsLeft <= 12);
  const qmap = new Map();
  for (const r of future) {
    const d = new Date(r.end);
    const k = `Q${Math.floor(d.getMonth() / 3) + 1} ${String(d.getFullYear()).slice(2)}`;
    const e = qmap.get(k) ?? { k, n: 0, soon: r.monthsLeft <= 12 };
    e.n++;
    qmap.set(k, e);
  }
  const quarters = [...qmap.values()];
  const maxQ = Math.max(1, ...quarters.map((q) => q.n));
  return (
    <div className="stack">
      <Hero eyebrow="Contracts coming up again" title={<>{in12.length} contract{in12.length === 1 ? "" : "s"} will likely be re-tendered in the next 12 months.</>}
        text={'When a title states a length ("for three years"), the award date plus that length gives the expected end. Prepare before the new tender is published.'}>
        <Kpis items={[["Next 3 months", in3], ["Next 12 months", in12.length], ["Value due in 12 months", qar(in12.reduce((s, r) => s + (r.t.amt ?? 0), 0))], ["Based on", `${R.length} of ${T.length}`, "awards that state a length"]]} />
      </Hero>
      <Card title="When contracts end" right="expected end by quarter · maroon = within 12 months">
        {quarters.length ? (
          <div className="dist quarters">
            {quarters.map((q) => <div key={q.k}><span>{q.n}</span><i className={q.soon ? "" : "later"} style={{ height: `${(q.n / maxQ) * 150}px` }} /><b>{q.k}</b></div>)}
          </div>
        ) : <Empty>No stated contract lengths in this selection.</Empty>}
      </Card>
      <Card title="Coming up next" note="Estimate only: contracts can be extended or re-tendered early.">
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>Expected end</th><th>Contract</th><th>Buyer</th><th>Current holder</th><th className="r">Length</th><th className="r">Value</th></tr></thead>
            <tbody>
              {future.slice(0, 25).map(({ t, end }) => (
                <tr key={t.no} onClick={() => t.win[0] && openCompany(t.win[0].c)}>
                  <td className="nowrap"><span className="chip">{new Date(end).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}</span></td>
                  <td>{nice(t.t)}</td>
                  <td><Link onClick={(e) => { openBuyer(t.e); }}>{t.e}</Link></td>
                  <td className="w500">{t.win.map((w) => name(w.c)).join(", ") || "—"}</td>
                  <td className="r nowrap">{t.dur} mo</td>
                  <td className="r nowrap">{qar(t.amt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ── 3 · ask (RAG) ────────────────────────────────────────────────────────────
const EXAMPLES = ["Who supplies medical consumables to Hamad Medical, and at what prices?", "Who won the most contracts?", "What do CCTV and security systems usually cost?", "Which contracts with Kahramaa end soon?"];

function renderAnswer(text, onCite) {
  const inline = (line, key) => line.split(/(\*\*[^*]+\*\*|\[\d+\])/g).map((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) return <b key={`${key}-${i}`}>{part.slice(2, -2)}</b>;
    const m = part.match(/^\[(\d+)\]$/);
    if (m) return <button type="button" key={`${key}-${i}`} className="cite" onClick={() => onCite(Number(m[1]))}>{m[1]}</button>;
    return <React.Fragment key={`${key}-${i}`}>{part}</React.Fragment>;
  });
  const blocks = [];
  let list = null;
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line) { list = null; return; }
    if (/^[-*•]\s+/.test(line)) {
      if (!list) { list = []; blocks.push(<ul key={`u${i}`}>{list}</ul>); }
      list.push(<li key={i}>{inline(line.replace(/^[-*•]\s+/, ""), i)}</li>);
    } else {
      list = null;
      blocks.push(<p key={i}>{inline(line.replace(/^#+\s*/, ""), i)}</p>);
    }
  });
  return blocks;
}

function Ask({ data, index, name, seed, openCompany, openBuyer }) {
  const [q, setQ] = useState(seed || "");
  const [state, setState] = useState({ status: "idle" });
  const [hl, setHl] = useState(null);

  const run = async (question) => {
    const text = question.trim();
    if (text.length < 3) return;
    setQ(text);
    setState({ status: "loading" });
    const t0 = performance.now();
    try {
      const r = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: text }) });
      if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) throw new Error("no server");
      const j = await r.json();
      setState({ status: "done", ...j, ms: j.ms ?? Math.round(performance.now() - t0) });
    } catch {
      // Static deployment: no answer server. Retrieve in the browser and summarise.
      const hits = search(index, data.tenders, text, 12, 0.06);
      setState({
        status: "done", answer: null, fallback: summarize(hits), engine: "Retrieval only (AI answers run on the local version)",
        sources: hits.map((h, i) => ({ n: i + 1, no: h.t.no, id: h.t.id, title: h.t.t, ministry: h.t.e, date: h.t.ad, value: h.t.amt })),
        ms: Math.round(performance.now() - t0),
      });
    }
  };
  useEffect(() => { if (seed) run(seed); }, [seed]);
  const cite = (n) => { setHl(n); document.getElementById(`src-${n}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }); };
  const s = state;

  return (
    <div className="stack">
      <section className="ask-hero">
        <span className="eyebrow">Step 3 · Ask the data</span>
        <h1>Ask anything about Qatar's tender awards.</h1>
        <p>Answers come only from the scraped award records, with a citation for every claim. If the data doesn't show it, it says so.</p>
        <form className="ask-box" onSubmit={(e) => { e.preventDefault(); run(q); }}>
          <Search size={18} />
          <input id="ask-q" aria-label="Your question" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Who supplies medical consumables to Hamad Medical?" />
          <button className="primary" type="submit" disabled={s.status === "loading"}>{s.status === "loading" ? "Thinking…" : "Ask"}</button>
        </form>
        <div className="examples">{EXAMPLES.map((x) => <button type="button" key={x} onClick={() => run(x)}>{x}</button>)}</div>
      </section>

      {s.status === "loading" && <section className="card"><div className="loading-lines"><i /><i /><i /></div><p className="note">Finding the relevant records and writing the answer…</p></section>}

      {s.status === "done" && (
        <div className="grid-12 start">
          <Card className="span-7 answer" title="Answer" right={<span className="engine">{s.engine}{s.ms ? ` · ${(s.ms / 1000).toFixed(1)}s` : ""}</span>}>
            {s.answer ? <div className="answer-text">{renderAnswer(s.answer, cite)}</div> : s.fallback && s.fallback.n ? (
              <ul className="qa-list">
                {s.warning && <li className="note">{s.warning.includes("authenticate") ? "Claude is not logged in on this computer, so this is the retrieval-only answer." : "The AI step is not available, so this is the retrieval-only answer."}</li>}
                <li><span>Usually won by</span>{s.fallback.topWinners.map(([c, n], i) => <span key={c}>{i ? ", " : ""}<Link onClick={() => openCompany(c)}>{name(c)}</Link> ({n})</span>)}</li>
                <li><span>Typical winning value</span>{s.fallback.value ? <>median {qar(s.fallback.value.med)}; middle half {qar(s.fallback.value.p25)} – {qar(s.fallback.value.p75)}</> : "not published"}</li>
                <li><span>Who buys this</span>{s.fallback.buyers.map(([e, n], i) => <span key={e}>{i ? ", " : ""}<Link onClick={() => openBuyer(e)}>{e}</Link> ({n})</span>)}</li>
                <li><span>Competition</span>{s.fallback.avgBids ? `${s.fallback.avgBids.toFixed(1)} offers per tender` : "offers not published"}</li>
              </ul>
            ) : <Empty>No matching records. Try other words (titles are in English).</Empty>}
            <div className="answer-foot"><span>Retrieved: {s.sources?.length ?? 0} records (TF-IDF)</span><span>Every [n] opens the official award report</span></div>
          </Card>
          <aside className="span-5 sources">
            <h2>Sources</h2>
            {(s.sources ?? []).map((src) => (
              <a key={src.n} id={`src-${src.n}`} className={hl === src.n ? "on" : ""} href={src.id ? REPORT(src.id) : undefined} target="_blank" rel="noreferrer">
                <i>{src.n}</i><b>{nice(src.title) || src.no}</b><small>{src.no} · {src.ministry} · {date(src.date)} · {qar(src.value)}</small>
              </a>
            ))}
          </aside>
        </div>
      )}

      <section className="how3">
        <div><span>1 · Retrieve</span>TF-IDF search over titles, buyers, categories and winners picks the most relevant awards, plus market facts.</div>
        <div><span>2 · Generate</span>Claude writes the answer from those records only, citing each claim. No outside knowledge, no tools.</div>
        <div><span>3 · Check</span>Every [n] links to the official award report. If the data has no answer, it says so.</div>
      </section>
    </div>
  );
}

// ── how it works ─────────────────────────────────────────────────────────────
function Method({ data }) {
  const c = data.checks;
  const steps = [
    ["Collect", "A Crawlee scraper (on Apify or locally) reads the public award lists and every award report on monaqasat.mof.gov.qa. One request at a time, 2–4 seconds apart. Every page is saved raw so it can be parsed again without visiting the site."],
    ["Clean", `Records without a tender number or content are dropped, impossible dates (like 1899) are cleared, and when a tender appears twice the newest copy is kept. This build: ${c.recordsRead.toLocaleString()} records read, ${c.duplicateRecords} duplicates, ${c.emptyRecords} empty, ${c.badDatesCleared} bad dates.`],
    ["Match companies", `The same company is written in different ways (English, Arabic, with or without "W.L.L."). Names are normalised, and a single commercial registration number is used as the key. ${c.companyRows.toLocaleString()} company rows became ${c.companies.toLocaleString()} companies.`],
    ["Categorise", `Weighted keyword rules on tender titles give 13 categories (construction, pharma, IT ...). Titles the rules can't place are classified by Claude Haiku once and cached (${c.categoriesFromAI ?? 0} tenders). Tenders published without a subject get their official activity names instead (${c.titlesFromActivities ?? 0}).`],
    ["Analyse", "Win counts and win rates, who buys from whom, supplier concentration, price position (offer vs lowest offer) and a re-tender radar from contract lengths stated in titles."],
    ["Ask", "Retrieval-augmented answers: TF-IDF finds the relevant awards, Claude (run locally through its command-line tool) answers only from them and cites each record. On the public site the same search shows a computed summary instead."],
  ];
  return (
    <div className="stack">
      <Hero eyebrow="How it works" title="A data pipeline, then questions on top." />
      <Card><ol className="steps-list">{steps.map(([h, p]) => <li key={h}><h3>{h}</h3><p>{p}</p></li>)}</ol></Card>
      <Card title="Limits">
        <ul className="plain">
          <li>Only awards published on Monaqasat are covered.</li>
          <li>Many tenders publish no offer amounts, so price comparisons use only those that do.</li>
          <li>Company matching and categories are rule-based; some companies or titles may be grouped wrongly.</li>
          <li>The re-tender radar only covers contracts whose title states a length, and contracts can be extended.</li>
        </ul>
      </Card>
    </div>
  );
}

const rootEl = document.getElementById("root");
const root = window.__miRoot ?? (window.__miRoot = createRoot(rootEl));
root.render(<App />);
