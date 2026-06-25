require("dotenv").config();
const { Pool } = require("pg");
const fs = require("fs");

const pool = new Pool({
  host:     process.env.DB_HOST,
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port:     process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },
});

async function setup() {
  console.log("Connecting to database...");
  
  try {
    const sql = fs.readFileSync("card_tracker.sql", "utf8");
    
    console.log("Running schema...");
    await pool.query(sql);
    
    console.log("✅ All tables created successfully!");
    
    
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    
    console.log("\nTables in your database:");
    result.rows.forEach(row => {
      console.log("  ✓", row.table_name);
    });

  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    await pool.end();
  }
}

setup();