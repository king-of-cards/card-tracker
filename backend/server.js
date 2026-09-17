require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "25mb" })); 

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },

  max: 5,                            // small footprint — you're one of 5+ tenants on this RDS
  min: 0,                            // don't hold connections open when nothing's happening
  idleTimeoutMillis: 10000,          // release idle connections back fast (was 30000)
  connectionTimeoutMillis: 5000,     // fail fast if pool is busy, instead of hanging like before

  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,

  application_name: "card-tracker",  // shows up in pg_stat_activity so you can ID your own queries
  pipeline: true,
});

pool.on("error", (err) => {
  console.error("Idle client error — pool will recover:", err.message);
});

const MAX_PRODUCTS = 100000; 

async function getProductCount(client) {
  const { rows } = await client.query("SELECT COUNT(*) FROM products");
  return Number(rows[0].count);
}

const STAGE_KEYS = [
  "barcoding",
  "content",
  "photography",
  "photoedit",
  "videography",
  "dimensions",
  "videoedit",
  "images",
  "backend",
  "website",
  "scan",
  "qc",
  "finalqc",
];
const STORES = [
  "Chamrajpet",
  "HSR Layout",
  "Sahakar Nagar",
  "Hoodi",
  "Jayanagar",
  "Bommasandra",
  "Hyderabad",
  "Mysore",
  "Vizag",
  "Hubli",
  "Chitradurga",
];
const PIPELINE_STAGE_COUNT = STAGE_KEYS.filter((k) => k !== "finalqc").length; // 11

app.get("/", (req, res) =>
  res.json({ message: "Card Tracker API is running!" }),
);

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "connected to AWS RDS successfully!" });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
app.get("/health/pool", (req, res) => {
  res.json({
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: 10,
  });
});



/* ----------------------------------------------------------------
   Helpers — convert a DB row shape into the nested JSON shape the
   React app already expects (same shape ensureStages() builds).
---------------------------------------------------------------- */
async function loadFullProduct(client, productId) {
  const { rows: prows } = await client.query(
    "SELECT * FROM products WHERE id = $1",
    [productId],
  );
  if (!prows.length) return null;
  return hydrateProducts(client, prows).then((arr) => arr[0]);
}

async function hydrateProducts(client, productRows) {
  if (productRows.length === 0) return [];
  const ids = productRows.map((p) => p.id);

  const { rows: stageRows } = await client.query(
    `SELECT * FROM stage_entries WHERE product_id = ANY($1::text[])`,
    [ids],
  );
  const { rows: storeRows } = await client.query(
    `SELECT * FROM stores WHERE product_id = ANY($1::text[])`,
    [ids],
  );

  const stagesByProduct = {};
  stageRows.forEach((r) => {
    (stagesByProduct[r.product_id] ||= {})[r.stage_key] = {
      status: r.status,
      person: r.person || "",
      comments: r.comments || "",
      skipped: !!r.skipped,
      at: r.updated_at ? r.updated_at.toISOString() : "",
      ...(r.stage_key === "dimensions"
        ? {
            width: r.width_cm != null ? String(r.width_cm) : "",
            height: r.height_cm != null ? String(r.height_cm) : "",
            weight: r.weight_gm != null ? String(r.weight_gm) : "",
          }
        : {}),
    };
  });

  const storesByProduct = {};
  storeRows.forEach((r) => {
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

  return productRows.map((p) => {
    const stages = {};
    STAGE_KEYS.forEach((k) => {
      stages[k] = (stagesByProduct[p.id] && stagesByProduct[p.id][k]) || {
        status: "Not Started",
        person: "",
        comments: "",
        at: "",
      };
      if (k === "dimensions" && !stages[k].width) {
        stages[k].width = stages[k].width || "";
        stages[k].height = stages[k].height || "";
        stages[k].weight = stages[k].weight || "";
      }
    });
    const stores = {};
    STORES.forEach((st) => {
      stores[st] = (storesByProduct[p.id] && storesByProduct[p.id][st]) || {
        dispatched: 0,
        received: false,
        receivedAt: "",
        receivedBy: "",
        missing: 0,
        damaged: 0,
        notes: "",
        at: "",
      };
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
    const { rows: productRows } = await client.query(
      "SELECT * FROM products ORDER BY created_at DESC",
    );
    const products = await hydrateProducts(client, productRows);

    const { rows: vendorRows } = await client.query(
      "SELECT division, vendor_name FROM vendors ORDER BY vendor_name",
    );
    const vendors = {};
    vendorRows.forEach((v) => {
      (vendors[v.division] ||= []).push(v.vendor_name);
    });

    const { rows: teamRows } = await client.query(
      "SELECT * FROM users WHERE role = 'member'",
    );
    const teamMembers = teamRows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      password: u.password,
      role: u.role,
      stages: u.stages,
      division: u.division,
      managerId: u.manager_id,
      joinedAt: u.joined_at ? u.joined_at.toISOString() : "",
    }));

    const { rows: assignRows } = await client.query(
      "SELECT * FROM assignments ORDER BY assigned_at DESC",
    );
    const assignments = assignRows.map((a) => ({
      id: a.id,
      memberId: a.member_id,
      managerId: a.manager_id,
      sku: a.sku,
      stage: a.stage,
      division: a.division,
      assignedAt: a.assigned_at ? a.assigned_at.toISOString() : "",
    }));

    const { rows: qcRows } = await client.query(
      "SELECT * FROM qc_audit ORDER BY audited_at DESC",
    );
    const qcAudit = qcRows.map((q) => ({
      id: q.id,
      at: q.audited_at ? q.audited_at.toISOString() : "",
      auditor: q.auditor_name,
      sku: q.sku,
      division: q.division,
      productId: q.product_id,
      verdict: q.verdict,
      comments: q.comments,
      stagesSentBack: q.stages_sent_back,
    }));

    const { rows: auditRows } = await client.query(
      "SELECT * FROM audit_log ORDER BY logged_at DESC LIMIT 800",
    );
    const audit = auditRows.map((a) => ({
      id: a.id,
      at: a.logged_at ? a.logged_at.toISOString() : "",
      actor: a.actor_name,
      action: a.action,
      entity: a.entity,
      detail: a.detail,
      division: a.division,
    }));

    // NEW — assignment history
    const { rows: historyRows } = await client.query(
      `SELECT ah.*, 
        u1.name as to_member_name,
        u2.name as from_member_name
       FROM assignment_history ah
       LEFT JOIN users u1 ON u1.id = ah.to_member_id
       LEFT JOIN users u2 ON u2.id = ah.from_member_id
       ORDER BY ah.logged_at DESC LIMIT 500`,
    );
    const assignmentHistory = historyRows.map((r) => ({
      id: r.id,
      action: r.action,
      sku: r.sku,
      division: r.division,
      toMemberId: r.to_member_id,
      toMemberName: r.to_member_name,
      fromMemberId: r.from_member_id,
      fromMemberName: r.from_member_name,
      managerId: r.manager_id,
      stage: r.stage,
      note: r.note,
      at: r.logged_at,
    }));

    res.json({
      products,
      vendors,
      teamMembers,
      assignments,
      qcAudit,
      audit,
      assignmentHistory,
    });
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
    res.json(
      rows.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        password: u.password,
        role: u.role,
        stages: u.stages,
        division: u.division,
        managerId: u.manager_id,
        joinedAt: u.joined_at ? u.joined_at.toISOString() : "",
      })),
    );
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
  if (!Array.isArray(products))
    return res.status(400).json({ ok: false, error: "expected array" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ---- Cap check ----
    const currentCount = await getProductCount(client);
    const { rows: existingIdCheck } = await client.query(
      `SELECT id FROM products WHERE id = ANY($1::text[])`,
      [products.map((p) => p.id)],
    );
    const existingIdSet = new Set(existingIdCheck.map((r) => r.id));
    const newCount = products.filter((p) => !existingIdSet.has(p.id)).length;

    if (currentCount + newCount > MAX_PRODUCTS) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: `Product cap of ${MAX_PRODUCTS} would be exceeded. Currently ${currentCount}, trying to add ${newCount} new products.`,
      });
    }

    for (const p of products) {
      await client.query(
        `INSERT INTO products (id, division, sku, name, vendor, inward, qty, note, set_no, verdict, issues, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO UPDATE SET
           division=$2, sku=$3, name=$4, vendor=$5, inward=$6, qty=$7, note=$8, set_no=$9,
           verdict=$10, issues=$11, updated_at=$13`,
        [
          p.id,
          p.division,
          p.sku,
          p.name || "",
          p.vendor || null,
          p.inward || null,
          p.qty || 0,
          p.note || "",
          p.set_no || null,
          p.verdict || null,
          p.issues || "",
          p.createdAt || new Date().toISOString(),
          p.updatedAt || new Date().toISOString(),
        ],
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
              p.id,
              key,
              s.status || "Not Started",
              s.person || null,
              s.comments || "",
              s.at || new Date().toISOString(),
              s.width ? Number(s.width) || null : null,
              s.height ? Number(s.height) || null : null,
              s.weight ? Number(s.weight) || null : null,
            ],
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
              p.id,
              store,
              s.dispatched || 0,
              !!s.received,
              s.receivedAt || null,
              s.receivedBy || null,
              s.missing || 0,
              s.damaged || 0,
              s.notes || "",
              s.at || new Date().toISOString(),
            ],
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
  if (!Array.isArray(ids) || !stageKey || !patch)
    return res.status(400).json({ ok: false, error: "bad payload" });
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
          [
            id,
            stageKey,
            patch.status || null,
            patch.person ?? null,
            patch.comments ?? "",
            patch.skipped ?? null,
          ],
        );
        await client.query(
          "UPDATE products SET updated_at = now() WHERE id = $1",
          [id],
        );
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
      [id, verdict || null, issues || ""],
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
      [
        e.id,
        e.at || new Date().toISOString(),
        e.auditor || "",
        e.productId,
        e.sku,
        e.division,
        e.verdict,
        e.comments || "",
        e.stagesSentBack || "",
      ],
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
        productId,
        store,
        storeData.dispatched || 0,
        !!storeData.received,
        storeData.receivedAt || null,
        storeData.receivedBy || null,
        storeData.missing || 0,
        storeData.damaged || 0,
        storeData.notes || "",
      ],
    );
    await pool.query("UPDATE products SET updated_at = now() WHERE id = $1", [
      productId,
    ]);
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
      [
        e.id,
        e.action,
        e.sku,
        e.division,
        e.fromMemberId || null,
        e.toMemberId,
        e.managerId,
        e.stage || "",
        e.note || "",
        e.at || new Date().toISOString(),
      ],
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
      [division || null],
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
      [productId, stageKey],
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
          [division, vendorName],
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
  if (!Array.isArray(members))
    return res.status(400).json({ ok: false, error: "expected array" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const m of members) {
      await client.query(
        `INSERT INTO users (id, name, email, password, role, stages, division, manager_id, joined_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
           name=$2, email=$3, password=$4, role=$5, stages=$6, division=$7, manager_id=$8`,
        [
          m.id,
          m.name,
          m.email,
          m.password || "",
          m.role || "member",
          m.stages || "",
          m.division || null,
          m.managerId || null,
          m.joinedAt || new Date().toISOString(),
        ],
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
  if (!Array.isArray(users))
    return res.status(400).json({ ok: false, error: "expected array" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: existing } = await client.query(
      "SELECT id, email FROM users",
    );
    const incomingEmails = new Set(users.map((u) => u.email.toLowerCase()));
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
        [
          id,
          u.name || u.email,
          u.email,
          u.password || "",
          u.role || "member",
          u.stages || "",
        ],
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
  // Backward compatible: if body is a plain array, behave exactly as before
  // (full-replace/sync). If body is { mode: "add", assignments: [...] },
  // skip the delete/shrink-guard logic entirely and only insert/update —
  // safe for small "assign more work" actions.
  const isAddMode = !Array.isArray(req.body) && req.body?.mode === "add";
  const assignments = isAddMode ? req.body.assignments : req.body;

  if (!Array.isArray(assignments)) {
    return res.status(400).json({ ok: false, error: "expected array (or { mode: 'add', assignments: [...] })" });
  }
  if (isAddMode && assignments.length === 0) {
    return res.status(400).json({ ok: false, error: "assignments array is empty" });
  }

  const divisionsInPayload = [...new Set(assignments.map((a) => a.division))];

  const client = await pool.connect();
  try {
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("BEGIN");

        // ---- Per-division safety guards (fixes: a small Bombay Cards batch no longer
    // gets compared against KOC Cards' much larger row count) ----
    // Skipped entirely in "add" mode, since add-mode never deletes anything —
    // there's nothing for the shrink-guard to protect against.
    for (const div of isAddMode ? [] : divisionsInPayload) {
      const { rows: cr } = await client.query(
        "SELECT COUNT(*) FROM assignments WHERE division = $1",
        [div],
      );
      const currentCount = Number(cr[0].count);
      const incomingCountForDiv = assignments.filter(
        (a) => a.division === div,
      ).length;

      if (incomingCountForDiv === 0 && currentCount > 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          error: `Refusing to clear ${currentCount} existing assignments for "${div}" via empty payload.`,
        });
      }
      const SHRINK_THRESHOLD = 0.5;
      if (
        currentCount > 20 &&
        incomingCountForDiv < currentCount * SHRINK_THRESHOLD
      ) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          error: `Payload has ${incomingCountForDiv} rows for "${div}" but ${currentCount} currently exist — looks like a stale/partial payload.`,
          division: div,
          currentCount,
          incomingCount: incomingCountForDiv,
        });
      }
    }

    // ---- Resolve product ids (unchanged) ----
    let prodMap = {};
    if (assignments.length > 0) {
      const skus = assignments.map((a) => a.sku);
      const divisions = assignments.map((a) => a.division);
      const { rows: prodRows } = await client.query(
        `SELECT id, division, lower(sku) as sku_lower
         FROM products
         WHERE (division, lower(sku)) IN (
           SELECT * FROM unnest($1::division_name[], $2::text[])
         )`,
        [divisions, skus.map((s) => s.toLowerCase())],
      );
      prodRows.forEach((r) => {
        prodMap[r.division + "||" + r.sku_lower] = r.id;
      });
    }

    const ids = [],
      memberIds = [],
      managerIds = [],
      productIds = [],
      outSkus = [],
      outDivisions = [],
      stages = [],
      assignedAts = [];
    const validIdsByDivision = {};
    const skipped = []; // track WHY each row was dropped, instead of failing silently
    assignments.forEach((a) => {
      const pid = prodMap[a.division + "||" + String(a.sku || "").toLowerCase()];
      if (!pid) {
        skipped.push({ sku: a.sku, division: a.division });
        return;
      }
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

    // If every incoming row was skipped, this is the "nothing was written"
    // case — surface exactly which SKU/division pairs failed to resolve
    // instead of returning a bare ok:true with upserted:0.
    if (isAddMode && ids.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: `No matching product found for ${skipped.length} SKU(s) — check division/SKU spelling.`,
        skipped,
      });
    }

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
        [
          ids,
          memberIds,
          managerIds,
          productIds,
          outSkus,
          outDivisions,
          stages,
          assignedAts,
        ],
      );
    }

        // ---- Delete only rows NOT present in payload, scoped PER DIVISION ----
    // This is the critical fix: previously this deleted globally, so any
    // omission for one division (e.g. Bombay) risked corrupting another
    // (e.g. KOC). Now a Bombay-only save can never touch KOC rows.
    // Skipped entirely in "add" mode — additive calls never remove rows.
    for (const div of isAddMode ? [] : divisionsInPayload) {
      const keepIds = validIdsByDivision[div] || [];
      if (keepIds.length > 0) {
        await client.query(
          `DELETE FROM assignments WHERE division = $1 AND id != ALL($2::text[])`,
          [div, keepIds],
        );
      }
    }

    await client.query("COMMIT");
    res.json({ ok: true, upserted: ids.length, skipped });
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
    return res.status(400).json({
      ok: false,
      error: "Must pass { confirm: true } to clear all assignments.",
    });
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
      [
        e.id,
        e.at || new Date().toISOString(),
        e.actor || "Unattributed",
        e.action,
        e.entity,
        e.detail || "",
        e.division || null,
      ],
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
/* ----------------------------------------------------------------
   GET /api/memberStats?memberId=chitra&division=Bombay Cards
   Returns accurate counts straight from DB for Overview KPIs.

   FIXED (2 bugs):
   1. JOIN -> LEFT JOIN on stage_entries: a stage that's never been
      touched has no row in stage_entries at all, so an INNER JOIN
      silently dropped the whole card from card_level.
   2. bool_or() null-safety: when every stage in a card is untouched
      (se.status IS NULL throughout), the QC-flagged half of the OR
      evaluated to NULL instead of false, and `false OR NULL = NULL`
      made bool_or() return NULL for the whole card instead of false -
      failing both the "NOT has_open_issue" and "has_open_issue"
      checks, so the card vanished from every bucket.
---------------------------------------------------------------- */
app.get("/api/memberStats", async (req, res) => {
  const { memberId, division } = req.query;
  if (!memberId || !division)
    return res
      .status(400)
      .json({ ok: false, error: "memberId and division required" });
  try {
    const { rows } = await pool.query(
      `
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
            COALESCE(se.status, 'Not Started') = 'Issue'
            OR COALESCE(se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%', false)
          ) AS has_open_issue
        FROM target_assignments ta
        LEFT JOIN stage_entries se
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
    `,
      [memberId, division],
    );

    res.json({ ok: true, ...rows[0] });
  } catch (e) {
    console.error("memberStats error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/allMemberStats", async (req, res) => {
  const { division } = req.query;
  if (!division)
    return res.status(400).json({ ok: false, error: "division required" });
  try {
    const { rows } = await pool.query(
      `
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
    `,
      [division],
    );

    res.json({
      ok: true,
      members: rows.map((r) => ({
        memberId: r.member_id,
        memberName: r.member_name,
        total: Number(r.total_assigned),
        completed: Number(r.completed),
        pending: Number(r.pending),
        issues: Number(r.issues),
      })),
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
  if (!memberId || !division)
    return res
      .status(400)
      .json({ ok: false, error: "memberId and division required" });
  try {
    const { rows } = await pool.query(
      `
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
    `,
      [memberId, division],
    );

    const stages = {};
    rows.forEach((r) => {
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
  const { rows } = await client.query(
    `
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
  `,
    [division, scope, PIPELINE_STAGE_COUNT],
  );
  return rows;
}

async function getExportRowsForMember(client, division, memberId, scope) {
  const { rows } = await client.query(
    `
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
  `,
    [memberId, division, scope],
  );
  return rows;
}

function normStatusServer(v) {
  if (!v) return null;
  const m = {
    "not started": "Not Started",
    "in progress": "In Progress",
    wip: "In Progress",
    pending: "In Progress",
    completed: "Completed",
    complete: "Completed",
    done: "Completed",
    approved: "Completed",
    issue: "Issue",
    issues: "Issue",
  };
  return m[String(v).trim().toLowerCase()] || null;
}

app.post("/api/bulkImportProducts", async (req, res) => {
  const rows = req.body;
  if (!Array.isArray(rows))
    return res.status(400).json({ ok: false, error: "expected array" });

  const validRows = rows.filter((r) => {
    const sku = String(r.sku || "").trim();
    return sku && !sku.toUpperCase().includes("EXAMPLE");
  });

  const results = { total: rows.length, created: 0, updated: 0, failed: [] };
  if (validRows.length === 0) return res.json({ ok: true, ...results });

    const client = await pool.connect();
  try {
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("BEGIN");

    // ---- Cap check: block only if this batch pushes us past MAX_PRODUCTS ----
    const currentCount = await getProductCount(client);
    const divisionsInBatch = [...new Set(validRows.map((r) => r.division))];
    const { rows: existingCheck } = await client.query(
      `SELECT lower(sku) as sku_lower FROM products WHERE division = ANY($1::division_name[])`,
      [divisionsInBatch],
    );
    const existingSkuSet = new Set(existingCheck.map((r) => r.sku_lower));
    const newRowsCount = validRows.filter(
      (r) => !existingSkuSet.has(String(r.sku).trim().toLowerCase()),
    ).length;

    if (currentCount + newRowsCount > MAX_PRODUCTS) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: `Import would exceed max product cap (${MAX_PRODUCTS}). Currently ${currentCount}, trying to add ${newRowsCount} new SKUs.`,
      });
    }

        // ---- 1. Bulk upsert vendors (deduped, ONE query) ----
    const vendorPairs = new Set();
    validRows.forEach((r) => {
      if (r.vendor && String(r.vendor).trim()) {
        vendorPairs.add((r.division || "") + "||" + String(r.vendor).trim());
      }
    });
    if (vendorPairs.size > 0) {
      const vDivs = [],
        vNames = [];
      vendorPairs.forEach((p) => {
        const [d, n] = p.split("||");
        vDivs.push(d);
        vNames.push(n);
      });
      await client.query(
        `INSERT INTO vendors (division, vendor_name)
         SELECT * FROM unnest($1::division_name[], $2::text[]) ON CONFLICT DO NOTHING`,
        [vDivs, vNames],
      );
    }

    // ---- 1. Bulk upsert products (ONE query for the whole chunk) ----
    const divisions = [],
      skus = [],
      names = [],
      vendors = [],
      inwards = [],
      qtys = [],
      notes = [],
      setNos = [];
    validRows.forEach((r) => {
      divisions.push(r.division || null);
      skus.push(String(r.sku).trim());
      names.push(r.name || "");
      vendors.push(r.vendor ? String(r.vendor).trim() : null);
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
      [divisions, skus, names, vendors, inwards, qtys, notes, setNos],
    );

    const skuToId = {};
    upsertResult.rows.forEach((r) => {
      skuToId[r.division + "||" + r.sku.toLowerCase()] = r.id;
      r.inserted ? results.created++ : results.updated++;
    });

    // // ---- 2. Bulk upsert vendors (deduped, ONE query) ----
    // const vendorPairs = new Set();
    // validRows.forEach((r) => {
    //   if (r.vendor && String(r.vendor).trim()) {
    //     vendorPairs.add((r.division || "") + "||" + String(r.vendor).trim());
    //   }
    // });
    // if (vendorPairs.size > 0) {
    //   const vDivs = [],
    //     vNames = [];
    //   vendorPairs.forEach((p) => {
    //     const [d, n] = p.split("||");
    //     vDivs.push(d);
    //     vNames.push(n);
    //   });
    //   await client.query(
    //     `INSERT INTO vendors (division, vendor_name)
    //      SELECT * FROM unnest($1::division_name[], $2::text[]) ON CONFLICT DO NOTHING`,
    //     [vDivs, vNames],
    //   );
    // }

    // ---- 3. Bulk upsert stage_entries (ONE query for ALL stages of ALL rows) ----
    const pids = [],
      stageKeys = [],
      statuses = [],
      persons = [],
      commentsArr = [],
      widths = [],
      heights = [],
      weights = [];
    validRows.forEach((r) => {
      const key =
        (r.division || "") + "||" + String(r.sku).trim().toLowerCase();
      const productId = skuToId[key];
      if (!productId) {
        results.failed.push({ sku: r.sku, error: "product upsert failed" });
        return;
      }
      for (const s of STAGE_KEYS) {
        if (s === "finalqc") continue;
        const statusRaw = r[s + "_status"],
          person = r[s + "_person"] || "",
          comm = r[s + "_comments"] || "";
        const width =
          s === "dimensions"
            ? r.dimensions_width
              ? Number(r.dimensions_width)
              : null
            : null;
        const height =
          s === "dimensions"
            ? r.dimensions_height
              ? Number(r.dimensions_height)
              : null
            : null;
        const weight =
          s === "dimensions"
            ? r.dimensions_weight
              ? Number(r.dimensions_weight)
              : null
            : null;
                // Always push a row for every stage, even if this Excel row left the
        // stage's status/person/comments blank — otherwise a brand-new SKU
        // never gets a stage_entries row at all and silently disappears from
        // every stats query that reads stage_entries (pipelineBreakdown,
        // memberStats, allMemberStats, etc.) instead of showing as
        // "Not Started". A blank status here becomes null and is defaulted
        // to 'Not Started' at INSERT time — but only on first insert; if the
        // row already exists, the ON CONFLICT clause below still preserves
        // its current status instead of overwriting it back to Not Started.
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
         SELECT p, sk, COALESCE(st::stage_status, 'Not Started'::stage_status), pe, co, now(), w, h, wt
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
        [
          pids,
          stageKeys,
          statuses,
          persons,
          commentsArr,
          widths,
          heights,
          weights,
        ],
      );
    }

    // ---- 4. QC verdicts (ONE query) ----
    const qcIds = [],
      qcVerdicts = [],
      qcIssues = [];
    validRows.forEach((r) => {
      if (!r.qc_verdict) return;
      const key =
        (r.division || "") + "||" + String(r.sku).trim().toLowerCase();
      const productId = skuToId[key];
      if (!productId) return;
      const v = /appro/i.test(r.qc_verdict)
        ? "Approved"
        : /issue/i.test(r.qc_verdict)
          ? "Issues Found"
          : null;
      if (!v) return;
      qcIds.push(productId);
      qcVerdicts.push(v);
      qcIssues.push(r.qc_issues || "");
    });
    if (qcIds.length > 0) {
      await client.query(
        `UPDATE products p SET verdict = t.v, issues = t.iss, updated_at = now()
         FROM unnest($1::text[], $2::text[], $3::text[]) AS t(id, v, iss)
         WHERE p.id = t.id`,
        [qcIds, qcVerdicts, qcIssues],
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
  if (!division)
    return res.status(400).json({ ok: false, error: "division required" });
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
  if (!division)
    return res.status(400).json({ ok: false, error: "division required" });
  try {
    const { rows } = await pool.query(
      `
      SELECT se.stage_key, COUNT(*) AS issue_count
      FROM stage_entries se
      JOIN products p ON p.id = se.product_id
      WHERE p.division = $1
        AND (
          se.status = 'Issue'
          OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
        )
      GROUP BY se.stage_key
    `,
      [division],
    );

    const stages = {};
    rows.forEach((r) => {
      stages[r.stage_key] = Number(r.issue_count);
    });
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
// app.get("/api/pipelineBreakdown", async (req, res) => {
//   const { division, memberId, vendor, setNo } = req.query;
//   if (!division)
//     return res.status(400).json({ ok: false, error: "division required" });

//   try {
//     let rows;
//     if (memberId) {
//       // Scoped to one member's specific assigned stages on their assigned SKUs
//       const { rows: r } = await pool.query(
//         `
//         WITH member_scope AS (
//           SELECT DISTINCT p.id AS product_id, a.stage AS stage_key
//           FROM assignments a
//           JOIN products p
//             ON p.sku = a.sku AND p.division = a.division
//           WHERE a.member_id = $1
//             AND a.division = $2
//             AND ($3::text IS NULL OR p.vendor = $3)
//             AND ($4::text IS NULL OR p.set_no = $4)
//         )
//         SELECT
//           se.stage_key,
//           COUNT(*) FILTER (WHERE se.status = 'Not Started') AS not_started,
//           COUNT(*) FILTER (WHERE se.status = 'In Progress' AND se.comments NOT LIKE 'QC flagged:%') AS in_progress,
//           COUNT(*) FILTER (WHERE se.status = 'Completed') AS completed,
//           COUNT(*) FILTER (
//             WHERE se.status = 'Issue'
//                OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
//           ) AS issue
//         FROM member_scope ms
//         JOIN stage_entries se
//           ON se.product_id = ms.product_id AND se.stage_key = ms.stage_key
//         GROUP BY se.stage_key
//       `,
//         [memberId, division, vendor || null, setNo || null],
//       );
//       rows = r;
//     } else {
//       // Whole division (or vendor/setNo-narrowed), every stage on every product
//       const { rows: r } = await pool.query(
//         `
//         SELECT
//           se.stage_key,
//           COUNT(*) FILTER (WHERE se.status = 'Not Started') AS not_started,
//           COUNT(*) FILTER (WHERE se.status = 'In Progress' AND se.comments NOT LIKE 'QC flagged:%') AS in_progress,
//           COUNT(*) FILTER (WHERE se.status = 'Completed') AS completed,
//           COUNT(*) FILTER (
//             WHERE se.status = 'Issue'
//                OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
//           ) AS issue
//         FROM stage_entries se
//         JOIN products p ON p.id = se.product_id
//         WHERE p.division = $1
//           AND se.stage_key != 'finalqc'
//           AND ($2::text IS NULL OR p.vendor = $2)
//           AND ($3::text IS NULL OR p.set_no = $3)
//         GROUP BY se.stage_key
//       `,
//         [division, vendor || null, setNo || null],
//       );
//       rows = r;
//     }

//     const stages = {};
//     rows.forEach((r) => {
//       stages[r.stage_key] = {
//         notStarted: Number(r.not_started),
//         inProgress: Number(r.in_progress),
//         completed: Number(r.completed),
//         issue: Number(r.issue),
//       };
//     });
//     res.json({ ok: true, stages });
//   } catch (e) {
//     console.error("pipelineBreakdown error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });




// app.get("/api/pipelineBreakdown", async (req, res) => {
//   const { division, memberId, vendor, setNo } = req.query;
//   if (!division)
//     return res.status(400).json({ ok: false, error: "division required" });

//   try {
//     let rows;
//     if (memberId) {
//       const { rows: r } = await pool.query(
//         `
//         WITH member_scope AS (
//           SELECT DISTINCT p.id AS product_id, a.stage AS stage_key
//           FROM assignments a
//           JOIN products p
//             ON p.sku = a.sku AND p.division = a.division
//           WHERE a.member_id = $1
//             AND a.division = $2
//             AND ($3::text IS NULL OR p.vendor = $3)
//             AND ($4::text IS NULL OR p.set_no = $4)
//         )
//         SELECT
//           ms.stage_key,
//           COUNT(*) FILTER (WHERE COALESCE(se.status, 'Not Started') = 'Not Started') AS not_started,
//           COUNT(*) FILTER (WHERE se.status = 'In Progress' AND COALESCE(se.comments, '') NOT LIKE 'QC flagged:%') AS in_progress,
//           COUNT(*) FILTER (WHERE se.status = 'Completed') AS completed,
//           COUNT(*) FILTER (
//             WHERE se.status = 'Issue'
//                OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
//           ) AS issue
//         FROM member_scope ms
//         LEFT JOIN stage_entries se
//           ON se.product_id = ms.product_id AND se.stage_key = ms.stage_key
//         GROUP BY ms.stage_key
//       `,
//         [memberId, division, vendor || null, setNo || null],
//       );
//       rows = r;
//     } else {
//       const { rows: r } = await pool.query(
//         `
//         SELECT
//           se.stage_key,
//           COUNT(*) FILTER (WHERE se.status = 'Not Started') AS not_started,
//           COUNT(*) FILTER (WHERE se.status = 'In Progress' AND se.comments NOT LIKE 'QC flagged:%') AS in_progress,
//           COUNT(*) FILTER (WHERE se.status = 'Completed') AS completed,
//           COUNT(*) FILTER (
//             WHERE se.status = 'Issue'
//                OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
//           ) AS issue
//         FROM stage_entries se
//         JOIN products p ON p.id = se.product_id
//         WHERE p.division = $1
//           AND se.stage_key != 'finalqc'
//           AND ($2::text IS NULL OR p.vendor = $2)
//           AND ($3::text IS NULL OR p.set_no = $3)
//         GROUP BY se.stage_key
//       `,
//         [division, vendor || null, setNo || null],
//       );
//       rows = r;
//     }

//     const stages = {};
//     rows.forEach((r) => {
//       stages[r.stage_key] = {
//         notStarted: Number(r.not_started),
//         inProgress: Number(r.in_progress),
//         completed: Number(r.completed),
//         issue: Number(r.issue),
//       };
//     });
//     res.json({ ok: true, stages });
//   } catch (e) {
//     console.error("pipelineBreakdown error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });


app.get("/api/pipelineBreakdown", async (req, res) => {
  const { division, memberId, vendor, setNo } = req.query;
  if (!division)
    return res.status(400).json({ ok: false, error: "division required" });

  try {
    let rows;
    if (memberId) {
      const { rows: r } = await pool.query(
        `
        WITH member_scope AS (
          SELECT DISTINCT p.id AS product_id, a.stage AS stage_key, p.vendor AS vendor
          FROM assignments a
          JOIN products p
            ON p.sku = a.sku AND p.division = a.division
          WHERE a.member_id = $1
            AND a.division = $2
            AND ($3::text IS NULL OR p.vendor = $3)
            AND ($4::text IS NULL OR p.set_no = $4)
        )
        SELECT
          ms.stage_key,
          ms.vendor,
          COUNT(*) FILTER (WHERE COALESCE(se.status, 'Not Started') = 'Not Started') AS not_started,
          COUNT(*) FILTER (WHERE se.status = 'In Progress' AND COALESCE(se.comments, '') NOT LIKE 'QC flagged:%') AS in_progress,
          COUNT(*) FILTER (WHERE se.status = 'Completed') AS completed,
          COUNT(*) FILTER (
            WHERE se.status = 'Issue'
               OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
          ) AS issue
        FROM member_scope ms
        LEFT JOIN stage_entries se
          ON se.product_id = ms.product_id AND se.stage_key = ms.stage_key
        GROUP BY ms.stage_key, ms.vendor
        ORDER BY ms.vendor, ms.stage_key
      `,
        [memberId, division, vendor || null, setNo || null],
      );
      rows = r;
    } else {
      const { rows: r } = await pool.query(
        `
        SELECT
          se.stage_key,
          p.vendor AS vendor,
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
        GROUP BY se.stage_key, p.vendor
        ORDER BY p.vendor, se.stage_key
      `,
        [division, vendor || null, setNo || null],
      );
      rows = r;
    }

    // Two shapes returned together:
    // 1. `stages`   — same as before, aggregated across all vendors (backward compatible)
    // 2. `byVendor` — new: { vendorName: { stageKey: {...} } }
    const stages = {};
    const byVendor = {};

    rows.forEach((r) => {
      const vendorKey = r.vendor || "—";
      const cell = {
        notStarted: Number(r.not_started),
        inProgress: Number(r.in_progress),
        completed: Number(r.completed),
        issue: Number(r.issue),
      };

      // Aggregate view (sums across vendors per stage)
      if (!stages[r.stage_key]) {
        stages[r.stage_key] = { notStarted: 0, inProgress: 0, completed: 0, issue: 0 };
      }
      stages[r.stage_key].notStarted += cell.notStarted;
      stages[r.stage_key].inProgress += cell.inProgress;
      stages[r.stage_key].completed += cell.completed;
      stages[r.stage_key].issue += cell.issue;

      // Per-vendor breakdown
      if (!byVendor[vendorKey]) byVendor[vendorKey] = {};
      byVendor[vendorKey][r.stage_key] = cell;
    });

    res.json({ ok: true, stages, byVendor });
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
  if (!division)
    return res.status(400).json({ ok: false, error: "division required" });
  try {
    const { rows } = await pool.query(
      `SELECT entity, detail, logged_at FROM audit_log
       WHERE action = 'Stage update' AND division = $1
       ORDER BY entity, logged_at ASC`,
      [division],
    );

    // entity+stage -> { firstInProgress, firstCompleted }
    const track = {};
    rows.forEach((r) => {
      const m = String(r.detail || "").match(/^(.+?)\s*→\s*([^·]+?)(?:\s*·|$)/);
      if (!m) return;
      const stageName = m[1].trim();
      const status = m[2].trim();
      const key = r.entity + "||" + stageName;
      if (!track[key])
        track[key] = { stageName, firstInProgress: null, firstCompleted: null };
      const t = track[key];
      if (status === "In Progress" && !t.firstInProgress)
        t.firstInProgress = r.logged_at;
      if (status === "Completed" && !t.firstCompleted && t.firstInProgress)
        t.firstCompleted = r.logged_at;
    });

    const byStage = {};
    Object.values(track).forEach((t) => {
      if (!t.firstInProgress || !t.firstCompleted) return;
      const hours =
        (new Date(t.firstCompleted) - new Date(t.firstInProgress)) / 3600000;
      if (hours < 0 || hours > 24 * 60) return; // discard bad/outlier data
      (byStage[t.stageName] ||= []).push(hours);
    });

    const stats = Object.entries(byStage)
      .map(([stageName, durations]) => ({
        stageName,
        avgHours: durations.reduce((a, b) => a + b, 0) / durations.length,
        sampleCount: durations.length,
      }))
      .sort((a, b) => a.avgHours - b.avgHours);

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
  if (!division)
    return res.status(400).json({ ok: false, error: "division required" });
  try {
    const { rows } = await pool.query(
      `SELECT entity, detail, logged_at, actor_name FROM audit_log
       WHERE action = 'Stage update' AND division = $1
       ORDER BY entity, logged_at ASC`,
      [division],
    );

    const lastInProgress = {}; // "sku||stageName" -> timestamp
    const byMember = {}; // person name -> accumulator

    const touch = (name) =>
      (byMember[name] ||= {
        durations: [],
        completions: 0,
        issues: 0,
        byStage: {},
      });

    rows.forEach((r) => {
      const m = String(r.detail || "").match(
        /^(.+?)\s*→\s*([^·]+?)(?:\s*·\s*(.+))?$/,
      );
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

    const members = Object.entries(byMember)
      .map(([name, m]) => {
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
          issueRate:
            m.completions + m.issues
              ? m.issues / (m.completions + m.issues)
              : 0,
          fastestStage: stageBreakdown[0] || null,
          slowestStage: stageBreakdown[stageBreakdown.length - 1] || null,
          stageBreakdown,
        };
      })
      .filter((x) => x.completions > 0)
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
const TEAM_BACKEND_STAGE_KEYS = [
  "content",
  "dimensions",
  "images",
  "backend",
  "website",
];
const TEAM_PHOTO_STAGE_KEYS = [
  "photography",
  "photoedit",
  "videography",
  "videoedit",
];

app.get("/api/teamStageStats", async (req, res) => {
  const { division, vendor, set_no, dateFrom, dateTo } = req.query;
  if (!division)
    return res.status(400).json({ ok: false, error: "division required" });

  try {
    const allStageKeys = [...TEAM_BACKEND_STAGE_KEYS, ...TEAM_PHOTO_STAGE_KEYS];

    const { rows: userRows } = await pool.query(
      `SELECT id, manager_id FROM users`,
    );
    const managerIdOf = {};
    userRows.forEach((u) => {
      managerIdOf[u.id] = u.manager_id;
    });
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
      params,
    );
    const buildGroup = (stageKeys) => {
      const byMember = {};
      rows.forEach((r) => {
        if (!stageKeys.includes(r.stage)) return;
        const acc = (byMember[r.member_id] ||= {
          memberName: r.member_name,
          skus: new Set(),
          skuStage: {},
        });

        acc.skus.add(r.sku);
        // Remember status per sku+stage instead of tallying immediately —
        // we don't yet know which skus will survive the manager/report subtraction.
        (acc.skuStage[r.sku] ||= {})[r.stage] = r.stage_status;
      });

      // Subtract reports' skus from their manager's set — same as totalAssigned.
      Object.keys(byMember).forEach((managerId) => {
        const reportIds = Object.keys(byMember).filter(
          (id) => managerIdOf[id] === managerId,
        );
        if (reportIds.length === 0) return;
        const managerSkus = byMember[managerId].skus;
        reportIds.forEach((repId) => {
          byMember[repId].skus.forEach((sku) => managerSkus.delete(sku));
        });
      });

      return Object.entries(byMember)
        .map(([memberId, m]) => {
          const perStage = stageKeys.reduce(
            (o, k) => ({ ...o, [k]: { completed: 0, pending: 0, issue: 0 } }),
            {},
          );
          m.skus.forEach((sku) => {
            const stagesForSku = m.skuStage[sku] || {};
            stageKeys.forEach((stageKey) => {
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
          stageKeys.forEach((k) => {
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
  const { division, completedFrom, completedTo, vendor } = req.query;

  try {
    const { rows } = await pool.query(
      `
      WITH target_assignments AS (
          SELECT DISTINCT a.member_id, a.manager_id, a.division, a.stage AS assigned_stage,
                p.id AS product_id, a.sku, a.assigned_at
          FROM assignments a
          JOIN products p ON p.sku = a.sku AND p.division = a.division
          WHERE a.division IN ('KOC Cards', 'Bombay Cards')
            AND ($1::division_name IS NULL OR a.division = $1::division_name)
            AND ($4::text IS NULL OR p.vendor = $4::text)
      ),
      pushed AS (
          SELECT DISTINCT manager_id, division, assigned_stage, sku
          FROM target_assignments
          WHERE manager_id IS NOT NULL AND manager_id != member_id
      ),
      effective AS (
          SELECT DISTINCT ta.member_id, ta.division, ta.assigned_stage, ta.product_id, ta.sku, ta.assigned_at
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
              MAX(e.assigned_at) AS last_assigned_at,
              -- Completion is the only thing that gets date-scoped. When
              -- $2/$3 are NULL (no filter set), the range check is skipped
              -- entirely, so this behaves exactly like the live/unfiltered
              -- query did before.
              MAX(se.updated_at) FILTER (
                  WHERE se.status = 'Completed'
                    AND ($2::timestamptz IS NULL OR se.updated_at >= $2::timestamptz)
                    AND ($3::timestamptz IS NULL OR se.updated_at < $3::timestamptz)
              ) AS last_completed_at,
              COUNT(DISTINCT e.sku) AS assigned_skus,
              COUNT(DISTINCT e.sku) FILTER (
                  WHERE se.status = 'Completed'
                    AND ($2::timestamptz IS NULL OR se.updated_at >= $2::timestamptz)
                    AND ($3::timestamptz IS NULL OR se.updated_at < $3::timestamptz)
              ) AS completed_skus,
              -- Pending/issue always reflect the current live state — these
              -- are "right now" concepts, not date-windowed ones.
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
          ps.last_assigned_at,
          ps.last_completed_at,
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
      [
        division || null,
        completedFrom || null,
        completedTo || null,
        vendor || null,
      ],
    );

    // Reshape flat rows into a nested per-member structure, same spirit
    // as your other stats endpoints (allMemberStats / teamStageStats).
    const byKey = {};
    rows.forEach((r) => {
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
        assignedAt: r.last_assigned_at
          ? new Date(r.last_assigned_at).toISOString()
          : null,
        completedAt: r.last_completed_at
          ? new Date(r.last_completed_at).toISOString()
          : null,
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

/* ----------------------------------------------------------------
   GET /api/memberDailyActivity?person=dharani&division=KOC Cards&from=2026-08-24&to=2026-08-27
   Day-by-day completed-stage activity for one person, based on who
   actually touched the row (stage_entries.person), not assignments.
---------------------------------------------------------------- */
app.get("/api/memberDailyActivity", async (req, res) => {
  const { person, division, from, to } = req.query;
  if (!person)
    return res.status(400).json({ ok: false, error: "person required" });
  try {
    const { rows } = await pool.query(
      `SELECT
         date_trunc('day', se.updated_at) AS work_date,
         se.stage_key,
         COUNT(*) AS completed_count,
         array_agg(p.sku ORDER BY se.updated_at) AS skus
       FROM stage_entries se
       JOIN products p ON p.id = se.product_id
       WHERE se.person ILIKE $1
         AND se.status = 'Completed'
         AND ($2::division_name IS NULL OR p.division = $2::division_name)
         AND ($3::timestamptz IS NULL OR se.updated_at >= $3::timestamptz)
         AND ($4::timestamptz IS NULL OR se.updated_at < $4::timestamptz)
       GROUP BY work_date, se.stage_key
       ORDER BY work_date, se.stage_key`,
      [person, division || null, from || null, to || null],
    );
    res.json({
      ok: true,
      rows: rows.map((r) => ({
        date: r.work_date.toISOString().slice(0, 10),
        stage: r.stage_key,
        completed: Number(r.completed_count),
        skus: r.skus,
      })),
    });
  } catch (e) {
    console.error("memberDailyActivity error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   GET /api/teamStageActivity?division=KOC Cards&from=2026-08-24&to=2026-08-27
   Per-member, per-stage COMPLETED counts within a date range, based on
   who actually completed the work (stage_entries.person + updated_at).
   Used by Speed Analytics > Full Breakdown when a date filter is active.
---------------------------------------------------------------- */
app.get("/api/teamStageActivity", async (req, res) => {
  const { division, from, to } = req.query;
  if (!division)
    return res.status(400).json({ ok: false, error: "division required" });
  try {
    const { rows } = await pool.query(
      `SELECT
         se.person AS member_name,
         se.stage_key,
         COUNT(*) AS completed_count
       FROM stage_entries se
       JOIN products p ON p.id = se.product_id
       WHERE p.division = $1
         AND se.status = 'Completed'
         AND se.person IS NOT NULL AND se.person != ''
         AND ($2::timestamptz IS NULL OR se.updated_at >= $2::timestamptz)
         AND ($3::timestamptz IS NULL OR se.updated_at < $3::timestamptz)
       GROUP BY se.person, se.stage_key
       ORDER BY se.person, se.stage_key`,
      [division, from || null, to || null],
    );

    // Distinct cards touched per person in this window — a card counted once
    // even if the person completed multiple stages on it.
    const { rows: totalsRows } = await pool.query(
      `SELECT se.person AS member_name, COUNT(DISTINCT p.id) AS total_cards
       FROM stage_entries se
       JOIN products p ON p.id = se.product_id
       WHERE p.division = $1
         AND se.status = 'Completed'
         AND se.person IS NOT NULL AND se.person != ''
         AND ($2::timestamptz IS NULL OR se.updated_at >= $2::timestamptz)
         AND ($3::timestamptz IS NULL OR se.updated_at < $3::timestamptz)
       GROUP BY se.person`,
      [division, from || null, to || null],
    );
    const totalsByPerson = {};
    totalsRows.forEach((r) => {
      totalsByPerson[r.member_name] = Number(r.total_cards);
    });

    const byMember = {};
    rows.forEach((r) => {
      if (!byMember[r.member_name]) {
        byMember[r.member_name] = {
          memberName: r.member_name,
          totalCards: totalsByPerson[r.member_name] || 0,
          stages: [],
        };
      }
      byMember[r.member_name].stages.push({
        stage: r.stage_key,
        completedSkus: Number(r.completed_count),
        inProgressSkus: 0,
        notStartedSkus: 0,
        issueSkus: 0,
      });
    });

    res.json({ ok: true, members: Object.values(byMember) });
  } catch (e) {
    console.error("teamStageActivity error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/store-list", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT store_name FROM store_list ORDER BY store_name",
    );
    res.json({ ok: true, stores: rows.map((r) => r.store_name) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   GET /api/store-list — for populating the branch dropdown
---------------------------------------------------------------- */
app.get("/api/store-list", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT store_name FROM store_list ORDER BY store_name",
    );
    res.json({ ok: true, stores: rows.map((r) => r.store_name) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   POST /api/dispatch/admin-upload — admin's reference set (set_number = 1)
   body: { division, vendor, batchLabel, uploadedBy, filename, skus: [{sku, qty}] }
---------------------------------------------------------------- */
app.post("/api/dispatch/admin-upload", async (req, res) => {
  const { division, vendor, batchLabel, setLabel, branchName, uploadedBy, filename, skus } = req.body;
  if (!division || !vendor || !batchLabel || !setLabel || !branchName || !Array.isArray(skus) || skus.length === 0) {
    return res.status(400).json({ ok: false, error: "division, vendor, batchLabel, setLabel, branchName and skus[] required" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: vcheck } = await client.query("SELECT 1 FROM vendors WHERE division=$1 AND vendor_name=$2", [division, vendor]);
    if (!vcheck.length) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: `Vendor "${vendor}" not found.` }); }
    const { rows: scheck } = await client.query("SELECT 1 FROM store_list WHERE store_name=$1", [branchName]);
    if (!scheck.length) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: `Unknown branch "${branchName}".` }); }

    const { rows: batchRows } = await client.query(
      `INSERT INTO dispatch_batches (division, vendor, batch_label, set_label, branch_name, source, uploaded_by, source_filename)
       VALUES ($1,$2,$3,$4,$5,'dispatched',$6,$7)
       ON CONFLICT (division, vendor, batch_label, set_label, branch_name, source)
       DO UPDATE SET uploaded_by=$6, source_filename=$7, updated_at=now()
       RETURNING id`,
      [division, vendor, batchLabel, setLabel, branchName, uploadedBy || "Unattributed", filename || null]
    );
    const batchId = batchRows[0].id;

    const counts = {};
    skus.forEach(s => { const k = String(s.sku || s).trim(); if (k) counts[k] = (counts[k] || 0) + (Number(s.qty) || 1); });
    const skuList = Object.keys(counts), qtyList = skuList.map(s => counts[s]);

    if (skuList.length > 0) {
      await client.query(
        `INSERT INTO dispatch_batch_items (batch_id, sku, qty, scan_count, first_scanned_at, last_scanned_at)
         SELECT $1, s, q, q, now(), now() FROM unnest($2::text[], $3::int[]) AS t(s,q)
         ON CONFLICT (batch_id, sku) DO UPDATE SET
           scan_count = dispatch_batch_items.scan_count + EXCLUDED.scan_count,
           last_scanned_at = now()`,
        [batchId, skuList, qtyList]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true, batchId, skuCount: skuList.length });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("admin-upload error", e);
    res.status(500).json({ ok: false, error: e.message });
  } finally { client.release(); }
});
/* ----------------------------------------------------------------
   POST /api/dispatch/branch-upload — branch's received set (auto set_number)
   body: { division, vendor, batchLabel, branchName, uploadedBy, filename, skus: [{sku, qty}] }
---------------------------------------------------------------- */
app.post("/api/dispatch/branch-upload", async (req, res) => {
  const {
    division,
    vendor,
    batchLabel,
    branchName,
    uploadedBy,
    filename,
    skus,
  } = req.body;
  if (
    !division ||
    !vendor ||
    !batchLabel ||
    !branchName ||
    !Array.isArray(skus) ||
    skus.length === 0 
  ) {
    return res.status(400).json({
      ok: false,
      error: "division, vendor, batchLabel, branchName and skus[] required",
    });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: vcheck } = await client.query(
      "SELECT 1 FROM vendors WHERE division = $1 AND vendor_name = $2",
      [division, vendor],
    );
    if (vcheck.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: `Vendor "${vendor}" not found for ${division}.`,
      });
    }
    const { rows: scheck } = await client.query(
      "SELECT 1 FROM store_list WHERE store_name = $1",
      [branchName],
    );
    if (scheck.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ ok: false, error: `Unknown branch "${branchName}".` });
    }

    const { rows: existing } = await client.query(
      `SELECT id, set_number FROM dispatch_batches
       WHERE division=$1 AND vendor=$2 AND batch_label=$3 AND branch_name=$4`,
      [division, vendor, batchLabel, branchName],
    );

    let batchId, setNumber;
    if (existing.length > 0) {
      batchId = existing[0].id;
      setNumber = existing[0].set_number;
      await client.query(
        `UPDATE dispatch_batches SET uploaded_by=$2, source_filename=$3, updated_at=now() WHERE id=$1`,
        [batchId, uploadedBy || "Unattributed", filename || null],
      );
    } else {
      const { rows: maxRow } = await client.query(
        `SELECT COALESCE(MAX(set_number), 1) AS mx FROM dispatch_batches
         WHERE division=$1 AND vendor=$2 AND batch_label=$3`,
        [division, vendor, batchLabel],
      );
      setNumber = Number(maxRow[0].mx) + 1;
      const { rows: ins } = await client.query(
        `INSERT INTO dispatch_batches (division, vendor, batch_label, set_number, branch_name, uploaded_by, source_filename)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          division,
          vendor,
          batchLabel,
          setNumber,
          branchName,
          uploadedBy || "Unattributed",
          filename || null,
        ],
      );
      batchId = ins[0].id;
    }

    await client.query("DELETE FROM dispatch_batch_items WHERE batch_id = $1", [
      batchId,
    ]);
    const cleanSkus = [
      ...new Set(skus.map((s) => String(s.sku || s).trim()).filter(Boolean)),
    ];
    const qtyMap = {};
    skus.forEach((s) => {
      const k = String(s.sku || s).trim();
      if (k) qtyMap[k] = Number(s.qty) || 1;
    });
    if (cleanSkus.length > 0) {
      await client.query(
        `INSERT INTO dispatch_batch_items (batch_id, sku, qty)
         SELECT $1, s, q FROM unnest($2::text[], $3::int[]) AS t(s, q)`,
        [batchId, cleanSkus, cleanSkus.map((s) => qtyMap[s] || 1)],
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true, batchId, setNumber, skuCount: cleanSkus.length });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("branch-upload error", e);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

/* ----------------------------------------------------------------
   GET /api/dispatch/comparison?division=&vendor=&batchLabel=
---------------------------------------------------------------- */
app.get("/api/dispatch/comparison", async (req, res) => {
  const { division, vendor, batchLabel, setLabel, branchName } = req.query;
  if (!division || !vendor || !batchLabel) return res.status(400).json({ ok: false, error: "division, vendor, batchLabel required" });
  try {
    const { rows } = await pool.query(
      `SELECT b.branch_name, b.source, b.uploaded_by, b.uploaded_at,
              array_agg(DISTINCT i.sku) FILTER (WHERE i.sku IS NOT NULL) AS skus
       FROM dispatch_batches b
       LEFT JOIN dispatch_batch_items i ON i.batch_id = b.id
       WHERE b.division=$1 AND b.vendor=$2 AND b.batch_label=$3
         AND ($4::text IS NULL OR b.set_label = $4)
         AND ($5::text IS NULL OR b.branch_name = $5)
       GROUP BY b.branch_name, b.source, b.uploaded_by, b.uploaded_at`,
      [division, vendor, batchLabel, setLabel || null, branchName || null]
    );

    const byBranch = {};
    rows.forEach(r => { (byBranch[r.branch_name] ||= {})[r.source] = r; });

    const results = Object.entries(byBranch).map(([branch, sides]) => {
      const dispatched = new Set((sides.dispatched?.skus || []).map(s => s.toLowerCase()));
      const received = new Set((sides.received?.skus || []).map(s => s.toLowerCase()));
      const missing = [...dispatched].filter(s => !received.has(s));
      const extra = [...received].filter(s => !dispatched.has(s));
      return {
        branchName: branch,
        dispatchedCount: dispatched.size,
        receivedCount: received.size,
        matched: dispatched.size - missing.length,
        missingSkus: missing,
        extraSkus: extra,
        allMatching: !!sides.dispatched && !!sides.received && missing.length === 0 && extra.length === 0,
        hasDispatch: !!sides.dispatched,
        hasReceipt: !!sides.received,
        dispatchedAt: sides.dispatched?.uploaded_at || null,
        receivedAt: sides.received?.uploaded_at || null,
      };
    });

    res.json({ ok: true, branches: results });
  } catch (e) {
    console.error("comparison error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   GET /api/dispatch/groups?division=
---------------------------------------------------------------- */
app.get("/api/dispatch/groups", async (req, res) => {
  const { division } = req.query;
  if (!division) return res.status(400).json({ ok: false, error: "division required" });
  try {
    const { rows } = await pool.query(
      `SELECT vendor, batch_label,
              COUNT(DISTINCT branch_name) FILTER (WHERE source = 'dispatched') AS dispatched_branches,
              COUNT(DISTINCT branch_name) FILTER (WHERE source = 'received') AS received_branches
       FROM dispatch_batches WHERE division = $1
       GROUP BY vendor, batch_label ORDER BY vendor, batch_label DESC`,
      [division]
    );
    res.json({ ok: true, groups: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});



/* ----------------------------------------------------------------
   GET /api/dispatch/batch-labels?division=&vendor=
   Distinct batch labels already used for this vendor — dropdown source.
---------------------------------------------------------------- */
app.get("/api/dispatch/batch-labels", async (req, res) => {
  const { division, vendor } = req.query;
  if (!division || !vendor) return res.status(400).json({ ok: false, error: "division and vendor required" });
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT batch_label FROM dispatch_batches WHERE division=$1 AND vendor=$2 ORDER BY batch_label DESC`,
      [division, vendor]
    );
    res.json({ ok: true, batchLabels: rows.map(r => r.batch_label) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


/* ----------------------------------------------------------------
   GET /api/dispatch/set-labels?division=&vendor=&batchLabel=&branchName=
   Distinct set labels that have a 'dispatched' row for this batch —
   used so a branch scanning "received" only ever sees sets that were
   actually sent to them, never sets that don't exist yet.
   branchName is optional: omit for the admin panel (all sets in the
   batch), pass it for a branch's own scan screen (only sets sent to them).
---------------------------------------------------------------- */
app.get("/api/dispatch/set-labels", async (req, res) => {
  const { division, vendor, batchLabel, branchName } = req.query;
  if (!division || !vendor || !batchLabel) {
    return res.status(400).json({ ok: false, error: "division, vendor, batchLabel required" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT set_label FROM dispatch_batches
       WHERE division=$1 AND vendor=$2 AND batch_label=$3 AND source='dispatched'
         AND ($4::text IS NULL OR branch_name = $4)
       ORDER BY set_label ASC`,
      [division, vendor, batchLabel, branchName || null]
    );
    res.json({ ok: true, setLabels: rows.map(r => r.set_label) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   GET /api/dispatch/set-summary?division=&vendor=&batchLabel=
   Set-by-set view: which branches a set was dispatched to, and
   whether each has confirmed receipt yet. Used for the admin panel's
   "dispatched to" breakdown.
---------------------------------------------------------------- */
app.get("/api/dispatch/set-summary", async (req, res) => {
  const { division, vendor, batchLabel } = req.query;
  if (!division || !vendor || !batchLabel) {
    return res.status(400).json({ ok: false, error: "division, vendor, batchLabel required" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT set_label, branch_name, source, uploaded_at,
              (SELECT COUNT(*) FROM dispatch_batch_items i WHERE i.batch_id = b.id) AS sku_count
       FROM dispatch_batches b
       WHERE division=$1 AND vendor=$2 AND batch_label=$3
       ORDER BY set_label, branch_name, source`,
      [division, vendor, batchLabel]
    );

    const bySet = {};
    rows.forEach(r => {
      const set = (bySet[r.set_label] ||= {});
      const branch = (set[r.branch_name] ||= {});
      branch[r.source] = { uploadedAt: r.uploaded_at, skuCount: Number(r.sku_count) };
    });

    const sets = Object.entries(bySet).map(([setLabel, branches]) => ({
      setLabel,
      branches: Object.entries(branches).map(([branchName, sides]) => ({
        branchName,
        dispatchedAt: sides.dispatched?.uploadedAt || null,
        dispatchedCount: sides.dispatched?.skuCount || 0,
        receivedAt: sides.received?.uploadedAt || null,
        receivedCount: sides.received?.skuCount || 0,
        status: !sides.dispatched ? "not_dispatched" : !sides.received ? "awaiting_receipt" : "received",
      })),
    }));

    res.json({ ok: true, sets });
  } catch (e) {
    console.error("set-summary error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
/* ----------------------------------------------------------------
   DELETE /api/dispatch/batch   body: { batchId }
   Removes one batch (admin reference OR a specific branch upload)
   and all its SKU items. Use to fix mistakes like wrong branch/vendor.
---------------------------------------------------------------- */
app.post("/api/dispatch/delete-batch", async (req, res) => {
  const { batchId } = req.body;
  if (!batchId)
    return res.status(400).json({ ok: false, error: "batchId required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM dispatch_batch_items WHERE batch_id = $1", [
      batchId,
    ]);
    const { rows } = await client.query(
      "DELETE FROM dispatch_batches WHERE id = $1 RETURNING *",
      [batchId],
    );
    await client.query("COMMIT");
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Batch not found" });
    res.json({ ok: true, deleted: rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("delete-batch error", e);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

/* ----------------------------------------------------------------
   GET /api/dispatch/batches?division=&vendor=&batchLabel=
   Lists every set (admin ref + all branches) for a batch, with ids
   so the frontend can offer delete/manage actions.
---------------------------------------------------------------- */
app.get("/api/dispatch/batches", async (req, res) => {
  const { division, vendor, batchLabel } = req.query;
  if (!division || !vendor || !batchLabel)
    return res.status(400).json({ ok: false, error: "division, vendor, batchLabel required" });
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.branch_name, b.source, b.uploaded_by, b.uploaded_at,
              COUNT(i.sku) AS sku_count,
              COALESCE(SUM(i.scan_count), 0) AS total_scans
       FROM dispatch_batches b
       LEFT JOIN dispatch_batch_items i ON i.batch_id = b.id
       WHERE b.division=$1 AND b.vendor=$2 AND b.batch_label=$3
       GROUP BY b.id
       ORDER BY b.branch_name ASC, b.source ASC`,
      [division, vendor, batchLabel]
    );
    res.json({ ok: true, batches: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   POST /api/dispatch/rename-batch
   body: { division, vendor, oldBatchLabel, newBatchLabel }
   Renames every set (admin ref + all branches) under one batch label
   at once, since they're grouped together by (division, vendor, batch_label).
---------------------------------------------------------------- */
app.post("/api/dispatch/rename-batch", async (req, res) => {
  const { division, vendor, oldBatchLabel, newBatchLabel } = req.body;
  if (!division || !vendor || !oldBatchLabel || !newBatchLabel) {
    return res.status(400).json({
      ok: false,
      error: "division, vendor, oldBatchLabel, newBatchLabel required",
    });
  }
  if (oldBatchLabel === newBatchLabel) {
    return res
      .status(400)
      .json({ ok: false, error: "New label is the same as the old one" });
  }
  try {
    // Prevent silently merging into an already-existing different batch
    const { rows: clash } = await pool.query(
      `SELECT 1 FROM dispatch_batches WHERE division=$1 AND vendor=$2 AND batch_label=$3 LIMIT 1`,
      [division, vendor, newBatchLabel],
    );
    if (clash.length > 0) {
      return res.status(400).json({
        ok: false,
        error: `A batch named "${newBatchLabel}" already exists for this vendor — pick a different name or delete it first.`,
      });
    }
    const { rows } = await pool.query(
      `UPDATE dispatch_batches SET batch_label = $4, updated_at = now()
       WHERE division=$1 AND vendor=$2 AND batch_label=$3
       RETURNING id`,
      [division, vendor, oldBatchLabel, newBatchLabel],
    );
    res.json({ ok: true, renamed: rows.length });
  } catch (e) {
    console.error("rename-batch error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});


app.post("/api/dispatch/scan-undo", async (req, res) => {
  const { batchId, sku } = req.body;
  if (!batchId || !sku) return res.status(400).json({ ok: false, error: "batchId and sku required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE dispatch_batch_items SET scan_count = scan_count - 1, last_scanned_at = now()
       WHERE batch_id=$1 AND sku=$2 AND scan_count > 0
       RETURNING scan_count`,
      [batchId, sku]
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Item not found" });
    }
    let scanCount = rows[0].scan_count;
    let removed = false;
    if (scanCount <= 0) {
      await client.query(`DELETE FROM dispatch_batch_items WHERE batch_id=$1 AND sku=$2`, [batchId, sku]);
      removed = true;
    }
    await client.query("COMMIT");
    res.json({ ok: true, scanCount, removed });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("scan-undo error", e);
    res.status(500).json({ ok: false, error: e.message });
  } finally { client.release(); }
});




app.post("/api/dispatch/scan", async (req, res) => {
  const { division, vendor, batchLabel, setLabel, branchName, source, sku, scannedBy } = req.body;
  if (!division || !vendor || !batchLabel || !setLabel || !branchName || !source || !sku) {
    return res.status(400).json({ ok: false, error: "division, vendor, batchLabel, setLabel, branchName, source, sku required" });
  }
  if (!["dispatched", "received"].includes(source)) {
    return res.status(400).json({ ok: false, error: "source must be 'dispatched' or 'received'" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: vcheck } = await client.query("SELECT 1 FROM vendors WHERE division=$1 AND vendor_name=$2", [division, vendor]);
    if (!vcheck.length) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: `Vendor "${vendor}" not found.` }); }
    const { rows: scheck } = await client.query("SELECT 1 FROM store_list WHERE store_name=$1", [branchName]);
    if (!scheck.length) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: `Unknown branch "${branchName}".` }); }

    // Branch scanning "received" against a set that was never dispatched to
    // them is almost certainly a mistake — block it early with a clear error.
    if (source === "received") {
      const { rows: dcheck } = await client.query(
        `SELECT id FROM dispatch_batches
         WHERE division=$1 AND vendor=$2 AND batch_label=$3 AND set_label=$4 AND branch_name=$5 AND source='dispatched'`,
        [division, vendor, batchLabel, setLabel, branchName]
      );
      if (!dcheck.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, error: `${setLabel} was never dispatched to ${branchName} for this batch.` });
      }

      // NEW: the scanned SKU must actually be part of what was dispatched
      // for this set/branch — not just "something" was dispatched.
      const dispatchedBatchId = dcheck[0].id;
      const { rows: skuCheck } = await client.query(
        `SELECT 1 FROM dispatch_batch_items WHERE batch_id=$1 AND sku ILIKE $2`,
        [dispatchedBatchId, String(sku).trim()]
      );
      if (!skuCheck.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          error: `SKU "${sku}" was not part of the dispatched list for ${setLabel} → ${branchName}.`,
        });
      }
    }

    let { rows: batchRows } = await client.query(
      `SELECT id FROM dispatch_batches WHERE division=$1 AND vendor=$2 AND batch_label=$3 AND set_label=$4 AND branch_name=$5 AND source=$6`,
      [division, vendor, batchLabel, setLabel, branchName, source]
    );
    let batchId;
    if (batchRows.length === 0) {
      const ins = await client.query(
        `INSERT INTO dispatch_batches (division, vendor, batch_label, set_label, branch_name, source, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [division, vendor, batchLabel, setLabel, branchName, source, scannedBy || "Unattributed"]
      );
      batchId = ins.rows[0].id;
    } else {
      batchId = batchRows[0].id;
      await client.query(`UPDATE dispatch_batches SET updated_at=now(), uploaded_by=$2 WHERE id=$1`, [batchId, scannedBy || "Unattributed"]);
    }

    const cleanSku = String(sku).trim();
    const { rows: upsert } = await client.query(
      `INSERT INTO dispatch_batch_items (batch_id, sku, qty, scan_count, first_scanned_at, last_scanned_at)
       VALUES ($1,$2,1,1,now(),now())
       ON CONFLICT (batch_id, sku) DO UPDATE SET
         scan_count = dispatch_batch_items.scan_count + 1,
         last_scanned_at = now()
       RETURNING scan_count`,
      [batchId, cleanSku]
    );
    const scanCount = upsert[0].scan_count;

    const { rows: totals } = await client.query(
      `SELECT COUNT(*) AS unique_skus, COALESCE(SUM(scan_count),0) AS total_scans FROM dispatch_batch_items WHERE batch_id=$1`,
      [batchId]
    );

    await client.query("COMMIT");
    res.json({
      ok: true, batchId, sku: cleanSku,
      scanCount, isDuplicate: scanCount > 1,
      uniqueSkus: Number(totals[0].unique_skus),
      totalScans: Number(totals[0].total_scans),
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("dispatch/scan error", e);
    res.status(500).json({ ok: false, error: e.message });
  } finally { client.release(); }
});


app.get("/api/dispatch/scan-log", async (req, res) => {
  const { division, vendor, batchLabel, setLabel, branchName, source } = req.query;
  if (!division || !vendor || !batchLabel || !setLabel || !branchName || !source) {
    return res.status(400).json({ ok: false, error: "all params required" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT i.sku, i.scan_count, i.first_scanned_at, i.last_scanned_at, b.id AS batch_id
       FROM dispatch_batch_items i
       JOIN dispatch_batches b ON b.id = i.batch_id
       WHERE b.division=$1 AND b.vendor=$2 AND b.batch_label=$3 AND b.set_label=$4 AND b.branch_name=$5 AND b.source=$6
       ORDER BY i.last_scanned_at DESC`,
      [division, vendor, batchLabel, setLabel, branchName, source]
    );
    res.json({ ok: true, items: rows, batchId: rows.length ? rows[0].batch_id : null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


/* ----------------------------------------------------------------
   GET /api/dispatch/branch-pending?division=&branchName=
   Every batch dispatched TO this branch, with whether it's been
   received yet and when it was dispatched — powers the Branch Upload
   dashboard so the branch can see what's waiting on them.
---------------------------------------------------------------- */
/* ----------------------------------------------------------------
   GET /api/dispatch/branch-pending?division=&branchName=
   Every batch dispatched TO this branch, with how many SKUs are
   still pending (dispatched but not yet scanned as received) —
   powers the Branch Upload dashboard.
---------------------------------------------------------------- */
app.get("/api/dispatch/branch-pending", async (req, res) => {
  const { division, branchName } = req.query;
  if (!division || !branchName) {
    return res.status(400).json({ ok: false, error: "division and branchName required" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT
         d.id AS dispatch_batch_id,
         d.vendor, d.batch_label, d.set_label, d.uploaded_at AS dispatched_at,
         array_agg(DISTINCT di.sku) FILTER (WHERE di.sku IS NOT NULL) AS dispatched_skus,
         r.id AS received_batch_id,
         r.uploaded_at AS received_at,
         array_agg(DISTINCT ri.sku) FILTER (WHERE ri.sku IS NOT NULL) AS received_skus
       FROM dispatch_batches d
       LEFT JOIN dispatch_batch_items di ON di.batch_id = d.id
       LEFT JOIN dispatch_batches r
         ON r.division = d.division AND r.vendor = d.vendor AND r.batch_label = d.batch_label
         AND r.set_label = d.set_label AND r.branch_name = d.branch_name AND r.source = 'received'
       LEFT JOIN dispatch_batch_items ri ON ri.batch_id = r.id
       WHERE d.division = $1 AND d.branch_name = $2 AND d.source = 'dispatched'
       GROUP BY d.id, r.id
       ORDER BY d.uploaded_at DESC`,
      [division, branchName]
    );

    const result = rows.map(r => {
      const dispatchedSet = new Set((r.dispatched_skus || []).map(s => s.toLowerCase()));
      const receivedSet = new Set((r.received_skus || []).map(s => s.toLowerCase()));
      const pendingSkus = [...dispatchedSet].filter(s => !receivedSet.has(s));
      return {
        vendor: r.vendor,
        batch_label: r.batch_label,
        set_label: r.set_label,
        dispatched_at: r.dispatched_at,
        received_at: r.received_at,
        dispatched_count: dispatchedSet.size,
        received_count: receivedSet.size,
        pending_count: pendingSkus.length,
        fully_received: dispatchedSet.size > 0 && pendingSkus.length === 0,
      };
    });

    res.json({ ok: true, rows: result });
  } catch (e) {
    console.error("branch-pending error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});


const server = app.listen(process.env.PORT, () => {
  console.log(`Server running on http://localhost:${process.env.PORT}`);
});


let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`${signal} received — starting graceful shutdown`);

  // 1. Stop accepting new HTTP requests
  server.close(() => {
    console.log("HTTP server closed — no new requests accepted");
  });

  // 2. Give in-flight requests a window to finish before forcing exit
  const forceExitTimer = setTimeout(() => {
    console.error("Forced shutdown — requests did not finish in time");
    process.exit(1);
  }, 10000); // 10s grace period

  try {
    await pool.end(); // waits for checked-out clients to finish their queries
    clearTimeout(forceExitTimer);
    console.log("DB pool closed cleanly");
    process.exit(0);
  } catch (err) {
    console.error("Error while closing DB pool:", err); 
    process.exit(1);
  }
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));



