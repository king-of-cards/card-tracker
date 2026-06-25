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

const PATCH_SQL = `
-- products.set_no was missing
ALTER TABLE products ADD COLUMN IF NOT EXISTS set_no TEXT;

-- case-insensitive lookup index for products by sku within a division
CREATE INDEX IF NOT EXISTS idx_products_sku_lower ON products (division, lower(sku));

-- case-insensitive lookup for users by email (login)
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));
`;

(async () => {
  console.log("Connecting to database...");
  try {
    await pool.query("SELECT 1");
    console.log("✅ Connected. Applying schema patch...");

    await pool.query(PATCH_SQL);
    console.log("✅ Patch applied successfully:");
    console.log("   - products.set_no column added (if missing)");
    console.log("   - idx_products_sku_lower index created (if missing)");
    console.log("   - idx_users_email_lower index created (if missing)");

    // Verify
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'products' AND column_name = 'set_no'
    `);
    console.log(rows.length ? "✅ Verified: set_no column exists on products" : "⚠️ set_no column NOT found — something went wrong");

  } catch (e) {
    console.error("❌ Patch failed:", e.message);
  } finally {
    await pool.end();
  }
})();