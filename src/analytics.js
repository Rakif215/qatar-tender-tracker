// Pure functions over the cleaned dataset (public/tender-data/tenders.json).
// A tender: { no, t, e, m, k, ad, amt, win:[{c,v}], bid:[{c,a,w}] }

export function filterByPeriod(tenders, months, toDate) {
  if (!months) return tenders;
  const end = new Date(toDate);
  const start = new Date(end);
  start.setMonth(start.getMonth() - months);
  const from = start.toISOString().slice(0, 10);
  return tenders.filter((t) => t.ad && t.ad > from);
}

export function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function quantile(arr, q) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

// Value credited to each winner: its approved value, else the award split evenly.
export function winnerValues(t) {
  if (!t.win.length) return [];
  const known = t.win.every((w) => w.v != null);
  return t.win.map((w) => ({ c: w.c, v: known ? w.v : (t.amt ?? 0) / t.win.length }));
}

export function participants(t) {
  const set = new Set(t.bid.map((b) => b.c));
  t.win.forEach((w) => set.add(w.c));
  return set;
}

export function kpis(T) {
  const companies = new Set();
  const buyers = new Set();
  let value = 0, withBids = 0, bidSum = 0, single = 0;
  for (const t of T) {
    participants(t).forEach((c) => companies.add(c));
    if (t.e) buyers.add(t.e);
    value += t.amt ?? 0;
    if (t.bid.length) {
      withBids++;
      bidSum += t.bid.length;
      if (t.bid.length === 1) single++;
    }
  }
  return {
    tenders: T.length,
    value,
    companies: companies.size,
    buyers: buyers.size,
    avgBids: withBids ? bidSum / withBids : null,
    singleBidShare: withBids ? single / withBids : null,
  };
}

export function monthly(T) {
  const map = new Map();
  for (const t of T) {
    if (!t.ad) continue;
    const k = t.ad.slice(0, 7);
    const r = map.get(k) ?? { month: k, tenders: 0, value: 0 };
    r.tenders++;
    r.value += t.amt ?? 0;
    map.set(k, r);
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export function leaderboard(T) {
  const map = new Map();
  const get = (c) => {
    if (!map.has(c)) map.set(c, { c, wins: 0, value: 0, entered: 0, buyers: new Map() });
    return map.get(c);
  };
  for (const t of T) {
    participants(t).forEach((c) => get(c).entered++);
    for (const w of winnerValues(t)) {
      const r = get(w.c);
      r.wins++;
      r.value += w.v ?? 0;
      if (t.e) r.buyers.set(t.e, (r.buyers.get(t.e) ?? 0) + 1);
    }
  }
  return [...map.values()].map((r) => ({
    ...r,
    winRate: r.entered ? r.wins / r.entered : 0,
    topBuyer: [...r.buyers.entries()].sort((a, b) => b[1] - a[1])[0] ?? null,
  }));
}

export function buyers(T) {
  const map = new Map();
  for (const t of T) {
    if (!t.e) continue;
    const r = map.get(t.e) ?? { e: t.e, tenders: 0, value: 0, suppliers: new Map(), bids: 0, withBids: 0 };
    r.tenders++;
    r.value += t.amt ?? 0;
    if (t.bid.length) { r.bids += t.bid.length; r.withBids++; }
    for (const w of winnerValues(t)) {
      const s = r.suppliers.get(w.c) ?? { c: w.c, wins: 0, value: 0 };
      s.wins++;
      s.value += w.v ?? 0;
      r.suppliers.set(w.c, s);
    }
    map.set(t.e, r);
  }
  return [...map.values()].map((r) => {
    const sup = [...r.suppliers.values()].sort((a, b) => b.value - a.value);
    return {
      ...r,
      suppliers: sup,
      topShare: r.value && sup[0] ? sup[0].value / r.value : null,
      avgBids: r.withBids ? r.bids / r.withBids : null,
    };
  });
}

// Price competition: does the lowest offer win, and by how much do winners differ?
export function competition(T) {
  const dist = { "1": 0, "2": 0, "3": 0, "4": 0, "5+": 0 };
  let compared = 0, lowestWins = 0;
  const premiums = [];
  for (const t of T) {
    const n = t.bid.length;
    if (n) dist[n >= 5 ? "5+" : String(n)]++;
    const priced = t.bid.filter((b) => b.a > 0);
    const winners = priced.filter((b) => b.w);
    if (priced.length >= 2 && winners.length === 1) {
      compared++;
      const min = Math.min(...priced.map((b) => b.a));
      if (winners[0].a <= min * 1.0001) lowestWins++;
      else premiums.push(winners[0].a / min - 1);
    }
  }
  return {
    dist: Object.entries(dist).map(([bids, tenders]) => ({ bids, tenders })),
    compared,
    lowestWinsShare: compared ? lowestWins / compared : null,
    medianPremium: median(premiums),
    notLowest: premiums.length,
  };
}

export function companyProfile(T, c) {
  const won = [], lost = [];
  const rivals = new Map();
  const buyersMap = new Map();
  for (const t of T) {
    if (!participants(t).has(c)) continue;
    const isWin = t.win.some((w) => w.c === c);
    (isWin ? won : lost).push(t);
    if (isWin && t.e) buyersMap.set(t.e, (buyersMap.get(t.e) ?? 0) + 1);
    for (const o of participants(t)) {
      if (o === c) continue;
      const r = rivals.get(o) ?? { c: o, met: 0, beat: 0, lostTo: 0 };
      r.met++;
      const oWon = t.win.some((w) => w.c === o);
      if (isWin && !oWon) r.beat++;
      if (oWon && !isWin) r.lostTo++;
      rivals.set(o, r);
    }
  }
  return {
    won,
    lost,
    value: won.reduce((s, t) => s + (winnerValues(t).find((w) => w.c === c)?.v ?? 0), 0),
    buyers: [...buyersMap.entries()].sort((a, b) => b[1] - a[1]),
    rivals: [...rivals.values()].sort((a, b) => b.met - a.met).slice(0, 8),
  };
}

// Contracts that state a length: estimated end = award date + length.
export function retenders(T, today) {
  const now = new Date(today);
  return T.filter((t) => t.dur && t.ad).map((t) => {
    const end = new Date(t.ad);
    end.setMonth(end.getMonth() + t.dur);
    return { t, end: end.toISOString().slice(0, 10), monthsLeft: Math.round((end - now) / (30.44 * 864e5)) };
  }).sort((a, b) => a.end.localeCompare(b.end));
}

// Where a company's offers sit: share of its priced offers that were the lowest,
// and the median distance of its offers above the lowest offer.
export function pricePosition(T, c) {
  const gaps = [];
  let lowest = 0;
  for (const t of T) {
    const priced = t.bid.filter((b) => b.a > 0);
    const mine = priced.find((b) => b.c === c);
    if (!mine || priced.length < 2) continue;
    const min = Math.min(...priced.map((b) => b.a));
    if (mine.a <= min * 1.0001) lowest++;
    gaps.push(mine.a / min - 1);
  }
  return { n: gaps.length, lowestShare: gaps.length ? lowest / gaps.length : null, medianAbove: median(gaps) };
}

export function winsByMonth(T, c) {
  const map = new Map();
  for (const t of T) {
    if (!t.ad || !t.win.some((w) => w.c === c)) continue;
    const k = t.ad.slice(0, 7);
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()].sort().map(([month, wins]) => ({ month, wins }));
}

export function byCategory(T, labels) {
  const map = new Map();
  for (const t of T) {
    const k = labels?.[t.cat] ?? t.cat ?? "Other";
    const r = map.get(k) ?? { name: k, slug: t.cat, value: 0, tenders: 0 };
    r.value += t.amt ?? 0;
    r.tenders++;
    map.set(k, r);
  }
  return [...map.values()].sort((a, b) => b.value - a.value);
}
