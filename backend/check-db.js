require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  host:     process.env.DB_HOST,
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port:     process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },
});

async function check() {
  try {
    console.log("Connecting to database...\n");

    // check all tables
    const tables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    if (tables.rows.length === 0) {
      console.log("❌ No tables found — schema not run yet");
    } else {
      console.log(`✅ Found ${tables.rows.length} tables:\n`);
      tables.rows.forEach(row => {
        console.log("  ✓", row.table_name);
      });
    }

    // check row counts
    console.log("\nRow counts:\n");
    const tableNames = ["users", "products", "stage_entries", "stores", "assignments", "audit_log", "qc_audit", "vendors"];
    
    for (const t of tableNames) {
      try {
        const count = await pool.query(`SELECT COUNT(*) FROM ${t}`);
        console.log(`  ${t}: ${count.rows[0].count} rows`);
      } catch (e) {
        console.log(`  ${t}: ❌ table does not exist`);
      }
    }

  } catch (err) {
    console.error("❌ Connection failed:", err.message);
  } finally {
    await pool.end();
  }
}

check();