import { pool } from "./db.js";

/**
 * TF-IDF Similarity Engine for Tender Analysis
 * 
 * Given a new tender title/description, finds the most similar historical
 * tenders using TF-IDF cosine similarity, then analyzes who bid on those
 * similar tenders to predict likely competitors and bid ranges.
 */

// ── Text Preprocessing ──────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "and", "for", "from", "with", "that", "this", "into", "have", "been",
  "will", "shall", "their", "which", "each", "more", "some", "about", "than",
  "them", "then", "also", "other", "through", "between", "within", "under",
  "upon", "after", "before", "during", "its", "are", "was", "were", "has",
  "had", "not", "but", "can", "all", "any", "our", "out", "you", "your",
  "may", "should", "would", "could", "per", "such", "one", "two", "three",
  "new", "old", "work", "works", "related", "services", "service", "supply",
  "providing", "provision", "project", "contract", "tender", "required",
  "including", "various", "general", "different", "number", "part", "parts",
  "year", "years", "state", "qatar", "doha",
]);

function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF\s]/g, " ")  // Keep Arabic + Latin chars
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// ── TF-IDF Computation ──────────────────────────────────────────────────────

function computeTFIDF(documents) {
  const N = documents.length;
  
  // Document frequency: how many docs contain each term
  const df = {};
  documents.forEach(doc => {
    const uniqueTerms = new Set(doc.tokens);
    uniqueTerms.forEach(term => {
      df[term] = (df[term] || 0) + 1;
    });
  });

  // IDF for each term
  const idf = {};
  for (const term in df) {
    idf[term] = Math.log((N + 1) / (df[term] + 1)) + 1; // Smoothed IDF
  }

  // TF-IDF vector for each document
  return documents.map(doc => {
    const tf = {};
    doc.tokens.forEach(term => {
      tf[term] = (tf[term] || 0) + 1;
    });
    // Normalize TF by doc length
    const docLen = doc.tokens.length || 1;
    const vector = {};
    for (const term in tf) {
      vector[term] = (tf[term] / docLen) * (idf[term] || 0);
    }
    return { ...doc, vector };
  });
}

function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  const allTerms = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);
  allTerms.forEach(term => {
    const a = vecA[term] || 0;
    const b = vecB[term] || 0;
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  });

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

// ── Percentile helper ───────────────────────────────────────────────────────

function getPercentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  const w = i - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

// ── Main Analysis Function ──────────────────────────────────────────────────

let _cachedCorpus = null;
let _cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getCorpus() {
  const now = Date.now();
  if (_cachedCorpus && (now - _cacheTime) < CACHE_TTL) {
    return _cachedCorpus;
  }

  const res = await pool.query(`
    SELECT 
      t.tender_id,
      t.tender_number,
      t.title,
      t.status,
      t.awarded_value::float AS awarded_value,
      t.award_date,
      t.closing_date,
      t.currency,
      e.name AS entity_name,
      cat.slug AS category_slug,
      cat.name AS category_name
    FROM tender t
    LEFT JOIN entity e ON e.entity_id = t.entity_id
    LEFT JOIN tender_category cat ON cat.category_id = t.category_id
    WHERE t.title IS NOT NULL AND t.title != ''
  `);

  const docs = res.rows.map(row => ({
    tenderId: row.tender_id,
    tenderNumber: row.tender_number,
    title: row.title,
    status: row.status,
    awardedValue: row.awarded_value,
    awardDate: row.award_date,
    closingDate: row.closing_date,
    currency: row.currency,
    entity: row.entity_name,
    categorySlug: row.category_slug,
    categoryName: row.category_name,
    tokens: tokenize(row.title),
  }));

  _cachedCorpus = computeTFIDF(docs);
  _cacheTime = now;
  return _cachedCorpus;
}

/**
 * Analyzes a tender description and returns competitive intelligence.
 * 
 * @param {string} tenderText - The tender title or description to analyze
 * @param {number} topN - Number of similar tenders to consider (default 20)
 * @returns {Promise<object>}
 */
export async function analyzeTender(tenderText, topN = 20) {
  const corpus = await getCorpus();
  
  // Tokenize and create TF-IDF vector for the query
  const queryTokens = tokenize(tenderText);
  if (queryTokens.length === 0) {
    return { error: "Could not extract meaningful terms from the input." };
  }

  // Build query vector using corpus IDF values
  const queryTf = {};
  queryTokens.forEach(t => { queryTf[t] = (queryTf[t] || 0) + 1; });
  const queryLen = queryTokens.length;
  const queryVector = {};
  for (const term in queryTf) {
    // Use average IDF from corpus if term exists, otherwise low weight
    const corpusWithTerm = corpus.filter(d => d.vector[term]);
    const avgIdf = corpusWithTerm.length > 0
      ? corpusWithTerm.reduce((s, d) => s + (d.vector[term] / (queryTf[term] / queryLen)), 0) / corpusWithTerm.length
      : 0.5;
    queryVector[term] = (queryTf[term] / queryLen) * avgIdf;
  }

  // Compute similarity scores
  const scored = corpus.map(doc => ({
    ...doc,
    similarity: cosineSimilarity(queryVector, doc.vector),
  }));

  // Sort by similarity and take top N
  scored.sort((a, b) => b.similarity - a.similarity);
  const topSimilar = scored.filter(s => s.similarity > 0.05).slice(0, topN);

  if (topSimilar.length === 0) {
    return {
      queryTerms: queryTokens,
      similarTenders: [],
      likelyBidders: [],
      bidEstimate: null,
      marketShare: [],
      message: "No similar tenders found in the database.",
    };
  }

  // Get tender IDs of similar tenders
  const tenderIds = topSimilar.map(t => t.tenderId);

  // ── Fetch all bids for similar tenders ──
  const bidsRes = await pool.query(`
    SELECT 
      b.bid_id,
      b.tender_id,
      b.company_id,
      c.name AS company_name,
      b.bid_value::float,
      b.approved_value::float,
      b.is_winner,
      t.tender_number,
      t.title AS tender_title,
      t.awarded_value::float,
      t.award_date,
      e.name AS entity_name
    FROM bid b
    JOIN company c ON c.company_id = b.company_id
    JOIN tender t ON t.tender_id = b.tender_id
    LEFT JOIN entity e ON e.entity_id = t.entity_id
    WHERE b.tender_id = ANY($1)
    ORDER BY t.award_date DESC
  `, [tenderIds]);

  const allBids = bidsRes.rows;

  // ── Predicted Competitors ──
  const companyStats = {};
  allBids.forEach(bid => {
    const key = bid.company_id;
    if (!companyStats[key]) {
      companyStats[key] = {
        companyId: bid.company_id,
        companyName: bid.company_name,
        bidCount: 0,
        wins: 0,
        totalBidValue: 0,
        bidValues: [],
        lastBidDate: null,
        tendersSet: new Set(),
      };
    }
    const cs = companyStats[key];
    cs.bidCount += 1;
    cs.tendersSet.add(bid.tender_id);
    if (bid.is_winner) cs.wins += 1;
    const bidVal = bid.bid_value || bid.approved_value || 0;
    if (bidVal > 0) {
      cs.totalBidValue += bidVal;
      cs.bidValues.push(bidVal);
    }
    if (bid.award_date && (!cs.lastBidDate || new Date(bid.award_date) > new Date(cs.lastBidDate))) {
      cs.lastBidDate = bid.award_date;
    }
  });

  const totalSimilarTenders = topSimilar.length;
  const likelyBidders = Object.values(companyStats)
    .map(cs => {
      const tenderCount = cs.tendersSet.size;
      const participationRate = tenderCount / totalSimilarTenders;
      const winRate = cs.wins / (cs.bidCount || 1);
      
      // Recency score
      let recencyScore = 10;
      if (cs.lastBidDate) {
        const diffDays = (Date.now() - new Date(cs.lastBidDate).getTime()) / (1000 * 60 * 60 * 24);
        recencyScore = Math.max(0, 10 - Math.floor(diffDays / 60));
      }

      const confidence = Math.round(Math.min(95, Math.max(5,
        participationRate * 60 + winRate * 25 + recencyScore
      )));

      return {
        companyId: cs.companyId,
        companyName: cs.companyName,
        appearedIn: tenderCount,
        totalSimilar: totalSimilarTenders,
        bidCount: cs.bidCount,
        wins: cs.wins,
        winRate: Math.round(winRate * 100),
        avgBidValue: cs.bidValues.length > 0 ? cs.totalBidValue / cs.bidValues.length : null,
        lastBidDate: cs.lastBidDate,
        confidence,
        reason: `Bid on ${tenderCount}/${totalSimilarTenders} similar tenders, won ${cs.wins}`,
      };
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 15);

  // ── Bid Price Estimate ──
  const bidValues = allBids
    .map(b => b.bid_value || b.approved_value || 0)
    .filter(v => v > 0)
    .sort((a, b) => a - b);
  
  const winningBidValues = allBids
    .filter(b => b.is_winner)
    .map(b => b.approved_value || b.bid_value || 0)
    .filter(v => v > 0)
    .sort((a, b) => a - b);

  const bidEstimate = bidValues.length > 0 ? {
    sampleSize: bidValues.length,
    min: bidValues[0],
    p25: getPercentile(bidValues, 0.25),
    median: getPercentile(bidValues, 0.5),
    p75: getPercentile(bidValues, 0.75),
    max: bidValues[bidValues.length - 1],
    avg: bidValues.reduce((s, v) => s + v, 0) / bidValues.length,
    winningSampleSize: winningBidValues.length,
    winningMedian: winningBidValues.length > 0 ? getPercentile(winningBidValues, 0.5) : null,
    winningAvg: winningBidValues.length > 0 ? winningBidValues.reduce((s, v) => s + v, 0) / winningBidValues.length : null,
  } : null;

  // ── Market Share (top 5 winners by value) ──
  const winnerValues = {};
  allBids.filter(b => b.is_winner).forEach(b => {
    const val = b.approved_value || b.bid_value || b.awarded_value || 0;
    const name = b.company_name;
    winnerValues[name] = (winnerValues[name] || 0) + val;
  });
  const totalWonValue = Object.values(winnerValues).reduce((s, v) => s + v, 0);
  const marketShare = Object.entries(winnerValues)
    .map(([name, value]) => ({
      name,
      value,
      share: totalWonValue > 0 ? Math.round(value / totalWonValue * 100) : 0,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  // ── Format similar tenders ──
  const similarTendersFormatted = topSimilar.map(t => {
    const tenderBids = allBids.filter(b => b.tender_id === t.tenderId);
    const winner = tenderBids.find(b => b.is_winner);
    return {
      tenderId: t.tenderId,
      tenderNumber: t.tenderNumber,
      title: t.title,
      entity: t.entity,
      category: t.categoryName,
      awardedValue: t.awardedValue,
      awardDate: t.awardDate,
      similarity: Math.round(t.similarity * 100),
      bidderCount: tenderBids.length,
      winnerName: winner?.company_name || null,
      winningBid: winner ? (winner.approved_value || winner.bid_value) : null,
    };
  });

  return {
    queryTerms: queryTokens,
    matchCount: topSimilar.length,
    similarTenders: similarTendersFormatted,
    likelyBidders,
    bidEstimate,
    marketShare,
  };
}
