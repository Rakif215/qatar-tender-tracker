import { pool } from "./db.js";

/**
 * Calculates a percentile from a sorted array of numbers.
 */
function getPercentile(sortedArr, percentile) {
  if (sortedArr.length === 0) return 0;
  const index = (sortedArr.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sortedArr[lower] * (1 - weight) + sortedArr[upper] * weight;
}

/**
 * Estimates the bid value range for a given category and optional entity.
 * @param {string} categorySlug 
 * @param {string} [entityName] 
 * @returns {Promise<object>}
 */
export async function estimateBidRange(categorySlug, entityName = null) {
  const values = [categorySlug];
  let entityFilter = "";
  
  if (entityName) {
    values.push(entityName);
    entityFilter = "and e.name = $2";
  }

  // Get category details
  const catRes = await pool.query("select category_id, name from tender_category where slug = $1", [categorySlug]);
  if (catRes.rowCount === 0) {
    throw new Error(`Category '${categorySlug}' not found`);
  }
  const category = catRes.rows[0];

  // Get bid values (both proposalAmount and approvedValue)
  const bidsRes = await pool.query(
    `
      select 
        coalesce(b.bid_value, b.approved_value)::float as val,
        b.is_winner as "isWinner"
      from bid b
      join tender t on t.tender_id = b.tender_id
      left join entity e on e.entity_id = t.entity_id
      join tender_category cat on cat.category_id = t.category_id
      where cat.slug = $1
        and (b.bid_value is not null or b.approved_value is not null)
        and (b.bid_value > 0 or b.approved_value > 0)
        ${entityFilter}
    `,
    values
  );

  const allBids = bidsRes.rows.map(r => r.val).sort((a, b) => a - b);
  const winningBids = bidsRes.rows.filter(r => r.isWinner).map(r => r.val).sort((a, b) => a - b);

  const sampleSize = allBids.length;
  if (sampleSize === 0) {
    return {
      categoryName: category.name,
      sampleSize: 0,
      min: 0,
      p25: 0,
      median: 0,
      p75: 0,
      max: 0,
      avg: 0,
      winningMin: 0,
      winningMedian: 0,
      winningMax: 0,
      winningAvg: 0
    };
  }

  const sum = allBids.reduce((a, b) => a + b, 0);
  const avg = sum / sampleSize;

  const winSampleSize = winningBids.length;
  const winSum = winningBids.reduce((a, b) => a + b, 0);
  const winAvg = winSampleSize > 0 ? winSum / winSampleSize : 0;

  return {
    categoryName: category.name,
    sampleSize,
    min: allBids[0],
    p25: getPercentile(allBids, 0.25),
    median: getPercentile(allBids, 0.50),
    p75: getPercentile(allBids, 0.75),
    max: allBids[allBids.length - 1],
    avg,
    winningMin: winSampleSize > 0 ? winningBids[0] : 0,
    winningMedian: winSampleSize > 0 ? getPercentile(winningBids, 0.5) : 0,
    winningMax: winSampleSize > 0 ? winningBids[winningBids.length - 1] : 0,
    winningAvg: winAvg
  };
}

/**
 * Predicts the most likely bidders for a given category and optional entity.
 * @param {string} categorySlug 
 * @param {string} [entityName] 
 * @returns {Promise<Array>}
 */
export async function predictLikelyBidders(categorySlug, entityName = null) {
  const values = [categorySlug];
  let entityFilter = "";
  
  if (entityName) {
    values.push(entityName);
    entityFilter = "and e.name = $2";
  }

  // Get total tenders count in this category/entity
  const totalTendersRes = await pool.query(
    `
      select count(distinct t.tender_id)::int as cnt
      from tender t
      left join entity e on e.entity_id = t.entity_id
      join tender_category cat on cat.category_id = t.category_id
      where cat.slug = $1
        ${entityFilter}
    `,
    values
  );
  const totalTenders = totalTendersRes.rows[0].cnt || 1;

  // Query bidders in this category
  const biddersRes = await pool.query(
    `
      select
        c.company_id as "companyId",
        c.name as "companyName",
        count(b.bid_id)::int as "categoryBids",
        count(case when b.is_winner then 1 end)::int as "categoryWins",
        max(t.award_date) as "lastBidDate",
        count(distinct t.tender_id)::int as "tendersBidOn"
      from bid b
      join company c on c.company_id = b.company_id
      join tender t on t.tender_id = b.tender_id
      left join entity e on e.entity_id = t.entity_id
      join tender_category cat on cat.category_id = t.category_id
      where cat.slug = $1
        ${entityFilter}
      group by c.company_id, c.name
    `,
    values
  );

  const bidders = biddersRes.rows.map(row => {
    // Score based on participation rate (0-60 points) + winning experience (0-30 points) + recency (0-10 points)
    const participationRate = row.tendersBidOn / totalTenders;
    const participationScore = participationRate * 60;
    
    const winRate = row.categoryWins / (row.categoryBids || 1);
    const winScore = winRate * 30;

    // Recency score (newer = higher score, max 10 points)
    let recencyScore = 10;
    if (row.lastBidDate) {
      const lastBidTime = new Date(row.lastBidDate).getTime();
      const diffDays = (Date.now() - lastBidTime) / (1000 * 60 * 60 * 24);
      recencyScore = Math.max(0, 10 - Math.floor(diffDays / 30)); // lose 1 point per month
    }

    const rawScore = participationScore + winScore + recencyScore;
    const confidence = Math.round(Math.min(95, Math.max(10, rawScore)));

    return {
      companyId: row.companyId,
      companyName: row.companyName,
      categoryBids: row.categoryBids,
      categoryWins: row.categoryWins,
      lastBidDate: row.lastBidDate,
      tendersBidOn: row.tendersBidOn,
      confidence
    };
  });

  // Sort by confidence desc
  return bidders.sort((a, b) => b.confidence - a.confidence).slice(0, 10);
}
