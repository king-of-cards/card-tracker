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
  "barcoding", "content", "photography", "videography", "dimensions",
  "videoedit", "images", "backend", "website", "scan", "qc", "finalqc",
];
const STORES = [
  "Chamrajpet", "HSR Layout", "Sahakar Nagar", "Hoodi", "Jayanagar",
  "Bommasandra", "Hyderabad", "Mysore", "Vizag", "Hubli", "Chitradurga",
];

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
    if (row.vendor && String(row.vendor).trim()) {
      await client.query(
        `INSERT INTO vendors (division, vendor_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [division, String(row.vendor).trim()]
      );
    }
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
          `INSERT INTO stage_entries (product_id, stage_key, status, person, comments, updated_at)
           VALUES ($1,$2,$3,$4,$5, now())
           ON CONFLICT (product_id, stage_key) DO UPDATE SET
             status = COALESCE($3, stage_entries.status),
             person = COALESCE($4, stage_entries.person),
             comments = COALESCE($5, stage_entries.comments),
             updated_at = now()`,
          [id, stageKey, patch.status || null, patch.person ?? null, patch.comments ?? ""]
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
  try {
    await pool.query("DELETE FROM products WHERE id = $1", [req.body.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("deleteProduct error", e);
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
app.post("/api/setAssignments", async (req, res) => {
  const assignments = req.body;
  if (!Array.isArray(assignments)) return res.status(400).json({ ok: false, error: "expected array" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM assignments");
    for (const a of assignments) {
      // resolve product_id from sku+division since the frontend only sends sku
      const { rows } = await client.query(
        "SELECT id FROM products WHERE division = $1 AND lower(sku) = lower($2)",
        [a.division, a.sku]
      );
      if (!rows.length) continue; // skip orphaned assignment rows
      await client.query(
        `INSERT INTO assignments (id, member_id, manager_id, product_id, sku, division, stage, assigned_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [a.id, a.memberId, a.managerId, rows[0].id, a.sku, a.division, a.stage, a.assignedAt || new Date().toISOString()]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("setAssignments error", e);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
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
      -- Card-level completion: for every card this member is assigned on
      -- (regardless of who assigned it), compare how many stages they own
      -- on that card vs how many of those stages are Completed.
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
          COUNT(*) FILTER (WHERE se.status = 'Completed') AS stages_completed
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
        (SELECT COUNT(*) FROM card_level WHERE stages_completed = stages_owned) AS completed,
        (SELECT COUNT(*) FROM card_level WHERE stages_completed < stages_owned) AS pending
    `, [memberId, division]);

    res.json({ ok: true, ...rows[0] });
  } catch (e) {
    console.error("memberStats error", e);
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
        COUNT(*) FILTER (WHERE se.status = 'In Progress') as in_progress,
        COUNT(*) FILTER (WHERE se.status = 'Completed') as completed,
        COUNT(*) FILTER (WHERE se.status = 'Issue') as issue
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







app.listen(process.env.PORT, () => {
  console.log(`Server running on http://localhost:${process.env.PORT}`);
});