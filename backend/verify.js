/**
 * Post-migration verification script.
 * Run after migrate.js to sanity-check the data actually landed correctly —
 * not just "some rows exist" but "the right rows, with the right relationships."
 *
 * Usage: node verify.js
 */
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

function section(title) {
  console.log("\n" + "=".repeat(60));
  console.log(title);
  console.log("=".repeat(60));
}

async function verify() {
  try {
    /* ---------------- 1. ROW COUNTS ---------------- */
    section("1. ROW COUNTS — does every table have data?");
    const tables = ["users", "vendors", "products", "stage_entries", "stores", "assignments", "qc_audit", "audit_log"];
    for (const t of tables) {
      const { rows } = await pool.query(`SELECT COUNT(*) FROM ${t}`);
      console.log(`  ${t.padEnd(16)} ${rows[0].count}`);
    }

    /* ---------------- 2. EXPECTED EXACT COUNTS ---------------- */
    section("2. SANITY CHECK — every product should have exactly 12 stage_entries and 11 stores");
    const { rows: stageCheck } = await pool.query(`
      SELECT p.sku, COUNT(se.stage_key) AS stage_count
      FROM products p LEFT JOIN stage_entries se ON se.product_id = p.id
      GROUP BY p.id, p.sku
      HAVING COUNT(se.stage_key) != 12
      LIMIT 10
    `);
    console.log(stageCheck.length === 0
      ? "  ✅ All products have exactly 12 stage_entries."
      : `  ⚠️  ${stageCheck.length} products have the WRONG stage count (showing up to 10):`);
    stageCheck.forEach(r => console.log(`     ${r.sku}: ${r.stage_count} stages`));

    const { rows: storeCheck } = await pool.query(`
      SELECT p.sku, COUNT(s.store) AS store_count
      FROM products p LEFT JOIN stores s ON s.product_id = p.id
      GROUP BY p.id, p.sku
      HAVING COUNT(s.store) != 11
      LIMIT 10
    `);
    console.log(storeCheck.length === 0
      ? "  ✅ All products have exactly 11 store rows."
      : `  ⚠️  ${storeCheck.length} products have the WRONG store count (showing up to 10):`);
    storeCheck.forEach(r => console.log(`     ${r.sku}: ${r.store_count} stores`));

    /* ---------------- 3. ORPHAN CHECK ---------------- */
    section("3. ORPHAN CHECK — any assignments/qc_audit pointing to non-existent products or users?");
    const { rows: orphanAssign } = await pool.query(`
      SELECT a.id, a.sku, a.member_id FROM assignments a
      LEFT JOIN products p ON p.id = a.product_id
      LEFT JOIN users u ON u.id = a.member_id
      WHERE p.id IS NULL OR u.id IS NULL
      LIMIT 10
    `);
    console.log(orphanAssign.length === 0
      ? "  ✅ No orphaned assignments."
      : `  ⚠️  ${orphanAssign.length} orphaned assignments found:`);
    orphanAssign.forEach(r => console.log(`     id=${r.id} sku=${r.sku} member_id=${r.member_id}`));

    /* ---------------- 4. MANAGER CHAIN CHECK ---------------- */
    section("4. MANAGER CHAIN — does every user's manager_id resolve correctly?");
    const { rows: managerRows } = await pool.query(`
      SELECT u.id AS user_id, u.name, u.manager_id, m.name AS manager_name
      FROM users u LEFT JOIN users m ON m.id = u.manager_id
      WHERE u.manager_id IS NOT NULL
      ORDER BY u.name
    `);
    if (managerRows.length === 0) {
      console.log("  ⚠️  No manager relationships found at all — check if this is expected.");
    } else {
      managerRows.forEach(r => {
        const ok = r.manager_name ? "✅" : "❌ BROKEN LINK";
        console.log(`  ${ok}  ${r.name} -> reports to -> ${r.manager_name || "(missing: " + r.manager_id + ")"}`);
      });
    }

    /* ---------------- 5. ASSIGNMENT MANAGER_ID DISTRIBUTION ---------------- */
    section("5. ASSIGNMENT MANAGER_ID — who is pushing work to whom (includes 'master' sentinel)");
    const { rows: assignMgrDist } = await pool.query(`
      SELECT manager_id, COUNT(*) AS cnt FROM assignments GROUP BY manager_id ORDER BY cnt DESC
    `);
    assignMgrDist.forEach(r => console.log(`  manager_id="${r.manager_id}"  ->  ${r.cnt} assignment rows`));

    /* ---------------- 6. SAMPLE PRODUCT — full nested view ---------------- */
    section("6. SAMPLE PRODUCT — spot-check one product's full data");
    const { rows: sampleProd } = await pool.query(`SELECT * FROM products LIMIT 1`);
    if (sampleProd.length) {
      const p = sampleProd[0];
      console.log(`  Product: ${p.sku} (${p.name || "no name"}) — division: ${p.division}, vendor: ${p.vendor}`);
      const { rows: stages } = await pool.query(
        `SELECT stage_key, status, person FROM stage_entries WHERE product_id = $1 ORDER BY stage_key`,
        [p.id]
      );
      console.log("  Stages:");
      stages.forEach(s => console.log(`     ${s.stage_key.padEnd(14)} ${s.status.padEnd(14)} ${s.person || "—"}`));
    } else {
      console.log("  ⚠️  No products found at all.");
    }

    /* ---------------- 7. USERS LIST ---------------- */
    section("7. ALL USERS — confirm logins exist as expected");
    const { rows: allUsers } = await pool.query(
      `SELECT id, name, email, role, stages, division, manager_id FROM users ORDER BY role, name`
    );
    allUsers.forEach(u => {
      console.log(`  [${u.role.padEnd(7)}] ${u.name.padEnd(14)} ${u.email.padEnd(28)} stages="${u.stages}" mgr=${u.manager_id || "—"}`);
    });

    /* ---------------- 8. VENDORS PER DIVISION ---------------- */
    section("8. VENDORS PER DIVISION");
    const { rows: vendorRows } = await pool.query(
      `SELECT division, COUNT(*) AS cnt FROM vendors GROUP BY division`
    );
    vendorRows.forEach(r => console.log(`  ${r.division}: ${r.cnt} vendors`));

    /* ---------------- 9. QC AUDIT SAMPLE ---------------- */
    section("9. QC AUDIT SAMPLE — last 5 verdicts");
    const { rows: qcSample } = await pool.query(
      `SELECT sku, verdict, auditor_name, audited_at FROM qc_audit ORDER BY audited_at DESC LIMIT 5`
    );
    qcSample.forEach(r => console.log(`  ${r.sku.padEnd(14)} ${r.verdict.padEnd(14)} by ${r.auditor_name} at ${r.audited_at.toISOString()}`));

    /* ---------------- 10. AUDIT LOG DATE RANGE ---------------- */
    section("10. AUDIT LOG — date range (sanity check the positional-key parsing worked)");
    const { rows: auditRange } = await pool.query(
      `SELECT MIN(logged_at) AS earliest, MAX(logged_at) AS latest, COUNT(*) AS total FROM audit_log`
    );
    const ar = auditRange[0];
    console.log(`  ${ar.total} rows, earliest=${ar.earliest ? ar.earliest.toISOString() : "—"}, latest=${ar.latest ? ar.latest.toISOString() : "—"}`);
    const { rows: auditActions } = await pool.query(
      `SELECT action, COUNT(*) AS cnt FROM audit_log GROUP BY action ORDER BY cnt DESC`
    );
    console.log("  Action breakdown:");
    auditActions.forEach(r => console.log(`     ${r.action.padEnd(20)} ${r.cnt}`));

    console.log("\n✅ Verification complete. Review any ⚠️ or ❌ lines above.");
  } catch (e) {
    console.error("❌ Verification script error:", e);
  } finally {
    await pool.end();
  }
}

verify();