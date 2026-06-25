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
-- ── ASSIGNMENT HISTORY ───────────────────────────────────────
-- Immutable log of every assignment action.
-- Never deleted — unlike the assignments table which is replace-all.

CREATE TABLE IF NOT EXISTS assignment_history (
  id              TEXT          PRIMARY KEY,
  action          TEXT          NOT NULL,       -- 'assigned' | 'unassigned' | 'reassigned'
  sku             TEXT          NOT NULL,
  division        TEXT          NOT NULL,
  from_member_id  TEXT,                         -- who it was taken from (for unassign/reassign)
  to_member_id    TEXT,                         -- who it went to (null for unassign)
  manager_id      TEXT          NOT NULL,       -- who performed the action (or 'master')
  stage           TEXT          NOT NULL DEFAULT '',  -- stage_key or 'all'
  note            TEXT          NOT NULL DEFAULT '',
  logged_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Indexes for fast lookup by common query patterns
CREATE INDEX IF NOT EXISTS idx_ahistory_sku        ON assignment_history (division, sku);
CREATE INDEX IF NOT EXISTS idx_ahistory_to_member  ON assignment_history (to_member_id);
CREATE INDEX IF NOT EXISTS idx_ahistory_from_member ON assignment_history (from_member_id);
CREATE INDEX IF NOT EXISTS idx_ahistory_manager    ON assignment_history (manager_id);
CREATE INDEX IF NOT EXISTS idx_ahistory_logged_at  ON assignment_history (logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_ahistory_action     ON assignment_history (action);
`;

(async () => {
  console.log("Connecting to database...");
  try {
    await pool.query("SELECT 1");
    console.log("✅ Connected. Applying patch...");

    await pool.query(PATCH_SQL);
    console.log("✅ Patch applied successfully:");
    console.log("   - assignment_history table created (if missing)");
    console.log("   - 6 indexes created (if missing)");

    // Verify table exists
    const { rows: tableCheck } = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_name = 'assignment_history'
    `);
    if (tableCheck.length) {
      console.log("✅ Verified: assignment_history table exists");
    } else {
      console.log("⚠️  assignment_history table NOT found — something went wrong");
    }

    // Verify indexes
    const { rows: indexCheck } = await pool.query(`
      SELECT indexname 
      FROM pg_indexes 
      WHERE tablename = 'assignment_history'
      ORDER BY indexname
    `);
    console.log(`✅ Verified: ${indexCheck.length} indexes on assignment_history:`);
    indexCheck.forEach(r => console.log(`   - ${r.indexname}`));

    // Show column structure
    const { rows: colCheck } = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'assignment_history'
      ORDER BY ordinal_position
    `);
    console.log("\n📋 Table structure:");
    colCheck.forEach(c =>
      console.log(`   ${c.column_name.padEnd(18)} ${c.data_type.padEnd(20)} nullable=${c.is_nullable}`)
    );

  } catch (e) {
    console.error("❌ Patch failed:", e.message);
    process.exit(1);
  } finally {
    await pool.end();
    console.log("\nDone. Connection closed.");
  }
})();

