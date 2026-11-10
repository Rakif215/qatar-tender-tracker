// TF-IDF similarity search over tender titles (same method as server/similarity.js,
// moved to the browser so the dashboard needs no database).
import { median, quantile, winnerValues } from "./analytics.js";

const STOP = new Set(("the and for from with that this into have been will shall their which each more some about than them " +
  "then also other through between within under upon after before during its are was were has had not but can all any our " +
  "out you your may should would could per such one two three new old work works related services service supply providing " +
  "provision project contract tender required including various general different number part parts year years state qatar doha " +
  "who what which won win most best much many how where when tenders companies company").split(" "));

export function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

export function buildIndex(tenders) {
  const docs = tenders.map((t) => tokenize(`${t.t} ${t.t} ${t.k ?? ""}`));
  const df = new Map();
  docs.forEach((d) => new Set(d).forEach((w) => df.set(w, (df.get(w) ?? 0) + 1)));
  const N = docs.length;
  const idf = new Map([...df].map(([w, n]) => [w, Math.log((N + 1) / (n + 1)) + 1]));
  const vectors = docs.map((d) => toVector(d, idf));
  return { idf, vectors };
}

function toVector(tokens, idf) {
  const tf = new Map();
  tokens.forEach((w) => tf.set(w, (tf.get(w) ?? 0) + 1));
  const v = new Map();
  let norm = 0;
  for (const [w, n] of tf) {
    const x = (n / (tokens.length || 1)) * (idf.get(w) ?? 0);
    if (x) { v.set(w, x); norm += x * x; }
  }
  norm = Math.sqrt(norm) || 1;
  for (const [w, x] of v) v.set(w, x / norm);
  return v;
}

export function search(index, tenders, query, k = 25, minScore = 0.08) {
  const q = toVector(tokenize(query), index.idf);
  if (!q.size) return [];
  const hits = [];
  index.vectors.forEach((v, i) => {
    let s = 0;
    for (const [w, x] of q) { const y = v.get(w); if (y) s += x * y; }
    if (s >= minScore) hits.push({ t: tenders[i], score: s });
  });
  return hits.sort((a, b) => b.score - a.score).slice(0, k);
}

// Turn the retrieved tenders into a short answer: who wins, at what price, who buys.
export function summarize(hits) {
  const wins = new Map(), entered = new Map(), buyers = new Map();
  const values = [], bidCounts = [];
  for (const { t } of hits) {
    for (const w of winnerValues(t)) {
      wins.set(w.c, (wins.get(w.c) ?? 0) + 1);
      if (w.v) values.push(w.v);
    }
    const ps = new Set([...t.bid.map((b) => b.c), ...t.win.map((w) => w.c)]);
    ps.forEach((c) => entered.set(c, (entered.get(c) ?? 0) + 1));
    if (t.bid.length) bidCounts.push(t.bid.length);
    if (t.e) buyers.set(t.e, (buyers.get(t.e) ?? 0) + 1);
  }
  const sort = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return {
    n: hits.length,
    topWinners: sort(wins).slice(0, 5),
    frequentBidders: sort(entered).slice(0, 6),
    buyers: sort(buyers).slice(0, 4),
    value: values.length ? { p25: quantile(values, 0.25), med: median(values), p75: quantile(values, 0.75), n: values.length } : null,
    avgBids: bidCounts.length ? bidCounts.reduce((a, b) => a + b, 0) / bidCounts.length : null,
  };
}
