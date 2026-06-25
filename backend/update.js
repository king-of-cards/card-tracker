require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  console.log("\nConnecting to database...");
  const client = await pool.connect();

  try {
    // ── STEP 1: See what vendors are currently stored ─────────────────────
    console.log("\n── Step 1: Current vendor distribution for KOC Cards ──────────────");
    const { rows: vendorDist } = await client.query(`
      SELECT 
        COALESCE(vendor, '(NULL)') as vendor, 
        COUNT(*) as count
      FROM products 
      WHERE division = 'KOC Cards'
      GROUP BY vendor
      ORDER BY count DESC
    `);
    if (vendorDist.length === 0) {
      console.log("  No KOC Cards products found.");
    } else {
      vendorDist.forEach(r => console.log(`  "${r.vendor}" → ${r.count} products`));
    }

    // ── STEP 2: Count how many need fixing ───────────────────────────────
    const { rows: needFix } = await client.query(`
      SELECT COUNT(*) as count
      FROM products
      WHERE division = 'KOC Cards'
      AND (vendor IS NULL OR TRIM(vendor) = '')
    `);
    const fixCount = parseInt(needFix[0].count);
    console.log(`\n── Step 2: Products needing vendor fix: ${fixCount} ─────────────────────`);

    if (fixCount === 0) {
      console.log("  ✅ Nothing to fix — all KOC Cards products already have a vendor.");
    } else {
      console.log(`  → Will set vendor = 'King of cards' for ${fixCount} products`);

      // ── STEP 3: Apply the fix ──────────────────────────────────────────
      await client.query("BEGIN");
      const { rowCount } = await client.query(`
        UPDATE products
        SET vendor = 'King of cards'
        WHERE division = 'KOC Cards'
        AND (vendor IS NULL OR TRIM(vendor) = '')
      `);
      await client.query("COMMIT");
      console.log(`\n── Step 3: Fix applied ──────────────────────────────────────────────`);
      console.log(`  ✅ Updated ${rowCount} products → vendor = 'King of cards'`);
    }

    // ── STEP 4: Ensure 'King of cards' exists in vendors table ───────────
    console.log("\n── Step 4: Ensuring vendor exists in vendors table ─────────────────");
    const { rowCount: vInserted } = await client.query(`
      INSERT INTO vendors (division, vendor_name)
      VALUES ('KOC Cards', 'King of cards')
      ON CONFLICT DO NOTHING
    `);
    if (vInserted > 0) {
      console.log("  ✅ Added 'King of cards' to vendors table");
    } else {
      console.log("  ✅ 'King of cards' already exists in vendors table");
    }

    // ── STEP 5: Final verification ────────────────────────────────────────
    console.log("\n── Step 5: Final vendor distribution for KOC Cards ─────────────────");
    const { rows: finalDist } = await client.query(`
      SELECT 
        COALESCE(vendor, '(NULL)') as vendor, 
        COUNT(*) as count
      FROM products 
      WHERE division = 'KOC Cards'
      GROUP BY vendor
      ORDER BY count DESC
    `);
    finalDist.forEach(r => console.log(`  "${r.vendor}" → ${r.count} products`));

    // ── STEP 6: Show vendors table ────────────────────────────────────────
    console.log("\n── Step 6: All vendors in vendors table for KOC Cards ──────────────");
    const { rows: vendorTable } = await client.query(`
      SELECT vendor_name FROM vendors 
      WHERE division = 'KOC Cards'
      ORDER BY vendor_name
    `);
    if (vendorTable.length === 0) {
      console.log("  ⚠️  No vendors in vendors table for KOC Cards");
    } else {
      vendorTable.forEach(r => console.log(`  - ${r.vendor_name}`));
    }

    console.log("\n✅ Done.\n");

  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("❌ Error:", e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();