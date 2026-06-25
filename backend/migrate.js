/**
 * One-time migration: Google Sheets JSON -> Postgres
 *
 * HOW TO USE:
 * 1. Save your getAll() JSON dump as  ./migration_data/getall.json
 * 2. Save your getUsers() JSON dump (the small admin/master list) as ./migration_data/users.json
 * 3. node migrate.js
 *
 * Safe to re-run: every insert uses ON CONFLICT upserts.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },
});

const STAGE_KEYS = [
  "barcoding", "content", "photography", "videography", "dimensions",
  "videoedit", "images", "backend", "website", "scan", "qc", "finalqc",
];
const STORE_NAMES = [
  "Chamrajpet", "HSR Layout", "Sahakar Nagar", "Hoodi", "Jayanagar",
  "Bommasandra", "Hyderabad", "Mysore", "Vizag", "Hubli", "Chitradurga",
];
const STAGE_NAME_TO_KEY = {
  "Bar Coding": "barcoding", "Content": "content", "Photography": "photography",
  "Videography": "videography", "Dimensions": "dimensions", "Video Editing": "videoedit",
  "Video Uploaded": "images", "Images Uploaded": "images",
  "Backend Listing (App)": "backend", "Website Listing (Shopify)": "website",
  "Scan Before Dispatch": "scan", "QC Check": "qc", "Final QC / Audit": "finalqc",
};

function loadJSON(filename) {
  const p = path.join(__dirname, "migration_data", filename);
  if (!fs.existsSync(p)) {
    console.error(`Missing file: ${p}`);
    return null;
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// The audit array's rows have garbage/positional keys (literal data values used as keys,
// since the sheet round-trips Object.values() on the frontend side). We read by position.
function normalizeAuditRow(raw) {
  const vals = Object.values(raw);
  return {
    id: vals[0] || null,
    at: vals[1] || null,
    actor: vals[2] || "Unattributed",
    action: vals[3] || "",
    entity: vals[4] || "",
    detail: vals[5] || "",
    division: vals[6] || null,
  };
}

async function migrate() {
  const data = loadJSON("getall.json");
  const standaloneUsers = loadJSON("users.json"); // admin/master logins not in teamMembers
  if (!data) {
    console.error("Aborting: getall.json not found. Put it in ./migration_data/getall.json");
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    /* ---------------- 1. VENDORS ---------------- */
    console.log("Migrating vendors...");
    let vendorCount = 0;
    for (const division of Object.keys(data.vendors || {})) {
      for (const vendorName of data.vendors[division]) {
        await client.query(
          `INSERT INTO vendors (division, vendor_name) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [division, vendorName]
        );
        vendorCount++;
      }
    }
    console.log(`  -> ${vendorCount} vendor rows upserted`);

    /* ---------------- 2. USERS (merge teamMembers + standalone admin list) ---------------- */
    console.log("Migrating users...");
    const usersById = new Map();

    (data.teamMembers || []).forEach(m => {
      const id = m.id || m.name.toLowerCase().replace(/\s+/g, "_");
      usersById.set(id, {
        id,
        name: m.name,
        email: m.email,
        password: m.password || "",
        role: m.role || "member",
        stages: m.stages || "",
        division: m.division || null,
        managerId: m.managerId || null,
        joinedAt: m.joinedAt || new Date().toISOString(),
      });
    });

    (standaloneUsers || []).forEach(u => {
      const id = u.name.toLowerCase().replace(/\s+/g, "_");
      // Only add if not already present from teamMembers (avoid clobbering managerId/division)
      if (!usersById.has(id)) {
        usersById.set(id, {
          id,
          name: u.name,
          email: u.email,
          password: u.password || "",
          role: u.role || "member",
          stages: u.stages || "",
          division: null,
          managerId: null,
          joinedAt: new Date().toISOString(),
        });
      }
    });

    // Two-pass insert: manager_id is a self-referencing FK (users.manager_id -> users.id),
    // so we cannot set it on first insert if the referenced manager row doesn't exist yet
    // (insertion order through a Map is not guaranteed to put managers before reports).
    // Pass 1: insert/update every user with manager_id left NULL.
    for (const u of usersById.values()) {
      await client.query(
        `INSERT INTO users (id, name, email, password, role, stages, division, manager_id, joined_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8)
         ON CONFLICT (id) DO UPDATE SET
           name=$2, email=$3, password=$4, role=$5, stages=$6, division=$7`,
        [u.id, u.name, u.email, u.password, u.role, u.stages, u.division, u.joinedAt]
      );
    }
    // Pass 2: now that every user row exists, fill in manager_id where it points to a
    // known user. A managerId of "" / "master" / any id not in usersById is left NULL
    // (e.g. "master" is a literal sentinel used elsewhere, not a real user row).
    let managerLinksSet = 0, managerLinksSkipped = 0;
    for (const u of usersById.values()) {
      if (!u.managerId) continue;
      if (!usersById.has(u.managerId)) { managerLinksSkipped++; continue; }
      await client.query(`UPDATE users SET manager_id = $1 WHERE id = $2`, [u.managerId, u.id]);
      managerLinksSet++;
    }
    console.log(`  -> ${usersById.size} users upserted (${managerLinksSet} manager links set, ${managerLinksSkipped} skipped — unresolved manager id)`);

    /* ---------------- 3. PRODUCTS + STAGES + STORES ---------------- */
    console.log("Migrating products (this includes stage_entries and stores)...");
    let productCount = 0;
    for (const p of data.products || []) {
      await client.query(
        `INSERT INTO products (id, division, sku, name, vendor, inward, qty, note, set_no, verdict, issues, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO UPDATE SET
           division=$2, sku=$3, name=$4, vendor=$5, inward=$6, qty=$7, note=$8, set_no=$9,
           verdict=$10, issues=$11, updated_at=$13`,
        [
          p.id, p.division, p.sku, p.name || "", p.vendor || null,
          p.inward || null, p.qty || 0, p.note || "", p.set_no || null,
          p.verdict || null, p.issues || "",
          p.createdAt || new Date().toISOString(), p.updatedAt || new Date().toISOString(),
        ]
      );

      if (p.stages) {
        for (const key of STAGE_KEYS) {
          const s = p.stages[key];
          if (!s) continue;
          await client.query(
            `INSERT INTO stage_entries (product_id, stage_key, status, person, comments, updated_at, width_cm, height_cm, weight_gm)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (product_id, stage_key) DO UPDATE SET
               status=$3, person=$4, comments=$5, updated_at=$6, width_cm=$7, height_cm=$8, weight_gm=$9`,
            [
              p.id, key, s.status || "Not Started", s.person || null, s.comments || "",
              s.at || null,
              s.width ? Number(s.width) || null : null,
              s.height ? Number(s.height) || null : null,
              s.weight ? Number(s.weight) || null : null,
            ]
          );
        }
      }

      if (p.stores) {
        for (const store of STORE_NAMES) {
          const s = p.stores[store];
          if (!s) continue;
          await client.query(
            `INSERT INTO stores (product_id, store, dispatched, received, received_at, received_by, missing, damaged, notes, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (product_id, store) DO UPDATE SET
               dispatched=$3, received=$4, received_at=$5, received_by=$6, missing=$7, damaged=$8, notes=$9, updated_at=$10`,
            [
              p.id, store, s.dispatched || 0, !!s.received, s.receivedAt || null,
              s.receivedBy || null, s.missing || 0, s.damaged || 0, s.notes || "",
              s.at || null,
            ]
          );
        }
      }
      productCount++;
    }
    console.log(`  -> ${productCount} products migrated (with stages + stores)`);

    /* ---------------- 4. ASSIGNMENTS (resolve sku -> product_id) ---------------- */
    console.log("Migrating assignments...");
    let assignCount = 0, assignSkipped = 0;
    // Build sku+division -> product_id lookup from what we just inserted
    const { rows: prodRows } = await client.query("SELECT id, division, sku FROM products");
    const skuMap = new Map();
    prodRows.forEach(r => skuMap.set(`${r.division}|${r.sku.toLowerCase()}`, r.id));

    for (const a of data.assignments || []) {
      const productId = skuMap.get(`${a.division}|${a.sku.toLowerCase()}`);
      if (!productId) { assignSkipped++; continue; }
      // member_id must exist in users; if it doesn't (e.g. mehul missing email/etc), skip safely
      if (!usersById.has(a.memberId)) { assignSkipped++; continue; }
      await client.query(
        `INSERT INTO assignments (id, member_id, manager_id, product_id, sku, division, stage, assigned_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [a.id, a.memberId, a.managerId, productId, a.sku, a.division, a.stage, a.assignedAt || new Date().toISOString()]
      );
      assignCount++;
    }
    console.log(`  -> ${assignCount} assignments migrated, ${assignSkipped} skipped (missing product/member)`);

    /* ---------------- 5. QC AUDIT ---------------- */
    console.log("Migrating qc_audit...");
    let qcCount = 0, qcSkipped = 0;
    for (const q of data.qcAudit || []) {
      const productId = q.productId || skuMap.get(`${q.division}|${(q.sku || "").toLowerCase()}`);
      if (!productId) { qcSkipped++; continue; }
      await client.query(
        `INSERT INTO qc_audit (id, audited_at, auditor_name, product_id, sku, division, verdict, comments, stages_sent_back)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO NOTHING`,
        [q.id, q.at || new Date().toISOString(), q.auditor || "", productId, q.sku, q.division, q.verdict, q.comments || "", q.stagesSentBack || ""]
      );
      qcCount++;
    }
    console.log(`  -> ${qcCount} qc_audit rows migrated, ${qcSkipped} skipped`);

    /* ---------------- 6. AUDIT LOG (positional-key rows) ---------------- */
    console.log("Migrating audit_log...");
    let auditCount = 0, auditSkipped = 0;
    for (const raw of data.audit || []) {
      const a = normalizeAuditRow(raw);
      if (!a.id) { auditSkipped++; continue; }
      await client.query(
        `INSERT INTO audit_log (id, logged_at, actor_name, action, entity, detail, division)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO NOTHING`,
        [a.id, a.at, a.actor, a.action, a.entity, a.detail, a.division]
      );
      auditCount++;
    }
    console.log(`  -> ${auditCount} audit_log rows migrated, ${auditSkipped} skipped`);

    await client.query("COMMIT");
    console.log("\n✅ Migration complete.");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed, rolled back:", e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();