require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "25mb" })); // bulk product imports can be large

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Idle client error — pool will recover:', err.message);
});

const STAGE_KEYS = [
  "barcoding", "content", "photography", "photoedit", "videography", "dimensions",
  "videoedit", "images", "backend", "website", "scan", "qc", "finalqc",
];
const STORES = [
  "Chamrajpet", "HSR Layout", "Sahakar Nagar", "Hoodi", "Jayanagar",
  "Bommasandra", "Hyderabad", "Mysore", "Vizag", "Hubli", "Chitradurga",
];
const PIPELINE_STAGE_COUNT = STAGE_KEYS.filter(k => k !== "finalqc").length; // 11

app.get("/", (req, res) => res.json({ message: "Card Tracker API is running!" }));

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "connected to AWS RDS successfully!" });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   Helpers — convert a DB row shape into the nested JSON shape the
   React app already expects (same shape ensureStages() builds).
---------------------------------------------------------------- */
async function loadFullProduct(client, productId) {
  const { rows: prows } = await client.query("SELECT * FROM products WHERE id = $1", [productId]);
  if (!prows.length) return null;
  return hydrateProducts(client, prows).then(arr => arr[0]);
}

async function hydrateProducts(client, productRows) {
  if (productRows.length === 0) return [];
  const ids = productRows.map(p => p.id);

  const { rows: stageRows } = await client.query(
    `SELECT * FROM stage_entries WHERE product_id = ANY($1::text[])`, [ids]
  );
  const { rows: storeRows } = await client.query(
    `SELECT * FROM stores WHERE product_id = ANY($1::text[])`, [ids]
  );

  const stagesByProduct = {};
  stageRows.forEach(r => {
    (stagesByProduct[r.product_id] ||= {})[r.stage_key] = {
      status: r.status,
      person: r.person || "",
      comments: r.comments || "",
      skipped: !!r.skipped,
      at: r.updated_at ? r.updated_at.toISOString() : "",
      ...(r.stage_key === "dimensions" ? {
        width: r.width_cm != null ? String(r.width_cm) : "",
        height: r.height_cm != null ? String(r.height_cm) : "",
        weight: r.weight_gm != null ? String(r.weight_gm) : "",
      } : {}),
    };
  });

  const storesByProduct = {};
  storeRows.forEach(r => {
    (storesByProduct[r.product_id] ||= {})[r.store] = {
      dispatched: r.dispatched,
      received: r.received,
      receivedAt: r.received_at ? r.received_at.toISOString() : "",
      receivedBy: r.received_by || "",
      missing: r.missing,
      damaged: r.damaged,
      notes: r.notes || "",
      at: r.updated_at ? r.updated_at.toISOString() : "",
    };
  });

 return productRows.map(p => {
    const stages = {};
    STAGE_KEYS.forEach(k => {
      stages[k] = (stagesByProduct[p.id] && stagesByProduct[p.id][k]) || { status: "Not Started", person: "", comments: "", at: "" };
      if (k === "dimensions" && !stages[k].width) { stages[k].width = stages[k].width || ""; stages[k].height = stages[k].height || ""; stages[k].weight = stages[k].weight || ""; }
    });
    const stores = {};
    STORES.forEach(st => {
      stores[st] = (storesByProduct[p.id] && storesByProduct[p.id][st]) || { dispatched: 0, received: false, receivedAt: "", receivedBy: "", missing: 0, damaged: 0, notes: "", at: "" };
    });
    return {
      id: p.id,
      division: p.division,
      sku: p.sku,
      name: p.name || "",
      vendor: p.vendor || "",
      inward: p.inward ? p.inward.toISOString().slice(0, 10) : "",
      qty: p.qty || 0,
      note: p.note || "",
      set_no: p.set_no || "",
      verdict: p.verdict || "",
      issues: p.issues || "",
      stages,
      stores,
      createdAt: p.created_at ? p.created_at.toISOString() : "",
      updatedAt: p.updated_at ? p.updated_at.toISOString() : "",
    };
  });
}

/* ----------------------------------------------------------------
   GET /api/getAll  — equivalent of gsGet() / action=getAll
---------------------------------------------------------------- */
app.get("/api/getAll", async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows: productRows } = await client.query("SELECT * FROM products ORDER BY created_at DESC");
    const products = await hydrateProducts(client, productRows);

    const { rows: vendorRows } = await client.query("SELECT division, vendor_name FROM vendors ORDER BY vendor_name");
    const vendors = {};
    vendorRows.forEach(v => { (vendors[v.division] ||= []).push(v.vendor_name); });

    const { rows: teamRows } = await client.query("SELECT * FROM users WHERE role = 'member'");
    const teamMembers = teamRows.map(u => ({
      id: u.id, name: u.name, email: u.email, password: u.password,
      role: u.role, stages: u.stages, division: u.division,
      managerId: u.manager_id, joinedAt: u.joined_at ? u.joined_at.toISOString() : "",
    }));

    const { rows: assignRows } = await client.query("SELECT * FROM assignments ORDER BY assigned_at DESC");
    const assignments = assignRows.map(a => ({
      id: a.id, memberId: a.member_id, managerId: a.manager_id,
      sku: a.sku, stage: a.stage, division: a.division,
      assignedAt: a.assigned_at ? a.assigned_at.toISOString() : "",
    }));

    const { rows: qcRows } = await client.query("SELECT * FROM qc_audit ORDER BY audited_at DESC");
    const qcAudit = qcRows.map(q => ({
      id: q.id, at: q.audited_at ? q.audited_at.toISOString() : "",
      auditor: q.auditor_name, sku: q.sku, division: q.division,
      productId: q.product_id, verdict: q.verdict, comments: q.comments,
      stagesSentBack: q.stages_sent_back,
    }));

    const { rows: auditRows } = await client.query("SELECT * FROM audit_log ORDER BY logged_at DESC LIMIT 800");
    const audit = auditRows.map(a => ({
      id: a.id, at: a.logged_at ? a.logged_at.toISOString() : "",
      actor: a.actor_name, action: a.action, entity: a.entity,
      detail: a.detail, division: a.division,
    }));

    // NEW — assignment history
    const { rows: historyRows } = await client.query(
      `SELECT ah.*, 
        u1.name as to_member_name,
        u2.name as from_member_name
       FROM assignment_history ah
       LEFT JOIN users u1 ON u1.id = ah.to_member_id
       LEFT JOIN users u2 ON u2.id = ah.from_member_id
       ORDER BY ah.logged_at DESC LIMIT 500`
    );
    const assignmentHistory = historyRows.map(r => ({
      id: r.id, action: r.action, sku: r.sku, division: r.division,
      toMemberId: r.to_member_id, toMemberName: r.to_member_name,
      fromMemberId: r.from_member_id, fromMemberName: r.from_member_name,
      managerId: r.manager_id, stage: r.stage,
      note: r.note, at: r.logged_at
    }));

    res.json({ products, vendors, teamMembers, assignments, qcAudit, audit, assignmentHistory });
  } catch (e) {
    console.error("getAll error", e);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

/* ----------------------------------------------------------------
   GET /api/getUsers — equivalent of gsGetUsers()
---------------------------------------------------------------- */
app.get("/api/getUsers", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM users");
    res.json(rows.map(u => ({
      id: u.id, name: u.name, email: u.email, password: u.password,
      role: u.role, stages: u.stages, division: u.division,
      managerId: u.manager_id, joinedAt: u.joined_at ? u.joined_at.toISOString() : "",
    })));
  } catch (e) {
    console.error("getUsers error", e);
    res.status(500).json([]);
  }
});

/* ----------------------------------------------------------------
   POST /api/batchUpsertProducts
   body: array of full product objects (same shape as blankProduct())
---------------------------------------------------------------- */
app.post("/api/batchUpsertProducts", async (req, res) => {
  const products = req.body;
  if (!Array.isArray(products)) return res.status(400).json({ ok: false, error: "expected array" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const p of products) {
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
        for (const key of Object.keys(p.stages)) {
          const s = p.stages[key];
          await client.query(
            `INSERT INTO stage_entries (product_id, stage_key, status, person, comments, updated_at, width_cm, height_cm, weight_gm)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (product_id, stage_key) DO UPDATE SET
               status=$3, person=$4, comments=$5, updated_at=$6, width_cm=$7, height_cm=$8, weight_gm=$9`,
            [
              p.id, key, s.status || "Not Started", s.person || null, s.comments || "",
              s.at || new Date().toISOString(),
              s.width ? Number(s.width) || null : null,
              s.height ? Number(s.height) || null : null,
              s.weight ? Number(s.weight) || null : null,
            ]
          );
        }
      }
      if (p.stores) {
        for (const store of Object.keys(p.stores)) {
          const s = p.stores[store];
          await client.query(
            `INSERT INTO stores (product_id, store, dispatched, received, received_at, received_by, missing, damaged, notes, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (product_id, store) DO UPDATE SET
               dispatched=$3, received=$4, received_at=$5, received_by=$6, missing=$7, damaged=$8, notes=$9, updated_at=$10`,
            [
              p.id, store, s.dispatched || 0, !!s.received, s.receivedAt || null,
              s.receivedBy || null, s.missing || 0, s.damaged || 0, s.notes || "",
              s.at || new Date().toISOString(),
            ]
          );
        }
      }
    }
    await client.query("COMMIT");
    res.json({ ok: true, count: products.length });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("batchUpsertProducts error", e);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

/* ----------------------------------------------------------------
   POST /api/batchPatchStage
   body: { ids: [productId...], stageKey, patch: {status, person, comments} }
---------------------------------------------------------------- */
app.post("/api/batchPatchStage", async (req, res) => {
  const { ids, stageKey, patch } = req.body;
  if (!Array.isArray(ids) || !stageKey || !patch) return res.status(400).json({ ok: false, error: "bad payload" });
  const client = await pool.connect();
  try {
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("BEGIN");

    const CHUNK = 20;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      for (const id of chunk) {
        await client.query(
          `INSERT INTO stage_entries (product_id, stage_key, status, person, comments, skipped, updated_at)
           VALUES ($1,$2,COALESCE($3::stage_status,'Not Started'::stage_status),$4,$5,COALESCE($6,false), now())
           ON CONFLICT (product_id, stage_key) DO UPDATE SET
             status = COALESCE($3::stage_status, stage_entries.status),
             person = COALESCE($4, stage_entries.person),
             comments = COALESCE($5, stage_entries.comments),
             skipped = COALESCE($6, stage_entries.skipped),
             updated_at = now()`,
          [id, stageKey, patch.status || null, patch.person ?? null, patch.comments ?? "", patch.skipped ?? null]
        );
        await client.query("UPDATE products SET updated_at = now() WHERE id = $1", [id]);
      }
    }

    await client.query("COMMIT");
    res.json({ ok: true, count: ids.length });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("batchPatchStage error", e.message);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

/* ----------------------------------------------------------------
   POST /api/patchQCVerdict   body: { id, verdict, issues }
---------------------------------------------------------------- */
app.post("/api/patchQCVerdict", async (req, res) => {
  const { id, verdict, issues } = req.body;
  try {
    await pool.query(
      "UPDATE products SET verdict = $2, issues = $3, updated_at = now() WHERE id = $1",
      [id, verdict || null, issues || ""]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("patchQCVerdict error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   POST /api/appendQCAudit   body: full qc audit entry
---------------------------------------------------------------- */
app.post("/api/appendQCAudit", async (req, res) => {
  const e = req.body;
  try {
    await pool.query(
      `INSERT INTO qc_audit (id, audited_at, auditor_name, product_id, sku, division, verdict, comments, stages_sent_back)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [e.id, e.at || new Date().toISOString(), e.auditor || "", e.productId, e.sku, e.division, e.verdict, e.comments || "", e.stagesSentBack || ""]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("appendQCAudit error", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ----------------------------------------------------------------
   POST /api/upsertStore   body: { productId, store, division, sku, storeData }
---------------------------------------------------------------- */
app.post("/api/upsertStore", async (req, res) => {
  const { productId, store, storeData } = req.body;
  try {
    await pool.query(
      `INSERT INTO stores (product_id, store, dispatched, received, received_at, received_by, missing, damaged, notes, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (product_id, store) DO UPDATE SET
         dispatched=$3, received=$4, received_at=$5, received_by=$6, missing=$7, damaged=$8, notes=$9, updated_at=now()`,
      [
        productId, store, storeData.dispatched || 0, !!storeData.received,
        storeData.receivedAt || null, storeData.receivedBy || null,
        storeData.missing || 0, storeData.damaged || 0, storeData.notes || "",
      ]
    );
    await pool.query("UPDATE products SET updated_at = now() WHERE id = $1", [productId]);
    res.json({ ok: true });
  } catch (e) {
    console.error("upsertStore error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// POST /api/appendAssignmentHistory
app.post("/api/appendAssignmentHistory", async (req, res) => {
  const e = req.body;
  try {
    await pool.query(
      `INSERT INTO assignment_history 
       (id, action, sku, division, from_member_id, to_member_id, manager_id, stage, note, logged_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [e.id, e.action, e.sku, e.division, e.fromMemberId || null,
       e.toMemberId, e.managerId, e.stage || "", e.note || "", e.at || new Date().toISOString()]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("appendAssignmentHistory error", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/assignmentHistory?division=KOC Cards
app.get("/api/assignmentHistory", async (req, res) => {
  try {
    const { division } = req.query;
    const { rows } = await pool.query(
      `SELECT ah.*, 
        u1.name as to_member_name,
        u2.name as from_member_name,
        u3.name as manager_name
       FROM assignment_history ah
       LEFT JOIN users u1 ON u1.id = ah.to_member_id
       LEFT JOIN users u2 ON u2.id = ah.from_member_id  
       LEFT JOIN users u3 ON u3.id = ah.manager_id
       WHERE ($1::text IS NULL OR ah.division = $1)
       ORDER BY ah.logged_at DESC
       LIMIT 1000`,
      [division || null]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});



/* ----------------------------------------------------------------
   POST /api/deleteProduct   body: { id }
---------------------------------------------------------------- */
app.post("/api/deleteProduct", async (req, res) => {
  const { id } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM stage_entries WHERE product_id = $1", [id]);
    await client.query("DELETE FROM stores WHERE product_id = $1", [id]);
    await client.query("DELETE FROM assignments WHERE product_id = $1", [id]);
    await client.query("DELETE FROM qc_audit WHERE product_id = $1", [id]);
    await client.query("DELETE FROM products WHERE id = $1", [id]);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("deleteProduct error", e);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});


app.get("/api/checkStage", async (req, res) => {
  const { productId, stageKey } = req.query;
  try {
    const { rows } = await pool.query(
      "SELECT status, updated_at FROM stage_entries WHERE product_id = $1 AND stage_key = $2",
      [productId, stageKey]
    );
    res.json({ ok: true, row: rows[0] || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   POST /api/setVendors   body: { "KOC Cards": [...], "Bombay Cards": [...] }
---------------------------------------------------------------- */
app.post("/api/setVendors", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const division of Object.keys(req.body)) {
      for (const vendorName of req.body[division]) {
        await client.query(
          `INSERT INTO vendors (division, vendor_name) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [division, vendorName]
        );
      }
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("setVendors error", e);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

/* ----------------------------------------------------------------
   POST /api/setTeamMembers   body: array of member objects
---------------------------------------------------------------- */
app.post("/api/setTeamMembers", async (req, res) => {
  const members = req.body;
  if (!Array.isArray(members)) return res.status(400).json({ ok: false, error: "expected array" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const m of members) {
      await client.query(
        `INSERT INTO users (id, name, email, password, role, stages, division, manager_id, joined_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
           name=$2, email=$3, password=$4, role=$5, stages=$6, division=$7, manager_id=$8`,
        [m.id, m.name, m.email, m.password || "", m.role || "member", m.stages || "", m.division || null, m.managerId || null, m.joinedAt || new Date().toISOString()]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("setTeamMembers error", e);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

/* ----------------------------------------------------------------
   POST /api/saveUsers   body: array of {email, password, name, role, stages}
   Full replace-by-email semantics, matching the sheet behavior.
---------------------------------------------------------------- */
app.post("/api/saveUsers", async (req, res) => {
  const users = req.body;
  if (!Array.isArray(users)) return res.status(400).json({ ok: false, error: "expected array" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: existing } = await client.query("SELECT id, email FROM users");
    const incomingEmails = new Set(users.map(u => u.email.toLowerCase()));
    // remove users no longer present
    for (const row of existing) {
      if (!incomingEmails.has(row.email.toLowerCase())) {
        await client.query("DELETE FROM users WHERE id = $1", [row.id]);
      }
    }
    for (const u of users) {
      const id = (u.name || u.email).toLowerCase().replace(/\s+/g, "_");
      await client.query(
        `INSERT INTO users (id, name, email, password, role, stages)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET
           name=$2, email=$3, password=$4, role=$5, stages=$6
         `,
        [id, u.name || u.email, u.email, u.password || "", u.role || "member", u.stages || ""]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("saveUsers error", e);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

/* ----------------------------------------------------------------
   POST /api/setAssignments   body: array of assignment objects (full replace)
---------------------------------------------------------------- */
// app.post("/api/setAssignments", async (req, res) => {
//   const assignments = req.body;
//   if (!Array.isArray(assignments)) return res.status(400).json({ ok: false, error: "expected array" });
//   const client = await pool.connect();
//   try {
//     await client.query("BEGIN");
//     await client.query("DELETE FROM assignments");
//     for (const a of assignments) {
//       // resolve product_id from sku+division since the frontend only sends sku
//       const { rows } = await client.query(
//         "SELECT id FROM products WHERE division = $1 AND lower(sku) = lower($2)",
//         [a.division, a.sku]
//       );
//       if (!rows.length) continue; // skip orphaned assignment rows
//       await client.query(
//         `INSERT INTO assignments (id, member_id, manager_id, product_id, sku, division, stage, assigned_at)
//          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
//         [a.id, a.memberId, a.managerId, rows[0].id, a.sku, a.division, a.stage, a.assignedAt || new Date().toISOString()]
//       );
//     }
//     await client.query("COMMIT");
//     res.json({ ok: true });
//   } catch (e) {
//     await client.query("ROLLBACK");
//     console.error("setAssignments error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   } finally {
//     client.release();
//   }
// });


app.post("/api/setAssignments", async (req, res) => {
  const assignments = req.body;
  if (!Array.isArray(assignments)) {
    return res.status(400).json({ ok: false, error: "expected array" });
  }

  const divisionsInPayload = [...new Set(assignments.map(a => a.division))];

  const client = await pool.connect();
  try {
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("BEGIN");

    // ---- Per-division safety guards (fixes: a small Bombay Cards batch no longer
    // gets compared against KOC Cards' much larger row count) ----
    for (const div of divisionsInPayload) {
      const { rows: cr } = await client.query(
        "SELECT COUNT(*) FROM assignments WHERE division = $1", [div]
      );
      const currentCount = Number(cr[0].count);
      const incomingCountForDiv = assignments.filter(a => a.division === div).length;

      if (incomingCountForDiv === 0 && currentCount > 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          error: `Refusing to clear ${currentCount} existing assignments for "${div}" via empty payload.`
        });
      }
      const SHRINK_THRESHOLD = 0.5;
      if (currentCount > 20 && incomingCountForDiv < currentCount * SHRINK_THRESHOLD) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          error: `Payload has ${incomingCountForDiv} rows for "${div}" but ${currentCount} currently exist — looks like a stale/partial payload.`,
          division: div, currentCount, incomingCount: incomingCountForDiv
        });
      }
    }

    // ---- Resolve product ids (unchanged) ----
    let prodMap = {};
    if (assignments.length > 0) {
      const skus = assignments.map(a => a.sku);
      const divisions = assignments.map(a => a.division);
      const { rows: prodRows } = await client.query(
        `SELECT id, division, lower(sku) as sku_lower
         FROM products
         WHERE (division, lower(sku)) IN (
           SELECT * FROM unnest($1::division_name[], $2::text[])
         )`,
        [divisions, skus.map(s => s.toLowerCase())]
      );
      prodRows.forEach(r => { prodMap[r.division + "||" + r.sku_lower] = r.id; });
    }

    const ids = [], memberIds = [], managerIds = [], productIds = [], outSkus = [], outDivisions = [], stages = [], assignedAts = [];
    const validIdsByDivision = {};
    assignments.forEach(a => {
      const pid = prodMap[a.division + "||" + a.sku.toLowerCase()];
      if (!pid) return;
      ids.push(a.id);
      memberIds.push(a.memberId);
      managerIds.push(a.managerId);
      productIds.push(pid);
      outSkus.push(a.sku);
      outDivisions.push(a.division);
      stages.push(a.stage);
      assignedAts.push(a.assignedAt || new Date().toISOString());
      (validIdsByDivision[a.division] ||= []).push(a.id);
    });

    if (ids.length > 0) {
      await client.query(
        `INSERT INTO assignments (id, member_id, manager_id, product_id, sku, division, stage, assigned_at)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::division_name[], $7::text[], $8::timestamptz[])
         ON CONFLICT (id) DO UPDATE SET
           member_id = EXCLUDED.member_id,
           manager_id = EXCLUDED.manager_id,
           product_id = EXCLUDED.product_id,
           sku = EXCLUDED.sku,
           division = EXCLUDED.division,
           stage = EXCLUDED.stage,
           assigned_at = EXCLUDED.assigned_at`,
        [ids, memberIds, managerIds, productIds, outSkus, outDivisions, stages, assignedAts]
      );
    }

    // ---- Delete only rows NOT present in payload, scoped PER DIVISION ----
    // This is the critical fix: previously this deleted globally, so any
    // omission for one division (e.g. Bombay) risked corrupting another
    // (e.g. KOC). Now a Bombay-only save can never touch KOC rows.
    for (const div of divisionsInPayload) {
      const keepIds = validIdsByDivision[div] || [];
      if (keepIds.length > 0) {
        await client.query(
          `DELETE FROM assignments WHERE division = $1 AND id != ALL($2::text[])`,
          [div, keepIds]
        );
      }
    }

    await client.query("COMMIT");
    res.json({ ok: true, upserted: ids.length });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("setAssignments error", e);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

// Explicit, deliberate "wipe everything" endpoint — separate from the sync endpoint above,
// so it can never be triggered by accident via a stray/empty payload.
app.post("/api/clearAssignments", async (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({ ok: false, error: "Must pass { confirm: true } to clear all assignments." });
  }
  try {
    const { rows } = await pool.query("SELECT COUNT(*) FROM assignments");
    await pool.query("DELETE FROM assignments");
    res.json({ ok: true, deleted: Number(rows[0].count) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


/* ----------------------------------------------------------------
   POST /api/appendAudit   body: full audit entry
---------------------------------------------------------------- */
app.post("/api/appendAudit", async (req, res) => {
  const e = req.body;
  try {
    await pool.query(
      `INSERT INTO audit_log (id, logged_at, actor_name, action, entity, detail, division)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [e.id, e.at || new Date().toISOString(), e.actor || "Unattributed", e.action, e.entity, e.detail || "", e.division || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("appendAudit error", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ----------------------------------------------------------------
   GET /api/memberStats?memberId=chitra&division=KOC Cards
   Returns accurate counts straight from DB for Overview KPIs
---------------------------------------------------------------- */
app.get("/api/memberStats", async (req, res) => {
  const { memberId, division } = req.query;
  if (!memberId || !division) return res.status(400).json({ ok: false, error: "memberId and division required" });
  try {
    const { rows } = await pool.query(`
      WITH member_skus AS (
        SELECT DISTINCT sku
        FROM assignments
        WHERE member_id = $1 AND division = $2
      ),
      pushed_skus AS (
        SELECT DISTINCT sku
        FROM assignments
        WHERE manager_id = $1
          AND member_id != $1
          AND division = $2
      ),
      kept_skus AS (
        SELECT sku FROM member_skus
        WHERE sku NOT IN (SELECT sku FROM pushed_skus)
      ),
      target_assignments AS (
        SELECT DISTINCT p.id AS product_id, a.stage AS assigned_stage
        FROM assignments a
        JOIN products p ON p.sku = a.sku AND p.division = a.division
        WHERE a.member_id = $1 AND a.division = $2
      ),
      card_level AS (
        SELECT
          ta.product_id,
          COUNT(*) AS stages_owned,
          COUNT(*) FILTER (WHERE se.status = 'Completed') AS stages_completed,
          bool_or(
            se.status = 'Issue'
            OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
          ) AS has_open_issue
        FROM target_assignments ta
        JOIN stage_entries se
          ON se.product_id = ta.product_id
          AND se.stage_key = ta.assigned_stage
        GROUP BY ta.product_id
      )
      SELECT
        (SELECT COUNT(*) FROM member_skus) AS total_assigned,
        (SELECT COUNT(*) FROM pushed_skus) AS pushed_to_team,
        (SELECT COUNT(*) FROM kept_skus)   AS kept_by_manager,
        (SELECT COUNT(*) FROM card_level WHERE stages_completed = stages_owned AND NOT has_open_issue) AS completed,
        (SELECT COUNT(*) FROM card_level WHERE stages_completed < stages_owned AND NOT has_open_issue) AS pending,
        (SELECT COUNT(*) FROM card_level WHERE has_open_issue) AS issues
    `, [memberId, division]);

    res.json({ ok: true, ...rows[0] });
  } catch (e) {
    console.error("memberStats error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});


app.get("/api/allMemberStats", async (req, res) => {
  const { division } = req.query;
  if (!division) return res.status(400).json({ ok: false, error: "division required" });
  try {
    const { rows } = await pool.query(`
      WITH target_assignments AS (
        SELECT DISTINCT a.member_id, p.id AS product_id, a.stage AS assigned_stage
        FROM assignments a
        JOIN products p ON p.sku = a.sku AND p.division = a.division
        WHERE a.division = $1
      ),
      card_level AS (
        SELECT
          ta.member_id,
          ta.product_id,
          COUNT(*) AS stages_owned,
          COUNT(*) FILTER (WHERE se.status = 'Completed') AS stages_completed,
          bool_or(
            se.status = 'Issue'
            OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
          ) AS has_open_issue
        FROM target_assignments ta
        JOIN stage_entries se
          ON se.product_id = ta.product_id
          AND se.stage_key = ta.assigned_stage
        GROUP BY ta.member_id, ta.product_id
      )
      SELECT
        u.id AS member_id,
        u.name AS member_name,
        COUNT(cl.product_id) AS total_assigned,
        COUNT(*) FILTER (WHERE cl.stages_completed = cl.stages_owned AND NOT cl.has_open_issue) AS completed,
        COUNT(*) FILTER (WHERE cl.stages_completed < cl.stages_owned AND NOT cl.has_open_issue) AS pending,
        COUNT(*) FILTER (WHERE cl.has_open_issue) AS issues
      FROM card_level cl
      JOIN users u ON u.id = cl.member_id
      GROUP BY u.id, u.name
      ORDER BY u.name
    `, [division]);

    res.json({
      ok: true,
      members: rows.map(r => ({
        memberId: r.member_id,
        memberName: r.member_name,
        total: Number(r.total_assigned),
        completed: Number(r.completed),
        pending: Number(r.pending),
        issues: Number(r.issues),
      }))
    });
  } catch (e) {
    console.error("allMemberStats error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});





/* ----------------------------------------------------------------
   GET /api/pipelineStats?memberId=chitra&division=KOC Cards
   Returns per-stage counts for all SKUs assigned to this member
---------------------------------------------------------------- */
app.get("/api/pipelineStats", async (req, res) => {
  const { memberId, division } = req.query;
  if (!memberId || !division) return res.status(400).json({ ok: false, error: "memberId and division required" });
  try {
    const { rows } = await pool.query(`
      WITH member_skus AS (
        SELECT DISTINCT p.id as product_id, a.stage as assigned_stage
        FROM assignments a
        JOIN products p ON p.sku = a.sku AND p.division = a.division
        WHERE a.member_id = $1
          AND a.division = $2
      )
      SELECT
        se.stage_key,
        COUNT(*) FILTER (WHERE se.status = 'Not Started') as not_started,
        COUNT(*) FILTER (
          WHERE se.status = 'In Progress' AND se.comments NOT LIKE 'QC flagged:%'
        ) as in_progress,
        COUNT(*) FILTER (WHERE se.status = 'Completed') as completed,
        COUNT(*) FILTER (
          WHERE se.status = 'Issue'
             OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
        ) as issue
      FROM member_skus ms
      JOIN stage_entries se ON se.product_id = ms.product_id
        AND se.stage_key = ms.assigned_stage
      GROUP BY se.stage_key
    `, [memberId, division]);

    const stages = {};
    rows.forEach(r => {
      stages[r.stage_key] = {
        notStarted: Number(r.not_started),
        inProgress: Number(r.in_progress),
        completed: Number(r.completed),
        issue: Number(r.issue),
      };
    });

    res.json({ ok: true, stages });
  } catch (e) {
    console.error("pipelineStats error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   Helpers for /api/exportProducts
---------------------------------------------------------------- */
async function getExportRowsForDivision(client, division, scope) {
  const { rows } = await client.query(`
    WITH stage_counts AS (
      SELECT
        p.id AS product_id,
        COUNT(*) FILTER (WHERE se.status = 'Completed') AS completed_stages,
        COUNT(*) FILTER (WHERE se.status = 'Issue') AS issue_stages,
        MIN(CASE WHEN se.status IS DISTINCT FROM 'Completed' THEN se.stage_key END) AS next_pending_stage
      FROM products p
      LEFT JOIN stage_entries se
        ON se.product_id = p.id AND se.stage_key != 'finalqc'
      WHERE p.division = $1
      GROUP BY p.id
    )
    SELECT p.sku, p.name, p.vendor, p.division, p.qty, p.verdict, p.updated_at,
           sc.completed_stages, sc.issue_stages, sc.next_pending_stage
    FROM products p
    JOIN stage_counts sc ON sc.product_id = p.id
    WHERE p.division = $1
      AND (
        $2 = 'all'
        OR ($2 = 'completed' AND sc.completed_stages = $3)
        OR ($2 = 'pending'   AND sc.completed_stages < $3)
        OR ($2 = 'issues'    AND (p.verdict = 'Issues Found' OR sc.issue_stages > 0))
      )
    ORDER BY p.sku
  `, [division, scope, PIPELINE_STAGE_COUNT]);
  return rows;
}

async function getExportRowsForMember(client, division, memberId, scope) {
  const { rows } = await client.query(`
    WITH my_assignments AS (
      SELECT DISTINCT a.sku, a.stage
      FROM assignments a
      WHERE a.member_id = $1 AND a.division = $2
    ),
    card_level AS (
      SELECT
        p.id AS product_id,
        p.sku, p.name, p.vendor, p.division, p.qty, p.verdict, p.updated_at,
        COUNT(*) AS stages_owned,
        COUNT(*) FILTER (WHERE se.status = 'Completed') AS stages_completed,
        COUNT(*) FILTER (WHERE se.status = 'Issue') AS stages_issue,
        MIN(CASE WHEN se.status IS DISTINCT FROM 'Completed' THEN ma.stage END) AS next_pending_stage
      FROM my_assignments ma
      JOIN products p ON p.sku = ma.sku AND p.division = $2
      LEFT JOIN stage_entries se ON se.product_id = p.id AND se.stage_key = ma.stage
      GROUP BY p.id, p.sku, p.name, p.vendor, p.division, p.qty, p.verdict, p.updated_at
    )
    SELECT * FROM card_level
    WHERE
      $3 = 'all'
      OR ($3 = 'completed' AND stages_completed = stages_owned)
      OR ($3 = 'pending'   AND stages_completed < stages_owned)
      OR ($3 = 'issues'    AND (verdict = 'Issues Found' OR stages_issue > 0))
    ORDER BY sku
  `, [memberId, division, scope]);
  return rows;
}

function normStatusServer(v) {
  if (!v) return null;
  const m = { "not started": "Not Started", "in progress": "In Progress", "wip": "In Progress",
    "pending": "In Progress", "completed": "Completed", "complete": "Completed", "done": "Completed",
    "approved": "Completed", "issue": "Issue", "issues": "Issue" };
  return m[String(v).trim().toLowerCase()] || null;
}

app.post("/api/bulkImportProducts", async (req, res) => {
  const rows = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ ok: false, error: "expected array" });

  const validRows = rows.filter(r => {
    const sku = String(r.sku || "").trim();
    return sku && !sku.toUpperCase().includes("EXAMPLE");
  });

  const results = { total: rows.length, created: 0, updated: 0, failed: [] };
  if (validRows.length === 0) return res.json({ ok: true, ...results });

  const client = await pool.connect();
  try {
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("BEGIN");

    // ---- 1. Bulk upsert products (ONE query for the whole chunk) ----
    const divisions = [], skus = [], names = [], vendors = [], inwards = [], qtys = [], notes = [], setNos = [];
    validRows.forEach(r => {
      divisions.push(r.division || null);
      skus.push(String(r.sku).trim());
      names.push(r.name || "");
      vendors.push(r.vendor || null);
      inwards.push(r.inward ? String(r.inward) : null);
      qtys.push(Number(r.qty) || 0);
      notes.push(r.note || "");
      setNos.push(r.set_no || null);
    });

    const upsertResult = await client.query(
      `INSERT INTO products (id, division, sku, name, vendor, inward, qty, note, set_no, created_at, updated_at)
       SELECT gen_random_uuid()::text, d, s, n, v, NULLIF(i,'')::date, q, nt, sn, now(), now()
       FROM unnest($1::division_name[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::text[], $8::text[])
         AS t(d, s, n, v, i, q, nt, sn)
       ON CONFLICT (division, sku) DO UPDATE SET
         name    = COALESCE(NULLIF(EXCLUDED.name,''), products.name),
         vendor  = COALESCE(EXCLUDED.vendor, products.vendor),
         inward  = COALESCE(EXCLUDED.inward, products.inward),
         qty     = CASE WHEN EXCLUDED.qty > 0 THEN EXCLUDED.qty ELSE products.qty END,
         note    = COALESCE(NULLIF(EXCLUDED.note,''), products.note),
         set_no  = COALESCE(NULLIF(EXCLUDED.set_no,''), products.set_no),
         updated_at = now()
       RETURNING id, sku, division, (xmax = 0) AS inserted`,
      [divisions, skus, names, vendors, inwards, qtys, notes, setNos]
    );

    const skuToId = {};
    upsertResult.rows.forEach(r => {
      skuToId[r.division + "||" + r.sku.toLowerCase()] = r.id;
      r.inserted ? results.created++ : results.updated++;
    });

    // ---- 2. Bulk upsert vendors (deduped, ONE query) ----
    const vendorPairs = new Set();
    validRows.forEach(r => {
      if (r.vendor && String(r.vendor).trim()) {
        vendorPairs.add((r.division || "") + "||" + String(r.vendor).trim());
      }
    });
    if (vendorPairs.size > 0) {
      const vDivs = [], vNames = [];
      vendorPairs.forEach(p => { const [d, n] = p.split("||"); vDivs.push(d); vNames.push(n); });
      await client.query(
        `INSERT INTO vendors (division, vendor_name)
         SELECT * FROM unnest($1::division_name[], $2::text[]) ON CONFLICT DO NOTHING`,
        [vDivs, vNames]
      );
    }

    // ---- 3. Bulk upsert stage_entries (ONE query for ALL stages of ALL rows) ----
    const pids = [], stageKeys = [], statuses = [], persons = [], commentsArr = [], widths = [], heights = [], weights = [];
    validRows.forEach(r => {
      const key = (r.division || "") + "||" + String(r.sku).trim().toLowerCase();
      const productId = skuToId[key];
      if (!productId) { results.failed.push({ sku: r.sku, error: "product upsert failed" }); return; }
      for (const s of STAGE_KEYS) {
        if (s === "finalqc") continue;
        const statusRaw = r[s + "_status"], person = r[s + "_person"] || "", comm = r[s + "_comments"] || "";
        const width  = s === "dimensions" ? (r.dimensions_width  ? Number(r.dimensions_width)  : null) : null;
        const height = s === "dimensions" ? (r.dimensions_height ? Number(r.dimensions_height) : null) : null;
        const weight = s === "dimensions" ? (r.dimensions_weight ? Number(r.dimensions_weight) : null) : null;
        if (!statusRaw && !person && !comm && width == null && height == null && weight == null) continue;
        pids.push(productId);
        stageKeys.push(s);
        statuses.push(normStatusServer(statusRaw));
        persons.push(person);
        commentsArr.push(comm);
        widths.push(width);
        heights.push(height);
        weights.push(weight);
      }
    });

    if (pids.length > 0) {
      await client.query(
        `INSERT INTO stage_entries (product_id, stage_key, status, person, comments, updated_at, width_cm, height_cm, weight_gm)
         SELECT p, sk, st, pe, co, now(), w, h, wt
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::numeric[], $8::numeric[])
           AS t(p, sk, st, pe, co, w, h, wt)
         ON CONFLICT (product_id, stage_key) DO UPDATE SET
           status   = COALESCE(EXCLUDED.status, stage_entries.status),
           person   = COALESCE(NULLIF(EXCLUDED.person,''), stage_entries.person),
           comments = COALESCE(NULLIF(EXCLUDED.comments,''), stage_entries.comments),
           updated_at = now(),
           width_cm  = COALESCE(EXCLUDED.width_cm, stage_entries.width_cm),
           height_cm = COALESCE(EXCLUDED.height_cm, stage_entries.height_cm),
           weight_gm = COALESCE(EXCLUDED.weight_gm, stage_entries.weight_gm)`,
        [pids, stageKeys, statuses, persons, commentsArr, widths, heights, weights]
      );
    }

    // ---- 4. QC verdicts (ONE query) ----
    const qcIds = [], qcVerdicts = [], qcIssues = [];
    validRows.forEach(r => {
      if (!r.qc_verdict) return;
      const key = (r.division || "") + "||" + String(r.sku).trim().toLowerCase();
      const productId = skuToId[key];
      if (!productId) return;
      const v = /appro/i.test(r.qc_verdict) ? "Approved" : /issue/i.test(r.qc_verdict) ? "Issues Found" : null;
      if (!v) return;
      qcIds.push(productId); qcVerdicts.push(v); qcIssues.push(r.qc_issues || "");
    });
    if (qcIds.length > 0) {
      await client.query(
        `UPDATE products p SET verdict = t.v, issues = t.iss, updated_at = now()
         FROM unnest($1::text[], $2::text[], $3::text[]) AS t(id, v, iss)
         WHERE p.id = t.id`,
        [qcIds, qcVerdicts, qcIssues]
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true, ...results });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("bulkImportProducts error", e);
    res.status(500).json({ ok: false, error: e.message, ...results });
  } finally {
    client.release();
  }
});







/* ----------------------------------------------------------------
   GET /api/exportProducts?division=KOC Cards&scope=pending&memberId=chitra
   scope: "pending" | "completed" | "issues" | "all"
   memberId optional — omit for master/admin (whole division)
---------------------------------------------------------------- */
app.get("/api/exportProducts", async (req, res) => {
  const { division, scope, memberId } = req.query;
  if (!division) return res.status(400).json({ ok: false, error: "division required" });
  if (!["pending", "completed", "issues", "all"].includes(scope)) {
    return res.status(400).json({ ok: false, error: "invalid scope" });
  }
  const client = await pool.connect();
  try {
    const rows = memberId
      ? await getExportRowsForMember(client, division, memberId, scope)
      : await getExportRowsForDivision(client, division, scope);

    res.json({ ok: true, scope, count: rows.length, rows });
  } catch (e) {
    console.error("exportProducts error", e);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});


/* ----------------------------------------------------------------
   GET /api/stageIssueStats?division=KOC Cards
   Returns issue counts per stage, based on each product's LATEST
   qc_audit entry — only counted while verdict is still "Issues Found".
---------------------------------------------------------------- */
app.get("/api/stageIssueStats", async (req, res) => {
  const { division } = req.query;
  if (!division) return res.status(400).json({ ok: false, error: "division required" });
  try {
    const { rows } = await pool.query(`
      SELECT se.stage_key, COUNT(*) AS issue_count
      FROM stage_entries se
      JOIN products p ON p.id = se.product_id
      WHERE p.division = $1
        AND (
          se.status = 'Issue'
          OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
        )
      GROUP BY se.stage_key
    `, [division]);

    const stages = {};
    rows.forEach(r => { stages[r.stage_key] = Number(r.issue_count); });
    res.json({ ok: true, stages });
  } catch (e) {
    console.error("stageIssueStats error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   GET /api/pipelineBreakdown?division=KOC Cards&memberId=chitra&vendor=X&setNo=Y
   Unified stage-by-stage counts for the Overview "Pipeline progress" table.
   - memberId omitted  -> whole division (master/admin / "all my team" view)
   - memberId present  -> only that member's assigned stages on their SKUs
   - vendor / setNo     -> optional narrowing, applied identically either way
   "issue" = status = 'Issue' OR (status = 'In Progress' AND QC-flagged comment)
---------------------------------------------------------------- */
app.get("/api/pipelineBreakdown", async (req, res) => {
  const { division, memberId, vendor, setNo } = req.query;
  if (!division) return res.status(400).json({ ok: false, error: "division required" });

  try {
    let rows;
    if (memberId) {
      // Scoped to one member's specific assigned stages on their assigned SKUs
      const { rows: r } = await pool.query(`
        WITH member_scope AS (
          SELECT DISTINCT p.id AS product_id, a.stage AS stage_key
          FROM assignments a
          JOIN products p
            ON p.sku = a.sku AND p.division = a.division
          WHERE a.member_id = $1
            AND a.division = $2
            AND ($3::text IS NULL OR p.vendor = $3)
            AND ($4::text IS NULL OR p.set_no = $4)
        )
        SELECT
          se.stage_key,
          COUNT(*) FILTER (WHERE se.status = 'Not Started') AS not_started,
          COUNT(*) FILTER (WHERE se.status = 'In Progress' AND se.comments NOT LIKE 'QC flagged:%') AS in_progress,
          COUNT(*) FILTER (WHERE se.status = 'Completed') AS completed,
          COUNT(*) FILTER (
            WHERE se.status = 'Issue'
               OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
          ) AS issue
        FROM member_scope ms
        JOIN stage_entries se
          ON se.product_id = ms.product_id AND se.stage_key = ms.stage_key
        GROUP BY se.stage_key
      `, [memberId, division, vendor || null, setNo || null]);
      rows = r;
    } else {
      // Whole division (or vendor/setNo-narrowed), every stage on every product
      const { rows: r } = await pool.query(`
        SELECT
          se.stage_key,
          COUNT(*) FILTER (WHERE se.status = 'Not Started') AS not_started,
          COUNT(*) FILTER (WHERE se.status = 'In Progress' AND se.comments NOT LIKE 'QC flagged:%') AS in_progress,
          COUNT(*) FILTER (WHERE se.status = 'Completed') AS completed,
          COUNT(*) FILTER (
            WHERE se.status = 'Issue'
               OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
          ) AS issue
        FROM stage_entries se
        JOIN products p ON p.id = se.product_id
        WHERE p.division = $1
          AND se.stage_key != 'finalqc'
          AND ($2::text IS NULL OR p.vendor = $2)
          AND ($3::text IS NULL OR p.set_no = $3)
        GROUP BY se.stage_key
      `, [division, vendor || null, setNo || null]);
      rows = r;
    }

    const stages = {};
    rows.forEach(r => {
      stages[r.stage_key] = {
        notStarted: Number(r.not_started),
        inProgress: Number(r.in_progress), 
        completed: Number(r.completed),
        issue: Number(r.issue),
      };
    });
    res.json({ ok: true, stages });
  } catch (e) {
    console.error("pipelineBreakdown error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   GET /api/stageSpeedStats?division=KOC Cards
   Average time-to-complete per stage, computed from audit_log.
---------------------------------------------------------------- */
app.get("/api/stageSpeedStats", async (req, res) => {
  const { division } = req.query;
  if (!division) return res.status(400).json({ ok: false, error: "division required" });
  try {
    const { rows } = await pool.query(
      `SELECT entity, detail, logged_at FROM audit_log
       WHERE action = 'Stage update' AND division = $1
       ORDER BY entity, logged_at ASC`,
      [division]
    );

    // entity+stage -> { firstInProgress, firstCompleted }
    const track = {};
    rows.forEach(r => {
      const m = String(r.detail || "").match(/^(.+?)\s*→\s*([^·]+?)(?:\s*·|$)/);
      if (!m) return;
      const stageName = m[1].trim();
      const status = m[2].trim();
      const key = r.entity + "||" + stageName;
      if (!track[key]) track[key] = { stageName, firstInProgress: null, firstCompleted: null };
      const t = track[key];
      if (status === "In Progress" && !t.firstInProgress) t.firstInProgress = r.logged_at;
      if (status === "Completed" && !t.firstCompleted && t.firstInProgress) t.firstCompleted = r.logged_at;
    });

    const byStage = {};
    Object.values(track).forEach(t => {
      if (!t.firstInProgress || !t.firstCompleted) return;
      const hours = (new Date(t.firstCompleted) - new Date(t.firstInProgress)) / 3600000;
      if (hours < 0 || hours > 24 * 60) return; // discard bad/outlier data
      (byStage[t.stageName] ||= []).push(hours);
    });

    const stats = Object.entries(byStage).map(([stageName, durations]) => ({
      stageName,
      avgHours: durations.reduce((a, b) => a + b, 0) / durations.length,
      sampleCount: durations.length,
    })).sort((a, b) => a.avgHours - b.avgHours);

    res.json({ ok: true, stats });
  } catch (e) {
    console.error("stageSpeedStats error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   GET /api/memberSpeedStats?division=KOC Cards
   Per-member turnaround speed + issue rate, computed from audit_log.
   "Speed" = avg hours between a stage's first "In Progress" and its
   next "Completed", attributed to whoever completed it.
---------------------------------------------------------------- */
app.get("/api/memberSpeedStats", async (req, res) => {
  const { division } = req.query;
  if (!division) return res.status(400).json({ ok: false, error: "division required" });
  try {
    const { rows } = await pool.query(
      `SELECT entity, detail, logged_at, actor_name FROM audit_log
       WHERE action = 'Stage update' AND division = $1
       ORDER BY entity, logged_at ASC`,
      [division]
    );

    const lastInProgress = {}; // "sku||stageName" -> timestamp
    const byMember = {};       // person name -> accumulator

    const touch = (name) => (byMember[name] ||= { durations: [], completions: 0, issues: 0, byStage: {} });

    rows.forEach(r => {
      const m = String(r.detail || "").match(/^(.+?)\s*→\s*([^·]+?)(?:\s*·\s*(.+))?$/);
      if (!m) return;
      const stageName = m[1].trim();
      const status = m[2].trim();
      const person = (m[3] || "").trim() || (r.actor_name || "").trim();
      const key = r.entity + "||" + stageName;

      if (status === "In Progress") {
        lastInProgress[key] = r.logged_at;
      } else if (status === "Completed") {
        const startedAt = lastInProgress[key];
        if (startedAt && person) {
          const hours = (new Date(r.logged_at) - new Date(startedAt)) / 3600000;
          // discard bad/stalled outliers (>60 days) so one forgotten card
          // doesn't wreck someone's average
          if (hours > 0 && hours < 24 * 60) {
            const acc = touch(person);
            acc.durations.push(hours);
            acc.completions++;
            (acc.byStage[stageName] ||= []).push(hours);
          }
        }
        delete lastInProgress[key];
      } else if (status === "Issue" && person) {
        touch(person).issues++;
      }
    });

    const members = Object.entries(byMember).map(([name, m]) => {
      const avgHours = m.durations.length
        ? m.durations.reduce((a, b) => a + b, 0) / m.durations.length
        : null;
      const stageBreakdown = Object.entries(m.byStage)
        .map(([stageName, arr]) => ({
          stageName,
          avgHours: arr.reduce((a, b) => a + b, 0) / arr.length,
          count: arr.length,
        }))
        .sort((a, b) => a.avgHours - b.avgHours);
      return {
        name,
        completions: m.completions,
        avgHours,
        issues: m.issues,
        issueRate: (m.completions + m.issues) ? m.issues / (m.completions + m.issues) : 0,
        fastestStage: stageBreakdown[0] || null,
        slowestStage: stageBreakdown[stageBreakdown.length - 1] || null,
        stageBreakdown,
      };
    })
    .filter(x => x.completions > 0)
    .sort((a, b) => a.avgHours - b.avgHours); // fastest first

    res.json({ ok: true, members });
  } catch (e) {
    console.error("memberSpeedStats error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   GET /api/teamStageStats?division=...&vendor=&set_no=&dateFrom=&dateTo=&status=
   Per-member counts of assigned stages, split into Backend team vs
   Photography & Videography team, with optional filters.
---------------------------------------------------------------- */
const TEAM_BACKEND_STAGE_KEYS = ["content", "dimensions", "images", "backend", "website"];
const TEAM_PHOTO_STAGE_KEYS = ["photography", "photoedit", "videography", "videoedit"];

app.get("/api/teamStageStats", async (req, res) => {
  const { division, vendor, set_no, dateFrom, dateTo } = req.query;
  if (!division) return res.status(400).json({ ok: false, error: "division required" });


    try {
    const allStageKeys = [...TEAM_BACKEND_STAGE_KEYS, ...TEAM_PHOTO_STAGE_KEYS];

    const { rows: userRows } = await pool.query(
      `SELECT id, manager_id FROM users`
    );
    const managerIdOf = {};
    userRows.forEach(u => { managerIdOf[u.id] = u.manager_id; });
    const conditions = ["a.division = $1", "a.stage = ANY($2)"];
    const params = [division, allStageKeys];

    if (vendor) {
      params.push(vendor);
      conditions.push(`p.vendor = $${params.length}`);
    }
    if (set_no) {
      params.push(set_no);
      conditions.push(`p.set_no = $${params.length}`);
    }
    if (dateFrom) {
      params.push(dateFrom);
      conditions.push(`a.assigned_at >= $${params.length}`);
    }
    if (dateTo) {
      params.push(dateTo + " 23:59:59");
      conditions.push(`a.assigned_at <= $${params.length}`);
    }
    // NOTE: status is intentionally NOT added to `conditions` — it must not
    // shrink the row set, or Total Assigned would change with it.

    const { rows } = await pool.query(
      `SELECT a.member_id, u.name AS member_name, a.stage, a.sku, se.status AS stage_status
       FROM assignments a
       JOIN users u ON u.id = a.member_id
       JOIN products p ON p.id = a.product_id
       LEFT JOIN stage_entries se ON se.product_id = a.product_id AND se.stage_key = a.stage
       WHERE ${conditions.join(" AND ")}`,
      params
    );
  const buildGroup = (stageKeys) => {
    const byMember = {};
    rows.forEach(r => {
      if (!stageKeys.includes(r.stage)) return;
      const acc = (byMember[r.member_id] ||= { memberName: r.member_name, skus: new Set(), skuStage: {} });

      acc.skus.add(r.sku);
      // Remember status per sku+stage instead of tallying immediately —
      // we don't yet know which skus will survive the manager/report subtraction.
      (acc.skuStage[r.sku] ||= {})[r.stage] = r.stage_status;
    });

    // Subtract reports' skus from their manager's set — same as totalAssigned.
    Object.keys(byMember).forEach(managerId => {
      const reportIds = Object.keys(byMember).filter(id => managerIdOf[id] === managerId);
      if (reportIds.length === 0) return;
      const managerSkus = byMember[managerId].skus;
      reportIds.forEach(repId => {
        byMember[repId].skus.forEach(sku => managerSkus.delete(sku));
      });
    });

    return Object.entries(byMember)
      .map(([memberId, m]) => {
        const perStage = stageKeys.reduce((o, k) => ({ ...o, [k]: { completed: 0, pending: 0, issue: 0 } }), {});
        m.skus.forEach(sku => {
          const stagesForSku = m.skuStage[sku] || {};
          stageKeys.forEach(stageKey => {
            if (!(stageKey in stagesForSku)) return;
            const status = stagesForSku[stageKey];
            if (status === "Completed") perStage[stageKey].completed++;
            else if (status === "Issue") perStage[stageKey].issue++;
            else perStage[stageKey].pending++;
          });
        });

        // A stage with zero completed/pending/issue means this member was
        // never assigned that stage on any of their cards — mark it null so
        // the frontend can show "—" instead of misleading zeros.
        stageKeys.forEach(k => {
          const s = perStage[k];
          if (s.completed + s.pending + s.issue === 0) perStage[k] = null;
        });

        return {
          memberId,
          memberName: m.memberName,
          totalAssigned: m.skus.size,
          perStage,
        };
      })
      .sort((a, b) => b.totalAssigned - a.totalAssigned);
  };

    res.json({
      ok: true,
      backendTeam: buildGroup(TEAM_BACKEND_STAGE_KEYS),
      photoTeam: buildGroup(TEAM_PHOTO_STAGE_KEYS),
    });
  } catch (e) {
    console.error("teamStageStats error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// /* ----------------------------------------------------------------
//    GET /api/effectiveMemberStagePipeline?division=KOC Cards
//    Same "effective assignment" logic as your psql query:
//      - resolves manager-vs-report double counting (if a manager pushed
//        a sku/stage to a report, it's excluded from the manager's
//        "effective" set)
//      - returns per-member, per-division, per-stage counts
//        (assigned / completed / in_progress / not_started / issue)
//    division is OPTIONAL — omit it to get both "KOC Cards" and
//    "Bombay Cards" together (matches the WHERE a.division IN (...)
//    in your original query). Pass it to scope to just one division.
// ---------------------------------------------------------------- */
app.get("/api/memberStageDetail", async (req, res) => {
  const { division, vendor, set_no, dateFrom, dateTo } = req.query;

  try {
    const { rows } = await pool.query(
      `
      WITH target_assignments AS (
          SELECT DISTINCT a.member_id, a.manager_id, a.division, a.stage AS assigned_stage,
                 p.id AS product_id, a.sku
          FROM assignments a
          JOIN products p ON p.sku = a.sku AND p.division = a.division
          WHERE a.division IN ('KOC Cards', 'Bombay Cards')
            AND ($1::division_name IS NULL OR a.division = $1::division_name)
            AND ($2::text IS NULL OR p.vendor = $2)
            AND ($3::text IS NULL OR p.set_no = $3)
            AND ($4::timestamptz IS NULL OR a.assigned_at >= $4)
            AND ($5::timestamptz IS NULL OR a.assigned_at <=$5)

      ),
      pushed AS (
          SELECT DISTINCT manager_id, division, assigned_stage, sku
          FROM target_assignments
          WHERE manager_id IS NOT NULL AND manager_id != member_id
      ),
      effective AS (
          SELECT DISTINCT ta.member_id, ta.division, ta.assigned_stage, ta.product_id, ta.sku
          FROM target_assignments ta
          WHERE NOT EXISTS (
              SELECT 1 FROM pushed p
              WHERE p.manager_id = ta.member_id
                AND p.division = ta.division
                AND p.assigned_stage = ta.assigned_stage
                AND p.sku = ta.sku
          )
      ),
      per_stage AS (
          SELECT
              e.member_id,
              e.division,
              e.assigned_stage AS stage,
              COUNT(DISTINCT e.sku) AS assigned_skus,
              COUNT(DISTINCT e.sku) FILTER (WHERE se.status = 'Completed') AS completed_skus,
              COUNT(DISTINCT e.sku) FILTER (
                  WHERE se.status = 'In Progress' AND se.comments NOT LIKE 'QC flagged:%'
              ) AS in_progress_skus,
              COUNT(DISTINCT e.sku) FILTER (WHERE se.status = 'Not Started') AS not_started_skus,
              COUNT(DISTINCT e.sku) FILTER (
                  WHERE se.status = 'Issue'
                     OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
              ) AS issue_skus
          FROM effective e
          LEFT JOIN stage_entries se
              ON se.product_id = e.product_id
             AND se.stage_key = e.assigned_stage
          GROUP BY e.member_id, e.division, e.assigned_stage
      ),
      totals AS (
          SELECT member_id, division, COUNT(DISTINCT sku) AS total_assigned_skus
          FROM effective
          GROUP BY member_id, division
      )
      SELECT
          u.id AS member_id,
          u.name AS member_name,
          t.division,
          t.total_assigned_skus,
          ps.stage,
          ps.assigned_skus,
          ps.completed_skus,
          ps.in_progress_skus,
          ps.not_started_skus,
          ps.issue_skus
      FROM totals t
      JOIN users u ON u.id = t.member_id
      JOIN per_stage ps ON ps.member_id = t.member_id AND ps.division = t.division
      ORDER BY t.division, u.name, ps.stage
      `,
      [division || null,
        vendor || null,
        set_no || null,
        dateFrom || null, 
        dateTo ? dateTo + "23:59:59" : null,

      ]
    );

    // Reshape flat rows into a nested per-member structure, same spirit
    // as your other stats endpoints (allMemberStats / teamStageStats).
    const byKey = {};
    rows.forEach(r => {
      const key = r.member_id + "||" + r.division;
      if (!byKey[key]) {
        byKey[key] = {
          memberId: r.member_id,
          memberName: r.member_name,
          division: r.division,
          totalAssignedSkus: Number(r.total_assigned_skus),
          stages: [],
        };
      }
      byKey[key].stages.push({
        stage: r.stage,
        assignedSkus: Number(r.assigned_skus),
        completedSkus: Number(r.completed_skus),
        inProgressSkus: Number(r.in_progress_skus),
        notStartedSkus: Number(r.not_started_skus),
        issueSkus: Number(r.issue_skus),
      });
    });

    res.json({
      ok: true,
      rows, // raw rows, in case the frontend wants the flat shape
      members: Object.values(byKey),
    });
  } catch (e) {
    console.error("effectiveMemberStagePipeline error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});




// app.get("/api/memberStageDetail", async (req, res) => {
//   const { division } = req.query;

//   try {
//     const { rows } = await pool.query(
//       `
//       WITH ranked_assignments AS (
//           SELECT
//               a.member_id, a.manager_id, a.division, a.stage AS assigned_stage,
//               p.id AS product_id, a.sku,
//               ROW_NUMBER() OVER (
//                   PARTITION BY a.sku, a.stage, a.division
//                   ORDER BY a.assigned_at DESC NULLS LAST, a.id DESC
//               ) AS rn
//           FROM assignments a
//           JOIN products p ON p.sku = a.sku AND p.division = a.division
//           WHERE a.division IN ('KOC Cards', 'Bombay Cards')
//             AND ($1::division_name IS NULL OR a.division = $1::division_name)
//       ),
//       target_assignments AS (
//           SELECT member_id, manager_id, division, assigned_stage, product_id, sku
//           FROM ranked_assignments
//           WHERE rn = 1
//       ),
//       pushed AS (
//           SELECT DISTINCT manager_id, division, assigned_stage, sku
//           FROM target_assignments
//           WHERE manager_id IS NOT NULL AND manager_id != member_id
//       ),
//       effective AS (
//           SELECT DISTINCT ta.member_id, ta.division, ta.assigned_stage, ta.product_id, ta.sku
//           FROM target_assignments ta
//           WHERE NOT EXISTS (
//               SELECT 1 FROM pushed p
//               WHERE p.manager_id = ta.member_id
//                 AND p.division = ta.division
//                 AND p.assigned_stage = ta.assigned_stage
//                 AND p.sku = ta.sku
//           )
//       ),
//       per_stage AS (
//           SELECT
//               e.member_id,
//               e.division,
//               e.assigned_stage AS stage,
//               COUNT(DISTINCT e.sku) AS assigned_skus,
//               COUNT(DISTINCT e.sku) FILTER (WHERE se.status = 'Completed') AS completed_skus,
//               COUNT(DISTINCT e.sku) FILTER (
//                   WHERE se.status = 'In Progress' AND se.comments NOT LIKE 'QC flagged:%'
//               ) AS in_progress_skus,
//               COUNT(DISTINCT e.sku) FILTER (WHERE se.status = 'Not Started') AS not_started_skus,
//               COUNT(DISTINCT e.sku) FILTER (
//                   WHERE se.status = 'Issue'
//                      OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
//               ) AS issue_skus
//           FROM effective e
//           LEFT JOIN stage_entries se
//               ON se.product_id = e.product_id
//              AND se.stage_key = e.assigned_stage
//           GROUP BY e.member_id, e.division, e.assigned_stage
//       ),
//       totals AS (
//           SELECT member_id, division, COUNT(DISTINCT sku) AS total_assigned_skus
//           FROM effective
//           GROUP BY member_id, division
//       )
//       SELECT
//           u.id AS member_id,
//           u.name AS member_name,
//           t.division,
//           t.total_assigned_skus,
//           ps.stage,
//           ps.assigned_skus,
//           ps.completed_skus,
//           ps.in_progress_skus,
//           ps.not_started_skus,
//           ps.issue_skus
//       FROM totals t
//       JOIN users u ON u.id = t.member_id
//       JOIN per_stage ps ON ps.member_id = t.member_id AND ps.division = t.division
//       ORDER BY t.division, u.name, ps.stage
//       `,
//       [division || null]
//     );

//     const byKey = {};
//     rows.forEach(r => {
//       const key = r.member_id + "||" + r.division;
//       if (!byKey[key]) {
//         byKey[key] = {
//           memberId: r.member_id,
//           memberName: r.member_name,
//           division: r.division,
//           totalAssignedSkus: Number(r.total_assigned_skus),
//           stages: [],
//         };
//       }
//       byKey[key].stages.push({
//         stage: r.stage,
//         assignedSkus: Number(r.assigned_skus),
//         completedSkus: Number(r.completed_skus),
//         inProgressSkus: Number(r.in_progress_skus),
//         notStartedSkus: Number(r.not_started_skus),
//         issueSkus: Number(r.issue_skus),
//       });
//     });

//     res.json({
//       ok: true,
//       rows,
//       members: Object.values(byKey),
//     });
//   } catch (e) {
//     console.error("memberStageDetail error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });



app.listen(process.env.PORT, () => {
  console.log(`Server running on http://localhost:${process.env.PORT}`);
});