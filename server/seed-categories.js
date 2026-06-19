import { pool, withClient } from "./db.js";
import { CATEGORIES, FALLBACK_CATEGORY, categorize } from "./categorize.js";

async function main() {
  console.log("🌱 Starting tender category seeding and initial classification...");

  // Combine categories to seed
  const categoriesToSeed = [
    ...CATEGORIES,
    FALLBACK_CATEGORY
  ];

  await withClient(async (client) => {
    await client.query("BEGIN");

    try {
      // 1. Seed categories
      console.log(`Seeding ${categoriesToSeed.length} categories...`);
      const slugToIdMap = new Map();

      for (let i = 0; i < categoriesToSeed.length; i++) {
        const cat = categoriesToSeed[i];
        const keywords = cat.keywords ? cat.keywords.map(k => k.term) : [];
        
        const res = await client.query(
          `
            INSERT INTO tender_category (slug, name, keywords, color, icon, sort_order)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (slug) DO UPDATE 
            SET name = EXCLUDED.name,
                keywords = EXCLUDED.keywords,
                color = EXCLUDED.color,
                icon = EXCLUDED.icon,
                sort_order = EXCLUDED.sort_order
            RETURNING category_id, slug
          `,
          [cat.slug, cat.name, keywords, cat.color, cat.icon, i]
        );
        
        const row = res.rows[0];
        slugToIdMap.set(row.slug, row.category_id);
      }
      
      console.log("✅ Categories successfully seeded.");

      // 2. Fetch all tenders
      console.log("Fetching all tenders to classify...");
      const tendersRes = await client.query(
        "SELECT tender_id, title FROM tender"
      );
      
      const tenders = tendersRes.rows;
      console.log(`Found ${tenders.length} tenders to process.`);

      const stats = {};
      categoriesToSeed.forEach(c => stats[c.slug] = 0);

      // 3. Classify and update each tender
      let updatedCount = 0;
      for (const tender of tenders) {
        const { categorySlug } = categorize(tender.title);
        const categoryId = slugToIdMap.get(categorySlug);
        
        if (categoryId) {
          await client.query(
            "UPDATE tender SET category_id = $1 WHERE tender_id = $2",
            [categoryId, tender.tender_id]
          );
          stats[categorySlug] = (stats[categorySlug] || 0) + 1;
          updatedCount++;
        }
      }

      await client.query("COMMIT");
      
      console.log("\n📊 Categorization Statistics Summary:");
      console.log("-----------------------------------------");
      categoriesToSeed.forEach(cat => {
        const count = stats[cat.slug] || 0;
        const pct = tenders.length > 0 ? ((count / tenders.length) * 100).toFixed(1) : "0.0";
        console.log(`• ${cat.name} (${cat.slug}): ${count} tenders (${pct}%)`);
      });
      console.log("-----------------------------------------");
      console.log(`✅ Successfully categorized ${updatedCount}/${tenders.length} tenders.`);

    } catch (err) {
      await client.query("ROLLBACK");
      console.error("❌ Error during category seeding:", err);
      process.exit(1);
    }
  });

  await pool.end();
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
