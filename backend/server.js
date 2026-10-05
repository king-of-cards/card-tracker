// require("dotenv").config();
// const express = require("express");
// const { Pool } = require("pg");
// const cors = require("cors");

// const app = express();
// app.use(cors({ origin: "*" }));
// app.use(express.json({ limit: "25mb" })); 

// // const pool = new Pool({
// //   host: process.env.DB_HOST,
// //   user: process.env.DB_USER,
// //   password: process.env.DB_PASS,
// //   database: process.env.DB_NAME,
// //   port: process.env.DB_PORT,
// //   ssl: { rejectUnauthorized: false },

// //   max: 5,                            // small footprint — you're one of 5+ tenants on this RDS
// //   min: 0,                            // don't hold connections open when nothing's happening
// //   idleTimeoutMillis: 10000,          // release idle connections back fast (was 30000)
// //   connectionTimeoutMillis: 5000,     // fail fast if pool is busy, instead of hanging like before

// //   keepAlive: true,
// //   keepAliveInitialDelayMillis: 10000,

// //   application_name: "card-tracker",  
// //   pipeline: true,
// // });

// // pool.on("error", (err) => {
// //   console.error("Idle client error — pool will recover:", err.message);
// // });


// const db = require("./db/bq");
// const h = (name, fn) => async (req, res) => {
//   try { await fn(req, res); }
//   catch (e) {
//     if (e.body) return res.status(e.status || 400).json(e.body);
//     console.error(name, e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// };



// const dq = require("./dispatch.bq");




// const MAX_PRODUCTS = 100000; 

// async function getProductCount(client) {
//   const { rows } = await client.query("SELECT COUNT(*) FROM products");
//   return Number(rows[0].count);
// }

// const STAGE_KEYS = [
//   "barcoding",
//   "content",
//   "photography",
//   "photoedit",
//   "videography",
//   "dimensions",
//   "videoedit",
//   "images",
//   "backend",
//   "website",
//   "scan",
//   "qc",
//   "finalqc",
// ];
// const STORES = [
//   "Chamrajpet",
//   "HSR Layout",
//   "Sahakar Nagar",
//   "Hoodi",
//   "Jayanagar",
//   "Bommasandra",
//   "Hyderabad",
//   "Mysore",
//   "Vizag",
//   "Hubli",
//   "Chitradurga",
// ];
// const PIPELINE_STAGE_COUNT = STAGE_KEYS.filter((k) => k !== "finalqc").length; // 11

// app.get("/", (req, res) =>
//   res.json({ message: "Card Tracker API is running!" }),
// );

// app.get("/health", async (req, res) => {
//   try { await db.ping(); res.json({ ok: true, db: "connected to BigQuery" }); }
//   catch (e) { res.json({ ok: false, error: e.message }); }
// });
// // app.get("/health/pool", (req, res) => {
// //   res.json({
// //     total: pool.totalCount,
// //     idle: pool.idleCount,
// //     waiting: pool.waitingCount,
// //     max: 10,
// //   });
// // });



// /* ----------------------------------------------------------------
//    Helpers — convert a DB row shape into the nested JSON shape the
//    React app already expects (same shape ensureStages() builds).
// ---------------------------------------------------------------- */
// async function loadFullProduct(client, productId) {
//   const { rows: prows } = await client.query(
//     "SELECT * FROM products WHERE id = $1",
//     [productId],
//   );
//   if (!prows.length) return null;
//   return hydrateProducts(client, prows).then((arr) => arr[0]);
// }

// async function hydrateProducts(client, productRows) {
//   if (productRows.length === 0) return [];
//   const ids = productRows.map((p) => p.id);

//   const { rows: stageRows } = await client.query(
//     `SELECT * FROM stage_entries WHERE product_id = ANY($1::text[])`,
//     [ids],
//   );
//   const { rows: storeRows } = await client.query(
//     `SELECT * FROM stores WHERE product_id = ANY($1::text[])`,
//     [ids],
//   );

//   const stagesByProduct = {};
//   stageRows.forEach((r) => {
//     (stagesByProduct[r.product_id] ||= {})[r.stage_key] = {
//       status: r.status,
//       person: r.person || "",
//       comments: r.comments || "",
//       skipped: !!r.skipped,
//       at: r.updated_at ? r.updated_at.toISOString() : "",
//       ...(r.stage_key === "dimensions"
//         ? {
//             width: r.width_cm != null ? String(r.width_cm) : "",
//             height: r.height_cm != null ? String(r.height_cm) : "",
//             weight: r.weight_gm != null ? String(r.weight_gm) : "",
//           }
//         : {}),
//     };
//   });

//   const storesByProduct = {};
//   storeRows.forEach((r) => {
//     (storesByProduct[r.product_id] ||= {})[r.store] = {
//       dispatched: r.dispatched,
//       received: r.received,
//       receivedAt: r.received_at ? r.received_at.toISOString() : "",
//       receivedBy: r.received_by || "",
//       missing: r.missing,
//       damaged: r.damaged,
//       notes: r.notes || "",
//       at: r.updated_at ? r.updated_at.toISOString() : "",
//     };
//   });

//   return productRows.map((p) => {
//     const stages = {};
//     STAGE_KEYS.forEach((k) => {
//       stages[k] = (stagesByProduct[p.id] && stagesByProduct[p.id][k]) || {
//         status: "Not Started",
//         person: "",
//         comments: "",
//         at: "",
//       };
//       if (k === "dimensions" && !stages[k].width) {
//         stages[k].width = stages[k].width || "";
//         stages[k].height = stages[k].height || "";
//         stages[k].weight = stages[k].weight || "";
//       }
//     });
//     const stores = {};
//     STORES.forEach((st) => {
//       stores[st] = (storesByProduct[p.id] && storesByProduct[p.id][st]) || {
//         dispatched: 0,
//         received: false,
//         receivedAt: "",
//         receivedBy: "",
//         missing: 0,
//         damaged: 0,
//         notes: "",
//         at: "",
//       };
//     });
//     return {
//       id: p.id,
//       division: p.division,
//       sku: p.sku,
//       name: p.name || "",
//       vendor: p.vendor || "",
//       inward: p.inward ? p.inward.toISOString().slice(0, 10) : "",
//       qty: p.qty || 0,
//       note: p.note || "",
//       set_no: p.set_no || "",
//       verdict: p.verdict || "",
//       issues: p.issues || "",
//       stages,
//       stores,
//       createdAt: p.created_at ? p.created_at.toISOString() : "",
//       updatedAt: p.updated_at ? p.updated_at.toISOString() : "",
//     };
//   });
// }

// /* ----------------------------------------------------------------
//    GET /api/getAll  — equivalent of gsGet() / action=getAll
// ---------------------------------------------------------------- */
// app.get("/api/getAll", h("getAll", async (req, res) => res.json(await db.getAll())));

// app.get("/api/getUsers", async (req, res) => {
//   try { res.json(await db.getUsers()); }
//   catch (e) { console.error("getUsers error", e); res.status(500).json([]); }
// });

// app.post("/api/batchUpsertProducts", h("batchUpsertProducts", async (req, res) => {
//   if (!Array.isArray(req.body)) return res.status(400).json({ ok: false, error: "expected array" });
//   res.json({ ok: true, count: await db.batchUpsertProducts(req.body) });
// }));

// app.post("/api/batchPatchStage", h("batchPatchStage", async (req, res) => {
//   const { ids, stageKey, patch } = req.body;
//   if (!Array.isArray(ids) || !stageKey || !patch)
//     return res.status(400).json({ ok: false, error: "bad payload" });
//   await db.batchPatchStage(req.body);
//   res.json({ ok: true, count: ids.length });
// }));

// app.post("/api/patchQCVerdict", h("patchQCVerdict", async (req, res) => {
//   await db.patchQCVerdict(req.body); res.json({ ok: true });
// }));
// app.post("/api/appendQCAudit", h("appendQCAudit", async (req, res) => {
//   await db.appendQCAudit(req.body); res.json({ ok: true });
// }));
// app.post("/api/upsertStore", h("upsertStore", async (req, res) => {
//   await db.upsertStore(req.body); res.json({ ok: true });
// }));
// app.post("/api/appendAssignmentHistory", h("appendAssignmentHistory", async (req, res) => {
//   await db.appendAssignmentHistory(req.body); res.json({ ok: true });
// }));
// app.get("/api/assignmentHistory", h("assignmentHistory", async (req, res) =>
//   res.json(await db.assignmentHistory(req.query.division))));
// app.post("/api/deleteProduct", h("deleteProduct", async (req, res) => {
//   await db.deleteProduct(req.body.id); res.json({ ok: true });
// }));
// app.get("/api/checkStage", h("checkStage", async (req, res) =>
//   res.json({ ok: true, row: await db.checkStage(req.query.productId, req.query.stageKey) })));
// app.post("/api/setVendors", h("setVendors", async (req, res) => {
//   await db.setVendors(req.body); res.json({ ok: true });
// }));
// app.post("/api/setTeamMembers", h("setTeamMembers", async (req, res) => {
//   if (!Array.isArray(req.body)) return res.status(400).json({ ok: false, error: "expected array" });
//   await db.setTeamMembers(req.body); res.json({ ok: true });
// }));
// app.post("/api/saveUsers", h("saveUsers", async (req, res) => {
//   if (!Array.isArray(req.body)) return res.status(400).json({ ok: false, error: "expected array" });
//   await db.saveUsers(req.body); res.json({ ok: true });
// }));
// app.post("/api/setAssignments", h("setAssignments", async (req, res) =>
//   res.json({ ok: true, ...(await db.setAssignments(req.body)) })));
// app.post("/api/clearAssignments", h("clearAssignments", async (req, res) => {
//   if (req.body?.confirm !== true)
//     return res.status(400).json({ ok: false, error: "Must pass { confirm: true } to clear all assignments." });
//   res.json({ ok: true, deleted: await db.clearAssignments() });
// }));
// app.post("/api/appendAudit", h("appendAudit", async (req, res) => {
//   await db.appendAudit(req.body); res.json({ ok: true });
// }));
// app.post("/api/bulkImportProducts", h("bulkImportProducts", async (req, res) => {
//   if (!Array.isArray(req.body)) return res.status(400).json({ ok: false, error: "expected array" });
//   res.json({ ok: true, ...(await db.bulkImportProducts(req.body)) });
// }));
// app.get("/api/store-list", h("store-list", async (req, res) =>
//   res.json({ ok: true, stores: await db.storeList() })));   // keep only ONE copy

// /* ----------------------------------------------------------------
//    GET /api/memberStats?memberId=chitra&division=KOC Cards
//    Returns accurate counts straight from DB for Overview KPIs
// ---------------------------------------------------------------- */
// /* ----------------------------------------------------------------
//    GET /api/memberStats?memberId=chitra&division=Bombay Cards
//    Returns accurate counts straight from DB for Overview KPIs.

//    FIXED (2 bugs):
//    1. JOIN -> LEFT JOIN on stage_entries: a stage that's never been
//       touched has no row in stage_entries at all, so an INNER JOIN
//       silently dropped the whole card from card_level.
//    2. bool_or() null-safety: when every stage in a card is untouched
//       (se.status IS NULL throughout), the QC-flagged half of the OR
//       evaluated to NULL instead of false, and `false OR NULL = NULL`
//       made bool_or() return NULL for the whole card instead of false -
//       failing both the "NOT has_open_issue" and "has_open_issue"
//       checks, so the card vanished from every bucket.
// ---------------------------------------------------------------- */
// app.get("/api/memberStats", async (req, res) => {
//   const { memberId, division } = req.query;
//   if (!memberId || !division)
//     return res
//       .status(400)
//       .json({ ok: false, error: "memberId and division required" });
//   try {
//     const { rows } = await pool.query(
//       `
//       WITH member_skus AS (
//         SELECT DISTINCT sku
//         FROM assignments
//         WHERE member_id = $1 AND division = $2
//       ),
//       pushed_skus AS (
//         SELECT DISTINCT sku
//         FROM assignments
//         WHERE manager_id = $1
//           AND member_id != $1
//           AND division = $2
//       ),
//       kept_skus AS (
//         SELECT sku FROM member_skus
//         WHERE sku NOT IN (SELECT sku FROM pushed_skus)
//       ),
//       target_assignments AS (
//         SELECT DISTINCT p.id AS product_id, a.stage AS assigned_stage
//         FROM assignments a
//         JOIN products p ON p.sku = a.sku AND p.division = a.division
//         WHERE a.member_id = $1 AND a.division = $2
//       ),
//       card_level AS (
//         SELECT
//           ta.product_id,
//           COUNT(*) AS stages_owned,
//           COUNT(*) FILTER (WHERE se.status = 'Completed') AS stages_completed,
//           bool_or(
//             COALESCE(se.status, 'Not Started') = 'Issue'
//             OR COALESCE(se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%', false)
//           ) AS has_open_issue
//         FROM target_assignments ta
//         LEFT JOIN stage_entries se
//           ON se.product_id = ta.product_id
//           AND se.stage_key = ta.assigned_stage
//         GROUP BY ta.product_id
//       )
//       SELECT
//         (SELECT COUNT(*) FROM member_skus) AS total_assigned,
//         (SELECT COUNT(*) FROM pushed_skus) AS pushed_to_team,
//         (SELECT COUNT(*) FROM kept_skus)   AS kept_by_manager,
//         (SELECT COUNT(*) FROM card_level WHERE stages_completed = stages_owned AND NOT has_open_issue) AS completed,
//         (SELECT COUNT(*) FROM card_level WHERE stages_completed < stages_owned AND NOT has_open_issue) AS pending,
//         (SELECT COUNT(*) FROM card_level WHERE has_open_issue) AS issues
//     `,
//       [memberId, division],
//     );

//     res.json({ ok: true, ...rows[0] });
//   } catch (e) {
//     console.error("memberStats error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

// app.get("/api/allMemberStats", async (req, res) => {
//   const { division } = req.query;
//   if (!division)
//     return res.status(400).json({ ok: false, error: "division required" });
//   try {
//     const { rows } = await pool.query(
//       `
//       WITH target_assignments AS (
//         SELECT DISTINCT a.member_id, p.id AS product_id, a.stage AS assigned_stage
//         FROM assignments a
//         JOIN products p ON p.sku = a.sku AND p.division = a.division
//         WHERE a.division = $1
//       ),
//       card_level AS (
//         SELECT
//           ta.member_id,
//           ta.product_id,
//           COUNT(*) AS stages_owned,
//           COUNT(*) FILTER (WHERE se.status = 'Completed') AS stages_completed,
//           bool_or(
//             se.status = 'Issue'
//             OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
//           ) AS has_open_issue
//         FROM target_assignments ta
//         JOIN stage_entries se
//           ON se.product_id = ta.product_id
//           AND se.stage_key = ta.assigned_stage
//         GROUP BY ta.member_id, ta.product_id
//       )
//       SELECT
//         u.id AS member_id,
//         u.name AS member_name,
//         COUNT(cl.product_id) AS total_assigned,
//         COUNT(*) FILTER (WHERE cl.stages_completed = cl.stages_owned AND NOT cl.has_open_issue) AS completed,
//         COUNT(*) FILTER (WHERE cl.stages_completed < cl.stages_owned AND NOT cl.has_open_issue) AS pending,
//         COUNT(*) FILTER (WHERE cl.has_open_issue) AS issues
//       FROM card_level cl
//       JOIN users u ON u.id = cl.member_id
//       GROUP BY u.id, u.name
//       ORDER BY u.name
//     `,
//       [division],
//     );

//     res.json({
//       ok: true,
//       members: rows.map((r) => ({
//         memberId: r.member_id,
//         memberName: r.member_name,
//         total: Number(r.total_assigned),
//         completed: Number(r.completed),
//         pending: Number(r.pending),
//         issues: Number(r.issues),
//       })),
//     });
//   } catch (e) {
//     console.error("allMemberStats error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

// /* ----------------------------------------------------------------
//    GET /api/pipelineStats?memberId=chitra&division=KOC Cards
//    Returns per-stage counts for all SKUs assigned to this member
// ---------------------------------------------------------------- */
// app.get("/api/pipelineStats", async (req, res) => {
//   const { memberId, division } = req.query;
//   if (!memberId || !division)
//     return res
//       .status(400)
//       .json({ ok: false, error: "memberId and division required" });
//   try {
//     const { rows } = await pool.query(
//       `
//       WITH member_skus AS (
//         SELECT DISTINCT p.id as product_id, a.stage as assigned_stage
//         FROM assignments a
//         JOIN products p ON p.sku = a.sku AND p.division = a.division
//         WHERE a.member_id = $1
//           AND a.division = $2
//       )
//       SELECT
//         se.stage_key,
//         COUNT(*) FILTER (WHERE se.status = 'Not Started') as not_started,
//         COUNT(*) FILTER (
//           WHERE se.status = 'In Progress' AND se.comments NOT LIKE 'QC flagged:%'
//         ) as in_progress,
//         COUNT(*) FILTER (WHERE se.status = 'Completed') as completed,
//         COUNT(*) FILTER (
//           WHERE se.status = 'Issue'
//              OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
//         ) as issue
//       FROM member_skus ms
//       JOIN stage_entries se ON se.product_id = ms.product_id
//         AND se.stage_key = ms.assigned_stage
//       GROUP BY se.stage_key
//     `,
//       [memberId, division],
//     );

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
//     console.error("pipelineStats error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

// /* ----------------------------------------------------------------
//    Helpers for /api/exportProducts
// ---------------------------------------------------------------- */
// async function getExportRowsForDivision(client, division, scope) {
//   const { rows } = await client.query(
//     `
//     WITH stage_counts AS (
//       SELECT
//         p.id AS product_id,
//         COUNT(*) FILTER (WHERE se.status = 'Completed') AS completed_stages,
//         COUNT(*) FILTER (WHERE se.status = 'Issue') AS issue_stages,
//         MIN(CASE WHEN se.status IS DISTINCT FROM 'Completed' THEN se.stage_key END) AS next_pending_stage
//       FROM products p
//       LEFT JOIN stage_entries se
//         ON se.product_id = p.id AND se.stage_key != 'finalqc'
//       WHERE p.division = $1
//       GROUP BY p.id
//     )
//     SELECT p.sku, p.name, p.vendor, p.division, p.qty, p.verdict, p.updated_at,
//            sc.completed_stages, sc.issue_stages, sc.next_pending_stage
//     FROM products p
//     JOIN stage_counts sc ON sc.product_id = p.id
//     WHERE p.division = $1
//       AND (
//         $2 = 'all'
//         OR ($2 = 'completed' AND sc.completed_stages = $3)
//         OR ($2 = 'pending'   AND sc.completed_stages < $3)
//         OR ($2 = 'issues'    AND (p.verdict = 'Issues Found' OR sc.issue_stages > 0))
//       )
//     ORDER BY p.sku
//   `,
//     [division, scope, PIPELINE_STAGE_COUNT],
//   );
//   return rows;
// }

// async function getExportRowsForMember(client, division, memberId, scope) {
//   const { rows } = await client.query(
//     `
//     WITH my_assignments AS (
//       SELECT DISTINCT a.sku, a.stage
//       FROM assignments a
//       WHERE a.member_id = $1 AND a.division = $2
//     ),
//     card_level AS (
//       SELECT
//         p.id AS product_id,
//         p.sku, p.name, p.vendor, p.division, p.qty, p.verdict, p.updated_at,
//         COUNT(*) AS stages_owned,
//         COUNT(*) FILTER (WHERE se.status = 'Completed') AS stages_completed,
//         COUNT(*) FILTER (WHERE se.status = 'Issue') AS stages_issue,
//         MIN(CASE WHEN se.status IS DISTINCT FROM 'Completed' THEN ma.stage END) AS next_pending_stage
//       FROM my_assignments ma
//       JOIN products p ON p.sku = ma.sku AND p.division = $2
//       LEFT JOIN stage_entries se ON se.product_id = p.id AND se.stage_key = ma.stage
//       GROUP BY p.id, p.sku, p.name, p.vendor, p.division, p.qty, p.verdict, p.updated_at
//     )
//     SELECT * FROM card_level
//     WHERE
//       $3 = 'all'
//       OR ($3 = 'completed' AND stages_completed = stages_owned)
//       OR ($3 = 'pending'   AND stages_completed < stages_owned)
//       OR ($3 = 'issues'    AND (verdict = 'Issues Found' OR stages_issue > 0))
//     ORDER BY sku
//   `,
//     [memberId, division, scope],
//   );
//   return rows;
// }

// function normStatusServer(v) {
//   if (!v) return null;
//   const m = {
//     "not started": "Not Started",
//     "in progress": "In Progress",
//     wip: "In Progress",
//     pending: "In Progress",
//     completed: "Completed",
//     complete: "Completed",
//     done: "Completed",
//     approved: "Completed",
//     issue: "Issue",
//     issues: "Issue",
//   };
//   return m[String(v).trim().toLowerCase()] || null;
// }

// app.post("/api/bulkImportProducts", async (req, res) => {
//   const rows = req.body;
//   if (!Array.isArray(rows))
//     return res.status(400).json({ ok: false, error: "expected array" });

//   const validRows = rows.filter((r) => {
//     const sku = String(r.sku || "").trim();
//     return sku && !sku.toUpperCase().includes("EXAMPLE");
//   });

//   const results = { total: rows.length, created: 0, updated: 0, failed: [] };
//   if (validRows.length === 0) return res.json({ ok: true, ...results });

//     const client = await pool.connect();
//   try {
//     await client.query("SET LOCAL statement_timeout = '120s'");
//     await client.query("BEGIN");

//     // ---- Cap check: block only if this batch pushes us past MAX_PRODUCTS ----
//     const currentCount = await getProductCount(client);
//     const divisionsInBatch = [...new Set(validRows.map((r) => r.division))];
//     const { rows: existingCheck } = await client.query(
//       `SELECT lower(sku) as sku_lower FROM products WHERE division = ANY($1::division_name[])`,
//       [divisionsInBatch],
//     );
//     const existingSkuSet = new Set(existingCheck.map((r) => r.sku_lower));
//     const newRowsCount = validRows.filter(
//       (r) => !existingSkuSet.has(String(r.sku).trim().toLowerCase()),
//     ).length;

//     if (currentCount + newRowsCount > MAX_PRODUCTS) {
//       await client.query("ROLLBACK");
//       return res.status(400).json({
//         ok: false,
//         error: `Import would exceed max product cap (${MAX_PRODUCTS}). Currently ${currentCount}, trying to add ${newRowsCount} new SKUs.`,
//       });
//     }

//         // ---- 1. Bulk upsert vendors (deduped, ONE query) ----
//     const vendorPairs = new Set();
//     validRows.forEach((r) => {
//       if (r.vendor && String(r.vendor).trim()) {
//         vendorPairs.add((r.division || "") + "||" + String(r.vendor).trim());
//       }
//     });
//     if (vendorPairs.size > 0) {
//       const vDivs = [],
//         vNames = [];
//       vendorPairs.forEach((p) => {
//         const [d, n] = p.split("||");
//         vDivs.push(d);
//         vNames.push(n);
//       });
//       await client.query(
//         `INSERT INTO vendors (division, vendor_name)
//          SELECT * FROM unnest($1::division_name[], $2::text[]) ON CONFLICT DO NOTHING`,
//         [vDivs, vNames],
//       );
//     }

//     // ---- 1. Bulk upsert products (ONE query for the whole chunk) ----
//     const divisions = [],
//       skus = [],
//       names = [],
//       vendors = [],
//       inwards = [],
//       qtys = [],
//       notes = [],
//       setNos = [];
//     validRows.forEach((r) => {
//       divisions.push(r.division || null);
//       skus.push(String(r.sku).trim());
//       names.push(r.name || "");
//       vendors.push(r.vendor ? String(r.vendor).trim() : null);
//       inwards.push(r.inward ? String(r.inward) : null);
//       qtys.push(Number(r.qty) || 0);
//       notes.push(r.note || "");
//       setNos.push(r.set_no || null);
//     });

//     const upsertResult = await client.query(
//       `INSERT INTO products (id, division, sku, name, vendor, inward, qty, note, set_no, created_at, updated_at)
//        SELECT gen_random_uuid()::text, d, s, n, v, NULLIF(i,'')::date, q, nt, sn, now(), now()
//        FROM unnest($1::division_name[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::text[], $8::text[])
//          AS t(d, s, n, v, i, q, nt, sn)
//        ON CONFLICT (division, sku) DO UPDATE SET
//          name    = COALESCE(NULLIF(EXCLUDED.name,''), products.name),
//          vendor  = COALESCE(EXCLUDED.vendor, products.vendor),
//          inward  = COALESCE(EXCLUDED.inward, products.inward),
//          qty     = CASE WHEN EXCLUDED.qty > 0 THEN EXCLUDED.qty ELSE products.qty END,
//          note    = COALESCE(NULLIF(EXCLUDED.note,''), products.note),
//          set_no  = COALESCE(NULLIF(EXCLUDED.set_no,''), products.set_no),
//          updated_at = now()
//        RETURNING id, sku, division, (xmax = 0) AS inserted`,
//       [divisions, skus, names, vendors, inwards, qtys, notes, setNos],
//     );

//     const skuToId = {};
//     upsertResult.rows.forEach((r) => {
//       skuToId[r.division + "||" + r.sku.toLowerCase()] = r.id;
//       r.inserted ? results.created++ : results.updated++;
//     });

//     // // ---- 2. Bulk upsert vendors (deduped, ONE query) ----
//     // const vendorPairs = new Set();
//     // validRows.forEach((r) => {
//     //   if (r.vendor && String(r.vendor).trim()) {
//     //     vendorPairs.add((r.division || "") + "||" + String(r.vendor).trim());
//     //   }
//     // });
//     // if (vendorPairs.size > 0) {
//     //   const vDivs = [],
//     //     vNames = [];
//     //   vendorPairs.forEach((p) => {
//     //     const [d, n] = p.split("||");
//     //     vDivs.push(d);
//     //     vNames.push(n);
//     //   });
//     //   await client.query(
//     //     `INSERT INTO vendors (division, vendor_name)
//     //      SELECT * FROM unnest($1::division_name[], $2::text[]) ON CONFLICT DO NOTHING`,
//     //     [vDivs, vNames],
//     //   );
//     // }

//     // ---- 3. Bulk upsert stage_entries (ONE query for ALL stages of ALL rows) ----
//     const pids = [],
//       stageKeys = [],
//       statuses = [],
//       persons = [],
//       commentsArr = [],
//       widths = [],
//       heights = [],
//       weights = [];
//     validRows.forEach((r) => {
//       const key =
//         (r.division || "") + "||" + String(r.sku).trim().toLowerCase();
//       const productId = skuToId[key];
//       if (!productId) {
//         results.failed.push({ sku: r.sku, error: "product upsert failed" });
//         return;
//       }
//       for (const s of STAGE_KEYS) {
//         if (s === "finalqc") continue;
//         const statusRaw = r[s + "_status"],
//           person = r[s + "_person"] || "",
//           comm = r[s + "_comments"] || "";
//         const width =
//           s === "dimensions"
//             ? r.dimensions_width
//               ? Number(r.dimensions_width)
//               : null
//             : null;
//         const height =
//           s === "dimensions"
//             ? r.dimensions_height
//               ? Number(r.dimensions_height)
//               : null
//             : null;
//         const weight =
//           s === "dimensions"
//             ? r.dimensions_weight
//               ? Number(r.dimensions_weight)
//               : null
//             : null;
//                 // Always push a row for every stage, even if this Excel row left the
//         // stage's status/person/comments blank — otherwise a brand-new SKU
//         // never gets a stage_entries row at all and silently disappears from
//         // every stats query that reads stage_entries (pipelineBreakdown,
//         // memberStats, allMemberStats, etc.) instead of showing as
//         // "Not Started". A blank status here becomes null and is defaulted
//         // to 'Not Started' at INSERT time — but only on first insert; if the
//         // row already exists, the ON CONFLICT clause below still preserves
//         // its current status instead of overwriting it back to Not Started.
//         pids.push(productId);
//         stageKeys.push(s);
//         statuses.push(normStatusServer(statusRaw));
//         persons.push(person);
//         commentsArr.push(comm);
//         widths.push(width);
//         heights.push(height);
//         weights.push(weight);
//       }
//     });

//     if (pids.length > 0) {
//       await client.query(
//         `INSERT INTO stage_entries (product_id, stage_key, status, person, comments, updated_at, width_cm, height_cm, weight_gm)
//          SELECT p, sk, COALESCE(st::stage_status, 'Not Started'::stage_status), pe, co, now(), w, h, wt
//          FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::numeric[], $8::numeric[])
//            AS t(p, sk, st, pe, co, w, h, wt)
//          ON CONFLICT (product_id, stage_key) DO UPDATE SET
//            status   = COALESCE(EXCLUDED.status, stage_entries.status),
//            person   = COALESCE(NULLIF(EXCLUDED.person,''), stage_entries.person),
//            comments = COALESCE(NULLIF(EXCLUDED.comments,''), stage_entries.comments),
//            updated_at = now(),
//            width_cm  = COALESCE(EXCLUDED.width_cm, stage_entries.width_cm),
//            height_cm = COALESCE(EXCLUDED.height_cm, stage_entries.height_cm),
//            weight_gm = COALESCE(EXCLUDED.weight_gm, stage_entries.weight_gm)`,
//         [
//           pids,
//           stageKeys,
//           statuses,
//           persons,
//           commentsArr,
//           widths,
//           heights,
//           weights,
//         ],
//       );
//     }

//     // ---- 4. QC verdicts (ONE query) ----
//     const qcIds = [],
//       qcVerdicts = [],
//       qcIssues = [];
//     validRows.forEach((r) => {
//       if (!r.qc_verdict) return;
//       const key =
//         (r.division || "") + "||" + String(r.sku).trim().toLowerCase();
//       const productId = skuToId[key];
//       if (!productId) return;
//       const v = /appro/i.test(r.qc_verdict)
//         ? "Approved"
//         : /issue/i.test(r.qc_verdict)
//           ? "Issues Found"
//           : null;
//       if (!v) return;
//       qcIds.push(productId);
//       qcVerdicts.push(v);
//       qcIssues.push(r.qc_issues || "");
//     });
//     if (qcIds.length > 0) {
//       await client.query(
//         `UPDATE products p SET verdict = t.v, issues = t.iss, updated_at = now()
//          FROM unnest($1::text[], $2::text[], $3::text[]) AS t(id, v, iss)
//          WHERE p.id = t.id`,
//         [qcIds, qcVerdicts, qcIssues],
//       );
//     }

//     await client.query("COMMIT");
//     res.json({ ok: true, ...results });
//   } catch (e) {
//     await client.query("ROLLBACK");
//     console.error("bulkImportProducts error", e);
//     res.status(500).json({ ok: false, error: e.message, ...results });
//   } finally {
//     client.release();
//   }
// });

// /* ----------------------------------------------------------------
//    GET /api/exportProducts?division=KOC Cards&scope=pending&memberId=chitra
//    scope: "pending" | "completed" | "issues" | "all"
//    memberId optional — omit for master/admin (whole division)
// ---------------------------------------------------------------- */
// app.get("/api/exportProducts", async (req, res) => {
//   const { division, scope, memberId } = req.query;
//   if (!division)
//     return res.status(400).json({ ok: false, error: "division required" });
//   if (!["pending", "completed", "issues", "all"].includes(scope)) {
//     return res.status(400).json({ ok: false, error: "invalid scope" });
//   }
//   const client = await pool.connect();
//   try {
//     const rows = memberId
//       ? await getExportRowsForMember(client, division, memberId, scope)
//       : await getExportRowsForDivision(client, division, scope);

//     res.json({ ok: true, scope, count: rows.length, rows });
//   } catch (e) {
//     console.error("exportProducts error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   } finally {
//     client.release();
//   }
// });

// /* ----------------------------------------------------------------
//    GET /api/stageIssueStats?division=KOC Cards
//    Returns issue counts per stage, based on each product's LATEST
//    qc_audit entry — only counted while verdict is still "Issues Found".
// ---------------------------------------------------------------- */
// app.get("/api/stageIssueStats", async (req, res) => {
//   const { division } = req.query;
//   if (!division)
//     return res.status(400).json({ ok: false, error: "division required" });
//   try {
//     const { rows } = await pool.query(
//       `
//       SELECT se.stage_key, COUNT(*) AS issue_count
//       FROM stage_entries se
//       JOIN products p ON p.id = se.product_id
//       WHERE p.division = $1
//         AND (
//           se.status = 'Issue'
//           OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
//         )
//       GROUP BY se.stage_key
//     `,
//       [division],
//     );

//     const stages = {};
//     rows.forEach((r) => {
//       stages[r.stage_key] = Number(r.issue_count);
//     });
//     res.json({ ok: true, stages });
//   } catch (e) {
//     console.error("stageIssueStats error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

// /* ----------------------------------------------------------------
//    GET /api/pipelineBreakdown?division=KOC Cards&memberId=chitra&vendor=X&setNo=Y
//    Unified stage-by-stage counts for the Overview "Pipeline progress" table.
//    - memberId omitted  -> whole division (master/admin / "all my team" view)
//    - memberId present  -> only that member's assigned stages on their SKUs
//    - vendor / setNo     -> optional narrowing, applied identically either way
//    "issue" = status = 'Issue' OR (status = 'In Progress' AND QC-flagged comment)
// ---------------------------------------------------------------- */
// // app.get("/api/pipelineBreakdown", async (req, res) => {
// //   const { division, memberId, vendor, setNo } = req.query;
// //   if (!division)
// //     return res.status(400).json({ ok: false, error: "division required" });

// //   try {
// //     let rows;
// //     if (memberId) {
// //       // Scoped to one member's specific assigned stages on their assigned SKUs
// //       const { rows: r } = await pool.query(
// //         `
// //         WITH member_scope AS (
// //           SELECT DISTINCT p.id AS product_id, a.stage AS stage_key
// //           FROM assignments a
// //           JOIN products p
// //             ON p.sku = a.sku AND p.division = a.division
// //           WHERE a.member_id = $1
// //             AND a.division = $2
// //             AND ($3::text IS NULL OR p.vendor = $3)
// //             AND ($4::text IS NULL OR p.set_no = $4)
// //         )
// //         SELECT
// //           se.stage_key,
// //           COUNT(*) FILTER (WHERE se.status = 'Not Started') AS not_started,
// //           COUNT(*) FILTER (WHERE se.status = 'In Progress' AND se.comments NOT LIKE 'QC flagged:%') AS in_progress,
// //           COUNT(*) FILTER (WHERE se.status = 'Completed') AS completed,
// //           COUNT(*) FILTER (
// //             WHERE se.status = 'Issue'
// //                OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
// //           ) AS issue
// //         FROM member_scope ms
// //         JOIN stage_entries se
// //           ON se.product_id = ms.product_id AND se.stage_key = ms.stage_key
// //         GROUP BY se.stage_key
// //       `,
// //         [memberId, division, vendor || null, setNo || null],
// //       );
// //       rows = r;
// //     } else {
// //       // Whole division (or vendor/setNo-narrowed), every stage on every product
// //       const { rows: r } = await pool.query(
// //         `
// //         SELECT
// //           se.stage_key,
// //           COUNT(*) FILTER (WHERE se.status = 'Not Started') AS not_started,
// //           COUNT(*) FILTER (WHERE se.status = 'In Progress' AND se.comments NOT LIKE 'QC flagged:%') AS in_progress,
// //           COUNT(*) FILTER (WHERE se.status = 'Completed') AS completed,
// //           COUNT(*) FILTER (
// //             WHERE se.status = 'Issue'
// //                OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
// //           ) AS issue
// //         FROM stage_entries se
// //         JOIN products p ON p.id = se.product_id
// //         WHERE p.division = $1
// //           AND se.stage_key != 'finalqc'
// //           AND ($2::text IS NULL OR p.vendor = $2)
// //           AND ($3::text IS NULL OR p.set_no = $3)
// //         GROUP BY se.stage_key
// //       `,
// //         [division, vendor || null, setNo || null],
// //       );
// //       rows = r;
// //     }

// //     const stages = {};
// //     rows.forEach((r) => {
// //       stages[r.stage_key] = {
// //         notStarted: Number(r.not_started),
// //         inProgress: Number(r.in_progress),
// //         completed: Number(r.completed),
// //         issue: Number(r.issue),
// //       };
// //     });
// //     res.json({ ok: true, stages });
// //   } catch (e) {
// //     console.error("pipelineBreakdown error", e);
// //     res.status(500).json({ ok: false, error: e.message });
// //   }
// // });




// // app.get("/api/pipelineBreakdown", async (req, res) => {
// //   const { division, memberId, vendor, setNo } = req.query;
// //   if (!division)
// //     return res.status(400).json({ ok: false, error: "division required" });

// //   try {
// //     let rows;
// //     if (memberId) {
// //       const { rows: r } = await pool.query(
// //         `
// //         WITH member_scope AS (
// //           SELECT DISTINCT p.id AS product_id, a.stage AS stage_key
// //           FROM assignments a
// //           JOIN products p
// //             ON p.sku = a.sku AND p.division = a.division
// //           WHERE a.member_id = $1
// //             AND a.division = $2
// //             AND ($3::text IS NULL OR p.vendor = $3)
// //             AND ($4::text IS NULL OR p.set_no = $4)
// //         )
// //         SELECT
// //           ms.stage_key,
// //           COUNT(*) FILTER (WHERE COALESCE(se.status, 'Not Started') = 'Not Started') AS not_started,
// //           COUNT(*) FILTER (WHERE se.status = 'In Progress' AND COALESCE(se.comments, '') NOT LIKE 'QC flagged:%') AS in_progress,
// //           COUNT(*) FILTER (WHERE se.status = 'Completed') AS completed,
// //           COUNT(*) FILTER (
// //             WHERE se.status = 'Issue'
// //                OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
// //           ) AS issue
// //         FROM member_scope ms
// //         LEFT JOIN stage_entries se
// //           ON se.product_id = ms.product_id AND se.stage_key = ms.stage_key
// //         GROUP BY ms.stage_key
// //       `,
// //         [memberId, division, vendor || null, setNo || null],
// //       );
// //       rows = r;
// //     } else {
// //       const { rows: r } = await pool.query(
// //         `
// //         SELECT
// //           se.stage_key,
// //           COUNT(*) FILTER (WHERE se.status = 'Not Started') AS not_started,
// //           COUNT(*) FILTER (WHERE se.status = 'In Progress' AND se.comments NOT LIKE 'QC flagged:%') AS in_progress,
// //           COUNT(*) FILTER (WHERE se.status = 'Completed') AS completed,
// //           COUNT(*) FILTER (
// //             WHERE se.status = 'Issue'
// //                OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
// //           ) AS issue
// //         FROM stage_entries se
// //         JOIN products p ON p.id = se.product_id
// //         WHERE p.division = $1
// //           AND se.stage_key != 'finalqc'
// //           AND ($2::text IS NULL OR p.vendor = $2)
// //           AND ($3::text IS NULL OR p.set_no = $3)
// //         GROUP BY se.stage_key
// //       `,
// //         [division, vendor || null, setNo || null],
// //       );
// //       rows = r;
// //     }

// //     const stages = {};
// //     rows.forEach((r) => {
// //       stages[r.stage_key] = {
// //         notStarted: Number(r.not_started),
// //         inProgress: Number(r.in_progress),
// //         completed: Number(r.completed),
// //         issue: Number(r.issue),
// //       };
// //     });
// //     res.json({ ok: true, stages });
// //   } catch (e) {
// //     console.error("pipelineBreakdown error", e);
// //     res.status(500).json({ ok: false, error: e.message });
// //   }
// // });


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
//           SELECT DISTINCT p.id AS product_id, a.stage AS stage_key, p.vendor AS vendor
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
//           ms.vendor,
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
//         GROUP BY ms.stage_key, ms.vendor
//         ORDER BY ms.vendor, ms.stage_key
//       `,
//         [memberId, division, vendor || null, setNo || null],
//       );
//       rows = r;
//     } else {
//       const { rows: r } = await pool.query(
//         `
//         SELECT
//           se.stage_key,
//           p.vendor AS vendor,
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
//         GROUP BY se.stage_key, p.vendor
//         ORDER BY p.vendor, se.stage_key
//       `,
//         [division, vendor || null, setNo || null],
//       );
//       rows = r;
//     }

//     // Two shapes returned together:
//     // 1. `stages`   — same as before, aggregated across all vendors (backward compatible)
//     // 2. `byVendor` — new: { vendorName: { stageKey: {...} } }
//     const stages = {};
//     const byVendor = {};

//     rows.forEach((r) => {
//       const vendorKey = r.vendor || "—";
//       const cell = {
//         notStarted: Number(r.not_started),
//         inProgress: Number(r.in_progress),
//         completed: Number(r.completed),
//         issue: Number(r.issue),
//       };

//       // Aggregate view (sums across vendors per stage)
//       if (!stages[r.stage_key]) {
//         stages[r.stage_key] = { notStarted: 0, inProgress: 0, completed: 0, issue: 0 };
//       }
//       stages[r.stage_key].notStarted += cell.notStarted;
//       stages[r.stage_key].inProgress += cell.inProgress;
//       stages[r.stage_key].completed += cell.completed;
//       stages[r.stage_key].issue += cell.issue;

//       // Per-vendor breakdown
//       if (!byVendor[vendorKey]) byVendor[vendorKey] = {};
//       byVendor[vendorKey][r.stage_key] = cell;
//     });

//     res.json({ ok: true, stages, byVendor });
//   } catch (e) {
//     console.error("pipelineBreakdown error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

// /* ----------------------------------------------------------------
//    GET /api/stageSpeedStats?division=KOC Cards
//    Average time-to-complete per stage, computed from audit_log.
// ---------------------------------------------------------------- */
// app.get("/api/stageSpeedStats", async (req, res) => {
//   const { division } = req.query;
//   if (!division)
//     return res.status(400).json({ ok: false, error: "division required" });
//   try {
//     const { rows } = await pool.query(
//       `SELECT entity, detail, logged_at FROM audit_log
//        WHERE action = 'Stage update' AND division = $1
//        ORDER BY entity, logged_at ASC`,
//       [division],
//     );

//     // entity+stage -> { firstInProgress, firstCompleted }
//     const track = {};
//     rows.forEach((r) => {
//       const m = String(r.detail || "").match(/^(.+?)\s*→\s*([^·]+?)(?:\s*·|$)/);
//       if (!m) return;
//       const stageName = m[1].trim();
//       const status = m[2].trim();
//       const key = r.entity + "||" + stageName;
//       if (!track[key])
//         track[key] = { stageName, firstInProgress: null, firstCompleted: null };
//       const t = track[key];
//       if (status === "In Progress" && !t.firstInProgress)
//         t.firstInProgress = r.logged_at;
//       if (status === "Completed" && !t.firstCompleted && t.firstInProgress)
//         t.firstCompleted = r.logged_at;
//     });

//     const byStage = {};
//     Object.values(track).forEach((t) => {
//       if (!t.firstInProgress || !t.firstCompleted) return;
//       const hours =
//         (new Date(t.firstCompleted) - new Date(t.firstInProgress)) / 3600000;
//       if (hours < 0 || hours > 24 * 60) return; // discard bad/outlier data
//       (byStage[t.stageName] ||= []).push(hours);
//     });

//     const stats = Object.entries(byStage)
//       .map(([stageName, durations]) => ({
//         stageName,
//         avgHours: durations.reduce((a, b) => a + b, 0) / durations.length,
//         sampleCount: durations.length,
//       }))
//       .sort((a, b) => a.avgHours - b.avgHours);

//     res.json({ ok: true, stats });
//   } catch (e) {
//     console.error("stageSpeedStats error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

// /* ----------------------------------------------------------------
//    GET /api/memberSpeedStats?division=KOC Cards
//    Per-member turnaround speed + issue rate, computed from audit_log.
//    "Speed" = avg hours between a stage's first "In Progress" and its
//    next "Completed", attributed to whoever completed it.
// ---------------------------------------------------------------- */
// app.get("/api/memberSpeedStats", async (req, res) => {
//   const { division } = req.query;
//   if (!division)
//     return res.status(400).json({ ok: false, error: "division required" });
//   try {
//     const { rows } = await pool.query(
//       `SELECT entity, detail, logged_at, actor_name FROM audit_log
//        WHERE action = 'Stage update' AND division = $1
//        ORDER BY entity, logged_at ASC`,
//       [division],
//     );

//     const lastInProgress = {}; // "sku||stageName" -> timestamp
//     const byMember = {}; // person name -> accumulator

//     const touch = (name) =>
//       (byMember[name] ||= {
//         durations: [],
//         completions: 0,
//         issues: 0,
//         byStage: {},
//       });

//     rows.forEach((r) => {
//       const m = String(r.detail || "").match(
//         /^(.+?)\s*→\s*([^·]+?)(?:\s*·\s*(.+))?$/,
//       );
//       if (!m) return;
//       const stageName = m[1].trim();
//       const status = m[2].trim();
//       const person = (m[3] || "").trim() || (r.actor_name || "").trim();
//       const key = r.entity + "||" + stageName;

//       if (status === "In Progress") {
//         lastInProgress[key] = r.logged_at;
//       } else if (status === "Completed") {
//         const startedAt = lastInProgress[key];
//         if (startedAt && person) {
//           const hours = (new Date(r.logged_at) - new Date(startedAt)) / 3600000;
//           // discard bad/stalled outliers (>60 days) so one forgotten card
//           // doesn't wreck someone's average
//           if (hours > 0 && hours < 24 * 60) {
//             const acc = touch(person);
//             acc.durations.push(hours);
//             acc.completions++;
//             (acc.byStage[stageName] ||= []).push(hours);
//           }
//         }
//         delete lastInProgress[key];
//       } else if (status === "Issue" && person) {
//         touch(person).issues++;
//       }
//     });

//     const members = Object.entries(byMember)
//       .map(([name, m]) => {
//         const avgHours = m.durations.length
//           ? m.durations.reduce((a, b) => a + b, 0) / m.durations.length
//           : null;
//         const stageBreakdown = Object.entries(m.byStage)
//           .map(([stageName, arr]) => ({
//             stageName,
//             avgHours: arr.reduce((a, b) => a + b, 0) / arr.length,
//             count: arr.length,
//           }))
//           .sort((a, b) => a.avgHours - b.avgHours);
//         return {
//           name,
//           completions: m.completions,
//           avgHours,
//           issues: m.issues,
//           issueRate:
//             m.completions + m.issues
//               ? m.issues / (m.completions + m.issues)
//               : 0,
//           fastestStage: stageBreakdown[0] || null,
//           slowestStage: stageBreakdown[stageBreakdown.length - 1] || null,
//           stageBreakdown,
//         };
//       })
//       .filter((x) => x.completions > 0)
//       .sort((a, b) => a.avgHours - b.avgHours); // fastest first

//     res.json({ ok: true, members });
//   } catch (e) {
//     console.error("memberSpeedStats error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

// /* ----------------------------------------------------------------
//    GET /api/teamStageStats?division=...&vendor=&set_no=&dateFrom=&dateTo=&status=
//    Per-member counts of assigned stages, split into Backend team vs
//    Photography & Videography team, with optional filters.
// ---------------------------------------------------------------- */
// const TEAM_BACKEND_STAGE_KEYS = [
//   "content",
//   "dimensions",
//   "images",
//   "backend",
//   "website",
// ];
// const TEAM_PHOTO_STAGE_KEYS = [
//   "photography",
//   "photoedit",
//   "videography",
//   "videoedit",
// ];

// app.get("/api/teamStageStats", async (req, res) => {
//   const { division, vendor, set_no, dateFrom, dateTo } = req.query;
//   if (!division)
//     return res.status(400).json({ ok: false, error: "division required" });

//   try {
//     const allStageKeys = [...TEAM_BACKEND_STAGE_KEYS, ...TEAM_PHOTO_STAGE_KEYS];

//     const { rows: userRows } = await pool.query(
//       `SELECT id, manager_id FROM users`,
//     );
//     const managerIdOf = {};
//     userRows.forEach((u) => {
//       managerIdOf[u.id] = u.manager_id;
//     });
//     const conditions = ["a.division = $1", "a.stage = ANY($2)"];
//     const params = [division, allStageKeys];

//     if (vendor) {
//       params.push(vendor);
//       conditions.push(`p.vendor = $${params.length}`);
//     }
//     if (set_no) {
//       params.push(set_no);
//       conditions.push(`p.set_no = $${params.length}`);
//     }
//     if (dateFrom) {
//       params.push(dateFrom);
//       conditions.push(`a.assigned_at >= $${params.length}`);
//     }
//     if (dateTo) {
//       params.push(dateTo + " 23:59:59");
//       conditions.push(`a.assigned_at <= $${params.length}`);
//     }
//     // NOTE: status is intentionally NOT added to `conditions` — it must not
//     // shrink the row set, or Total Assigned would change with it.

//     const { rows } = await pool.query(
//       `SELECT a.member_id, u.name AS member_name, a.stage, a.sku, se.status AS stage_status
//        FROM assignments a
//        JOIN users u ON u.id = a.member_id
//        JOIN products p ON p.id = a.product_id
//        LEFT JOIN stage_entries se ON se.product_id = a.product_id AND se.stage_key = a.stage
//        WHERE ${conditions.join(" AND ")}`,
//       params,
//     );
//     const buildGroup = (stageKeys) => {
//       const byMember = {};
//       rows.forEach((r) => {
//         if (!stageKeys.includes(r.stage)) return;
//         const acc = (byMember[r.member_id] ||= {
//           memberName: r.member_name,
//           skus: new Set(),
//           skuStage: {},
//         });

//         acc.skus.add(r.sku);
//         // Remember status per sku+stage instead of tallying immediately —
//         // we don't yet know which skus will survive the manager/report subtraction.
//         (acc.skuStage[r.sku] ||= {})[r.stage] = r.stage_status;
//       });

//       // Subtract reports' skus from their manager's set — same as totalAssigned.
//       Object.keys(byMember).forEach((managerId) => {
//         const reportIds = Object.keys(byMember).filter(
//           (id) => managerIdOf[id] === managerId,
//         );
//         if (reportIds.length === 0) return;
//         const managerSkus = byMember[managerId].skus;
//         reportIds.forEach((repId) => {
//           byMember[repId].skus.forEach((sku) => managerSkus.delete(sku));
//         });
//       });

//       return Object.entries(byMember)
//         .map(([memberId, m]) => {
//           const perStage = stageKeys.reduce(
//             (o, k) => ({ ...o, [k]: { completed: 0, pending: 0, issue: 0 } }),
//             {},
//           );
//           m.skus.forEach((sku) => {
//             const stagesForSku = m.skuStage[sku] || {};
//             stageKeys.forEach((stageKey) => {
//               if (!(stageKey in stagesForSku)) return;
//               const status = stagesForSku[stageKey];
//               if (status === "Completed") perStage[stageKey].completed++;
//               else if (status === "Issue") perStage[stageKey].issue++;
//               else perStage[stageKey].pending++;
//             });
//           });

//           // A stage with zero completed/pending/issue means this member was
//           // never assigned that stage on any of their cards — mark it null so
//           // the frontend can show "—" instead of misleading zeros.
//           stageKeys.forEach((k) => {
//             const s = perStage[k];
//             if (s.completed + s.pending + s.issue === 0) perStage[k] = null;
//           });

//           return {
//             memberId,
//             memberName: m.memberName,
//             totalAssigned: m.skus.size,
//             perStage,
//           };
//         })
//         .sort((a, b) => b.totalAssigned - a.totalAssigned);
//     };

//     res.json({
//       ok: true,
//       backendTeam: buildGroup(TEAM_BACKEND_STAGE_KEYS),
//       photoTeam: buildGroup(TEAM_PHOTO_STAGE_KEYS),
//     });
//   } catch (e) {
//     console.error("teamStageStats error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

// // /* ----------------------------------------------------------------
// //    GET /api/effectiveMemberStagePipeline?division=KOC Cards
// //    Same "effective assignment" logic as your psql query:
// //      - resolves manager-vs-report double counting (if a manager pushed
// //        a sku/stage to a report, it's excluded from the manager's
// //        "effective" set)
// //      - returns per-member, per-division, per-stage counts
// //        (assigned / completed / in_progress / not_started / issue)
// //    division is OPTIONAL — omit it to get both "KOC Cards" and
// //    "Bombay Cards" together (matches the WHERE a.division IN (...)
// //    in your original query). Pass it to scope to just one division.
// // ---------------------------------------------------------------- */
// app.get("/api/memberStageDetail", async (req, res) => {
//   const { division, completedFrom, completedTo, vendor } = req.query;

//   try {
//     const { rows } = await pool.query(
//       `
//       WITH target_assignments AS (
//           SELECT DISTINCT a.member_id, a.manager_id, a.division, a.stage AS assigned_stage,
//                 p.id AS product_id, a.sku, a.assigned_at
//           FROM assignments a
//           JOIN products p ON p.sku = a.sku AND p.division = a.division
//           WHERE a.division IN ('KOC Cards', 'Bombay Cards')
//             AND ($1::division_name IS NULL OR a.division = $1::division_name)
//             AND ($4::text IS NULL OR p.vendor = $4::text)
//       ),
//       pushed AS (
//           SELECT DISTINCT manager_id, division, assigned_stage, sku
//           FROM target_assignments
//           WHERE manager_id IS NOT NULL AND manager_id != member_id
//       ),
//       effective AS (
//           SELECT DISTINCT ta.member_id, ta.division, ta.assigned_stage, ta.product_id, ta.sku, ta.assigned_at
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
//               MAX(e.assigned_at) AS last_assigned_at,
//               -- Completion is the only thing that gets date-scoped. When
//               -- $2/$3 are NULL (no filter set), the range check is skipped
//               -- entirely, so this behaves exactly like the live/unfiltered
//               -- query did before.
//               MAX(se.updated_at) FILTER (
//                   WHERE se.status = 'Completed'
//                     AND ($2::timestamptz IS NULL OR se.updated_at >= $2::timestamptz)
//                     AND ($3::timestamptz IS NULL OR se.updated_at < $3::timestamptz)
//               ) AS last_completed_at,
//               COUNT(DISTINCT e.sku) AS assigned_skus,
//               COUNT(DISTINCT e.sku) FILTER (
//                   WHERE se.status = 'Completed'
//                     AND ($2::timestamptz IS NULL OR se.updated_at >= $2::timestamptz)
//                     AND ($3::timestamptz IS NULL OR se.updated_at < $3::timestamptz)
//               ) AS completed_skus,
//               -- Pending/issue always reflect the current live state — these
//               -- are "right now" concepts, not date-windowed ones.
//               COUNT(DISTINCT e.sku) FILTER (
//                   WHERE se.status = 'In Progress' AND se.comments NOT LIKE 'QC flagged:%'
//               ) AS in_progress_skus,
//               COUNT(DISTINCT e.sku) FILTER (WHERE se.status = 'Not Started') AS not_started_skus,
//               COUNT(DISTINCT e.sku) FILTER (
//                   WHERE se.status = 'Issue'
//                     OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
//               ) AS issue_skus
//           FROM effective e
//           LEFT JOIN stage_entries se
//               ON se.product_id = e.product_id
//             AND se.stage_key = e.assigned_stage
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
//           ps.last_assigned_at,
//           ps.last_completed_at,
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
//       [
//         division || null,
//         completedFrom || null,
//         completedTo || null,
//         vendor || null,
//       ],
//     );

//     // Reshape flat rows into a nested per-member structure, same spirit
//     // as your other stats endpoints (allMemberStats / teamStageStats).
//     const byKey = {};
//     rows.forEach((r) => {
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
//         assignedAt: r.last_assigned_at
//           ? new Date(r.last_assigned_at).toISOString()
//           : null,
//         completedAt: r.last_completed_at
//           ? new Date(r.last_completed_at).toISOString()
//           : null,
//         assignedSkus: Number(r.assigned_skus),
//         completedSkus: Number(r.completed_skus),
//         inProgressSkus: Number(r.in_progress_skus),
//         notStartedSkus: Number(r.not_started_skus),
//         issueSkus: Number(r.issue_skus),
//       });
//     });

//     res.json({
//       ok: true,
//       rows, // raw rows, in case the frontend wants the flat shape
//       members: Object.values(byKey),
//     });
//   } catch (e) {
//     console.error("effectiveMemberStagePipeline error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

// // app.get("/api/memberStageDetail", async (req, res) => {
// //   const { division } = req.query;

// //   try {
// //     const { rows } = await pool.query(
// //       `
// //       WITH ranked_assignments AS (
// //           SELECT
// //               a.member_id, a.manager_id, a.division, a.stage AS assigned_stage,
// //               p.id AS product_id, a.sku,
// //               ROW_NUMBER() OVER (
// //                   PARTITION BY a.sku, a.stage, a.division
// //                   ORDER BY a.assigned_at DESC NULLS LAST, a.id DESC
// //               ) AS rn
// //           FROM assignments a
// //           JOIN products p ON p.sku = a.sku AND p.division = a.division
// //           WHERE a.division IN ('KOC Cards', 'Bombay Cards')
// //             AND ($1::division_name IS NULL OR a.division = $1::division_name)
// //       ),
// //       target_assignments AS (
// //           SELECT member_id, manager_id, division, assigned_stage, product_id, sku
// //           FROM ranked_assignments
// //           WHERE rn = 1
// //       ),
// //       pushed AS (
// //           SELECT DISTINCT manager_id, division, assigned_stage, sku
// //           FROM target_assignments
// //           WHERE manager_id IS NOT NULL AND manager_id != member_id
// //       ),
// //       effective AS (
// //           SELECT DISTINCT ta.member_id, ta.division, ta.assigned_stage, ta.product_id, ta.sku
// //           FROM target_assignments ta
// //           WHERE NOT EXISTS (
// //               SELECT 1 FROM pushed p
// //               WHERE p.manager_id = ta.member_id
// //                 AND p.division = ta.division
// //                 AND p.assigned_stage = ta.assigned_stage
// //                 AND p.sku = ta.sku
// //           )
// //       ),
// //       per_stage AS (
// //           SELECT
// //               e.member_id,
// //               e.division,
// //               e.assigned_stage AS stage,
// //               COUNT(DISTINCT e.sku) AS assigned_skus,
// //               COUNT(DISTINCT e.sku) FILTER (WHERE se.status = 'Completed') AS completed_skus,
// //               COUNT(DISTINCT e.sku) FILTER (
// //                   WHERE se.status = 'In Progress' AND se.comments NOT LIKE 'QC flagged:%'
// //               ) AS in_progress_skus,
// //               COUNT(DISTINCT e.sku) FILTER (WHERE se.status = 'Not Started') AS not_started_skus,
// //               COUNT(DISTINCT e.sku) FILTER (
// //                   WHERE se.status = 'Issue'
// //                      OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
// //               ) AS issue_skus
// //           FROM effective e
// //           LEFT JOIN stage_entries se
// //               ON se.product_id = e.product_id
// //              AND se.stage_key = e.assigned_stage
// //           GROUP BY e.member_id, e.division, e.assigned_stage
// //       ),
// //       totals AS (
// //           SELECT member_id, division, COUNT(DISTINCT sku) AS total_assigned_skus
// //           FROM effective
// //           GROUP BY member_id, division
// //       )
// //       SELECT
// //           u.id AS member_id,
// //           u.name AS member_name,
// //           t.division,
// //           t.total_assigned_skus,
// //           ps.stage,
// //           ps.assigned_skus,
// //           ps.completed_skus,
// //           ps.in_progress_skus,
// //           ps.not_started_skus,
// //           ps.issue_skus
// //       FROM totals t
// //       JOIN users u ON u.id = t.member_id
// //       JOIN per_stage ps ON ps.member_id = t.member_id AND ps.division = t.division
// //       ORDER BY t.division, u.name, ps.stage
// //       `,
// //       [division || null]
// //     );

// //     const byKey = {};
// //     rows.forEach(r => {
// //       const key = r.member_id + "||" + r.division;
// //       if (!byKey[key]) {
// //         byKey[key] = {
// //           memberId: r.member_id,
// //           memberName: r.member_name,
// //           division: r.division,
// //           totalAssignedSkus: Number(r.total_assigned_skus),
// //           stages: [],
// //         };
// //       }
// //       byKey[key].stages.push({
// //         stage: r.stage,
// //         assignedSkus: Number(r.assigned_skus),
// //         completedSkus: Number(r.completed_skus),
// //         inProgressSkus: Number(r.in_progress_skus),
// //         notStartedSkus: Number(r.not_started_skus),
// //         issueSkus: Number(r.issue_skus),
// //       });
// //     });

// //     res.json({
// //       ok: true,
// //       rows,
// //       members: Object.values(byKey),
// //     });
// //   } catch (e) {
// //     console.error("memberStageDetail error", e);
// //     res.status(500).json({ ok: false, error: e.message });
// //   }
// // });

// /* ----------------------------------------------------------------
//    GET /api/memberDailyActivity?person=dharani&division=KOC Cards&from=2026-08-24&to=2026-08-27
//    Day-by-day completed-stage activity for one person, based on who
//    actually touched the row (stage_entries.person), not assignments.
// ---------------------------------------------------------------- */
// app.get("/api/memberDailyActivity", async (req, res) => {
//   const { person, division, from, to } = req.query;
//   if (!person)
//     return res.status(400).json({ ok: false, error: "person required" });
//   try {
//     const { rows } = await pool.query(
//       `SELECT
//          date_trunc('day', se.updated_at) AS work_date,
//          se.stage_key,
//          COUNT(*) AS completed_count,
//          array_agg(p.sku ORDER BY se.updated_at) AS skus
//        FROM stage_entries se
//        JOIN products p ON p.id = se.product_id
//        WHERE se.person ILIKE $1
//          AND se.status = 'Completed'
//          AND ($2::division_name IS NULL OR p.division = $2::division_name)
//          AND ($3::timestamptz IS NULL OR se.updated_at >= $3::timestamptz)
//          AND ($4::timestamptz IS NULL OR se.updated_at < $4::timestamptz)
//        GROUP BY work_date, se.stage_key
//        ORDER BY work_date, se.stage_key`,
//       [person, division || null, from || null, to || null],
//     );
//     res.json({
//       ok: true,
//       rows: rows.map((r) => ({
//         date: r.work_date.toISOString().slice(0, 10),
//         stage: r.stage_key,
//         completed: Number(r.completed_count),
//         skus: r.skus,
//       })),
//     });
//   } catch (e) {
//     console.error("memberDailyActivity error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

// /* ----------------------------------------------------------------
//    GET /api/teamStageActivity?division=KOC Cards&from=2026-08-24&to=2026-08-27
//    Per-member, per-stage COMPLETED counts within a date range, based on
//    who actually completed the work (stage_entries.person + updated_at).
//    Used by Speed Analytics > Full Breakdown when a date filter is active.
// ---------------------------------------------------------------- */
// app.get("/api/teamStageActivity", async (req, res) => {
//   const { division, from, to } = req.query;
//   if (!division)
//     return res.status(400).json({ ok: false, error: "division required" });
//   try {
//     const { rows } = await pool.query(
//       `SELECT
//          se.person AS member_name,
//          se.stage_key,
//          COUNT(*) AS completed_count
//        FROM stage_entries se
//        JOIN products p ON p.id = se.product_id
//        WHERE p.division = $1
//          AND se.status = 'Completed'
//          AND se.person IS NOT NULL AND se.person != ''
//          AND ($2::timestamptz IS NULL OR se.updated_at >= $2::timestamptz)
//          AND ($3::timestamptz IS NULL OR se.updated_at < $3::timestamptz)
//        GROUP BY se.person, se.stage_key
//        ORDER BY se.person, se.stage_key`,
//       [division, from || null, to || null],
//     );

//     // Distinct cards touched per person in this window — a card counted once
//     // even if the person completed multiple stages on it.
//     const { rows: totalsRows } = await pool.query(
//       `SELECT se.person AS member_name, COUNT(DISTINCT p.id) AS total_cards
//        FROM stage_entries se
//        JOIN products p ON p.id = se.product_id
//        WHERE p.division = $1
//          AND se.status = 'Completed'
//          AND se.person IS NOT NULL AND se.person != ''
//          AND ($2::timestamptz IS NULL OR se.updated_at >= $2::timestamptz)
//          AND ($3::timestamptz IS NULL OR se.updated_at < $3::timestamptz)
//        GROUP BY se.person`,
//       [division, from || null, to || null],
//     );
//     const totalsByPerson = {};
//     totalsRows.forEach((r) => {
//       totalsByPerson[r.member_name] = Number(r.total_cards);
//     });

//     const byMember = {};
//     rows.forEach((r) => {
//       if (!byMember[r.member_name]) {
//         byMember[r.member_name] = {
//           memberName: r.member_name,
//           totalCards: totalsByPerson[r.member_name] || 0,
//           stages: [],
//         };
//       }
//       byMember[r.member_name].stages.push({
//         stage: r.stage_key,
//         completedSkus: Number(r.completed_count),
//         inProgressSkus: 0,
//         notStartedSkus: 0,
//         issueSkus: 0,
//       });
//     });

//     res.json({ ok: true, members: Object.values(byMember) });
//   } catch (e) {
//     console.error("teamStageActivity error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

// app.get("/api/store-list", async (req, res) => {
//   try {
//     const { rows } = await pool.query(
//       "SELECT store_name FROM store_list ORDER BY store_name",
//     );
//     res.json({ ok: true, stores: rows.map((r) => r.store_name) });
//   } catch (e) {
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

// /* ----------------------------------------------------------------
//    GET /api/store-list — for populating the branch dropdown
// ---------------------------------------------------------------- */
// app.get("/api/store-list", async (req, res) => {
//   try {
//     const { rows } = await pool.query(
//       "SELECT store_name FROM store_list ORDER BY store_name",
//     );
//     res.json({ ok: true, stores: rows.map((r) => r.store_name) });
//   } catch (e) {
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

// /* ----------------------------------------------------------------
//    POST /api/dispatch/admin-upload — admin's reference set (set_number = 1)
//    body: { division, vendor, batchLabel, uploadedBy, filename, skus: [{sku, qty}] }
// ---------------------------------------------------------------- */
// app.post("/api/dispatch/admin-upload", async (req, res) => {
//   const { division, vendor, batchLabel, setLabel, branchName, uploadedBy, filename, skus } = req.body;
//   if (!division || !vendor || !batchLabel || !setLabel || !branchName || !Array.isArray(skus) || skus.length === 0) {
//     return res.status(400).json({ ok: false, error: "division, vendor, batchLabel, setLabel, branchName and skus[] required" });
//   }
//   const client = await pool.connect();
//   try {
//     await client.query("BEGIN");
//     const { rows: vcheck } = await client.query("SELECT 1 FROM vendors WHERE division=$1 AND vendor_name=$2", [division, vendor]);
//     if (!vcheck.length) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: `Vendor "${vendor}" not found.` }); }
//     const { rows: scheck } = await client.query("SELECT 1 FROM store_list WHERE store_name=$1", [branchName]);
//     if (!scheck.length) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: `Unknown branch "${branchName}".` }); }

//     const { rows: batchRows } = await client.query(
//       `INSERT INTO dispatch_batches (division, vendor, batch_label, set_label, branch_name, source, uploaded_by, source_filename)
//        VALUES ($1,$2,$3,$4,$5,'dispatched',$6,$7)
//        ON CONFLICT (division, vendor, batch_label, set_label, branch_name, source)
//        DO UPDATE SET uploaded_by=$6, source_filename=$7, updated_at=now()
//        RETURNING id`,
//       [division, vendor, batchLabel, setLabel, branchName, uploadedBy || "Unattributed", filename || null]
//     );
//     const batchId = batchRows[0].id;

//     const counts = {};
//     skus.forEach(s => { const k = String(s.sku || s).trim(); if (k) counts[k] = (counts[k] || 0) + (Number(s.qty) || 1); });
//     const skuList = Object.keys(counts), qtyList = skuList.map(s => counts[s]);

//     if (skuList.length > 0) {
//       await client.query(
//         `INSERT INTO dispatch_batch_items (batch_id, sku, qty, scan_count, first_scanned_at, last_scanned_at)
//          SELECT $1, s, q, q, now(), now() FROM unnest($2::text[], $3::int[]) AS t(s,q)
//          ON CONFLICT (batch_id, sku) DO UPDATE SET
//            scan_count = dispatch_batch_items.scan_count + EXCLUDED.scan_count,
//            last_scanned_at = now()`,
//         [batchId, skuList, qtyList]
//       );
//     }
//     await client.query("COMMIT");
//     res.json({ ok: true, batchId, skuCount: skuList.length });
//   } catch (e) {
//     await client.query("ROLLBACK");
//     console.error("admin-upload error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   } finally { client.release(); }
// });
// /* ----------------------------------------------------------------
//    POST /api/dispatch/branch-upload — branch's received set (auto set_number)
//    body: { division, vendor, batchLabel, branchName, uploadedBy, filename, skus: [{sku, qty}] }
// ---------------------------------------------------------------- */
// app.post("/api/dispatch/branch-upload", async (req, res) => {
//   const {
//     division,
//     vendor,
//     batchLabel,
//     branchName,
//     uploadedBy,
//     filename,
//     skus,
//   } = req.body;
//   if (
//     !division ||
//     !vendor ||
//     !batchLabel ||
//     !branchName ||
//     !Array.isArray(skus) ||
//     skus.length === 0 
//   ) {
//     return res.status(400).json({
//       ok: false,
//       error: "division, vendor, batchLabel, branchName and skus[] required",
//     });
//   }
//   const client = await pool.connect();
//   try {
//     await client.query("BEGIN");

//     const { rows: vcheck } = await client.query(
//       "SELECT 1 FROM vendors WHERE division = $1 AND vendor_name = $2",
//       [division, vendor],
//     );
//     if (vcheck.length === 0) {
//       await client.query("ROLLBACK");
//       return res.status(400).json({
//         ok: false,
//         error: `Vendor "${vendor}" not found for ${division}.`,
//       });
//     }
//     const { rows: scheck } = await client.query(
//       "SELECT 1 FROM store_list WHERE store_name = $1",
//       [branchName],
//     );
//     if (scheck.length === 0) {
//       await client.query("ROLLBACK");
//       return res
//         .status(400)
//         .json({ ok: false, error: `Unknown branch "${branchName}".` });
//     }

//     const { rows: existing } = await client.query(
//       `SELECT id, set_number FROM dispatch_batches
//        WHERE division=$1 AND vendor=$2 AND batch_label=$3 AND branch_name=$4`,
//       [division, vendor, batchLabel, branchName],
//     );

//     let batchId, setNumber;
//     if (existing.length > 0) {
//       batchId = existing[0].id;
//       setNumber = existing[0].set_number;
//       await client.query(
//         `UPDATE dispatch_batches SET uploaded_by=$2, source_filename=$3, updated_at=now() WHERE id=$1`,
//         [batchId, uploadedBy || "Unattributed", filename || null],
//       );
//     } else {
//       const { rows: maxRow } = await client.query(
//         `SELECT COALESCE(MAX(set_number), 1) AS mx FROM dispatch_batches
//          WHERE division=$1 AND vendor=$2 AND batch_label=$3`,
//         [division, vendor, batchLabel],
//       );
//       setNumber = Number(maxRow[0].mx) + 1;
//       const { rows: ins } = await client.query(
//         `INSERT INTO dispatch_batches (division, vendor, batch_label, set_number, branch_name, uploaded_by, source_filename)
//          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
//         [
//           division,
//           vendor,
//           batchLabel,
//           setNumber,
//           branchName,
//           uploadedBy || "Unattributed",
//           filename || null,
//         ],
//       );
//       batchId = ins[0].id;
//     }

//     await client.query("DELETE FROM dispatch_batch_items WHERE batch_id = $1", [
//       batchId,
//     ]);
//     const cleanSkus = [
//       ...new Set(skus.map((s) => String(s.sku || s).trim()).filter(Boolean)),
//     ];
//     const qtyMap = {};
//     skus.forEach((s) => {
//       const k = String(s.sku || s).trim();
//       if (k) qtyMap[k] = Number(s.qty) || 1;
//     });
//     if (cleanSkus.length > 0) {
//       await client.query(
//         `INSERT INTO dispatch_batch_items (batch_id, sku, qty)
//          SELECT $1, s, q FROM unnest($2::text[], $3::int[]) AS t(s, q)`,
//         [batchId, cleanSkus, cleanSkus.map((s) => qtyMap[s] || 1)],
//       );
//     }
//     await client.query("COMMIT");
//     res.json({ ok: true, batchId, setNumber, skuCount: cleanSkus.length });
//   } catch (e) {
//     await client.query("ROLLBACK");
//     console.error("branch-upload error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   } finally {
//     client.release();
//   }
// });

// /* ----------------------------------------------------------------
//    GET /api/dispatch/comparison?division=&vendor=&batchLabel=
// ---------------------------------------------------------------- */
// app.get("/api/dispatch/comparison", async (req, res) => {
//   const { division, vendor, batchLabel, setLabel, branchName } = req.query;
//   if (!division || !vendor || !batchLabel) return res.status(400).json({ ok: false, error: "division, vendor, batchLabel required" });
//   try {
//     const { rows } = await pool.query(
//       `SELECT b.branch_name, b.source, b.uploaded_by, b.uploaded_at,
//               array_agg(DISTINCT i.sku) FILTER (WHERE i.sku IS NOT NULL) AS skus
//        FROM dispatch_batches b
//        LEFT JOIN dispatch_batch_items i ON i.batch_id = b.id
//        WHERE b.division=$1 AND b.vendor=$2 AND b.batch_label=$3
//          AND ($4::text IS NULL OR b.set_label = $4)
//          AND ($5::text IS NULL OR b.branch_name = $5)
//        GROUP BY b.branch_name, b.source, b.uploaded_by, b.uploaded_at`,
//       [division, vendor, batchLabel, setLabel || null, branchName || null]
//     );

//     const byBranch = {};
//     rows.forEach(r => { (byBranch[r.branch_name] ||= {})[r.source] = r; });

//     const results = Object.entries(byBranch).map(([branch, sides]) => {
//       const dispatched = new Set((sides.dispatched?.skus || []).map(s => s.toLowerCase()));
//       const received = new Set((sides.received?.skus || []).map(s => s.toLowerCase()));
//       const missing = [...dispatched].filter(s => !received.has(s));
//       const extra = [...received].filter(s => !dispatched.has(s));
//       return {
//         branchName: branch,
//         dispatchedCount: dispatched.size,
//         receivedCount: received.size,
//         matched: dispatched.size - missing.length,
//         missingSkus: missing,
//         extraSkus: extra,
//         allMatching: !!sides.dispatched && !!sides.received && missing.length === 0 && extra.length === 0,
//         hasDispatch: !!sides.dispatched,
//         hasReceipt: !!sides.received,
//         dispatchedAt: sides.dispatched?.uploaded_at || null,
//         receivedAt: sides.received?.uploaded_at || null,
//       };
//     });

//     res.json({ ok: true, branches: results });
//   } catch (e) {
//     console.error("comparison error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

// /* ----------------------------------------------------------------
//    GET /api/dispatch/groups?division=
// ---------------------------------------------------------------- */
// app.get("/api/dispatch/groups", async (req, res) => {
//   const { division } = req.query;
//   if (!division) return res.status(400).json({ ok: false, error: "division required" });
//   try {
//     const { rows } = await pool.query(
//       `SELECT vendor, batch_label,
//               COUNT(DISTINCT branch_name) FILTER (WHERE source = 'dispatched') AS dispatched_branches,
//               COUNT(DISTINCT branch_name) FILTER (WHERE source = 'received') AS received_branches
//        FROM dispatch_batches WHERE division = $1
//        GROUP BY vendor, batch_label ORDER BY vendor, batch_label DESC`,
//       [division]
//     );
//     res.json({ ok: true, groups: rows });
//   } catch (e) {
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });



// /* ----------------------------------------------------------------
//    GET /api/dispatch/batch-labels?division=&vendor=
//    Distinct batch labels already used for this vendor — dropdown source.
// ---------------------------------------------------------------- */
// app.get("/api/dispatch/batch-labels", async (req, res) => {
//   const { division, vendor } = req.query;
//   if (!division || !vendor) return res.status(400).json({ ok: false, error: "division and vendor required" });
//   try {
//     const { rows } = await pool.query(
//       `SELECT DISTINCT batch_label FROM dispatch_batches WHERE division=$1 AND vendor=$2 ORDER BY batch_label DESC`,
//       [division, vendor]
//     );
//     res.json({ ok: true, batchLabels: rows.map(r => r.batch_label) });
//   } catch (e) {
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });


// /* ----------------------------------------------------------------
//    GET /api/dispatch/set-labels?division=&vendor=&batchLabel=&branchName=
//    Distinct set labels that have a 'dispatched' row for this batch —
//    used so a branch scanning "received" only ever sees sets that were
//    actually sent to them, never sets that don't exist yet.
//    branchName is optional: omit for the admin panel (all sets in the
//    batch), pass it for a branch's own scan screen (only sets sent to them).
// ---------------------------------------------------------------- */
// app.get("/api/dispatch/set-labels", async (req, res) => {
//   const { division, vendor, batchLabel, branchName } = req.query;
//   if (!division || !vendor || !batchLabel) {
//     return res.status(400).json({ ok: false, error: "division, vendor, batchLabel required" });
//   }
//   try {
//     const { rows } = await pool.query(
//       `SELECT DISTINCT set_label FROM dispatch_batches
//        WHERE division=$1 AND vendor=$2 AND batch_label=$3 AND source='dispatched'
//          AND ($4::text IS NULL OR branch_name = $4)
//        ORDER BY set_label ASC`,
//       [division, vendor, batchLabel, branchName || null]
//     );
//     res.json({ ok: true, setLabels: rows.map(r => r.set_label) });
//   } catch (e) {
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

// /* ----------------------------------------------------------------
//    GET /api/dispatch/set-summary?division=&vendor=&batchLabel=
//    Set-by-set view: which branches a set was dispatched to, and
//    whether each has confirmed receipt yet. Used for the admin panel's
//    "dispatched to" breakdown.
// ---------------------------------------------------------------- */
// app.get("/api/dispatch/set-summary", async (req, res) => {
//   const { division, vendor, batchLabel } = req.query;
//   if (!division || !vendor || !batchLabel) {
//     return res.status(400).json({ ok: false, error: "division, vendor, batchLabel required" });
//   }
//   try {
//     const { rows } = await pool.query(
//       `SELECT set_label, branch_name, source, uploaded_at,
//               (SELECT COUNT(*) FROM dispatch_batch_items i WHERE i.batch_id = b.id) AS sku_count
//        FROM dispatch_batches b
//        WHERE division=$1 AND vendor=$2 AND batch_label=$3
//        ORDER BY set_label, branch_name, source`,
//       [division, vendor, batchLabel]
//     );

//     const bySet = {};
//     rows.forEach(r => {
//       const set = (bySet[r.set_label] ||= {});
//       const branch = (set[r.branch_name] ||= {});
//       branch[r.source] = { uploadedAt: r.uploaded_at, skuCount: Number(r.sku_count) };
//     });

//     const sets = Object.entries(bySet).map(([setLabel, branches]) => ({
//       setLabel,
//       branches: Object.entries(branches).map(([branchName, sides]) => ({
//         branchName,
//         dispatchedAt: sides.dispatched?.uploadedAt || null,
//         dispatchedCount: sides.dispatched?.skuCount || 0,
//         receivedAt: sides.received?.uploadedAt || null,
//         receivedCount: sides.received?.skuCount || 0,
//         status: !sides.dispatched ? "not_dispatched" : !sides.received ? "awaiting_receipt" : "received",
//       })),
//     }));

//     res.json({ ok: true, sets });
//   } catch (e) {
//     console.error("set-summary error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });
// /* ----------------------------------------------------------------
//    DELETE /api/dispatch/batch   body: { batchId }
//    Removes one batch (admin reference OR a specific branch upload)
//    and all its SKU items. Use to fix mistakes like wrong branch/vendor.
// ---------------------------------------------------------------- */
// app.post("/api/dispatch/delete-batch", async (req, res) => {
//   const { batchId } = req.body;
//   if (!batchId)
//     return res.status(400).json({ ok: false, error: "batchId required" });
//   const client = await pool.connect();
//   try {
//     await client.query("BEGIN");
//     await client.query("DELETE FROM dispatch_batch_items WHERE batch_id = $1", [
//       batchId,
//     ]);
//     const { rows } = await client.query(
//       "DELETE FROM dispatch_batches WHERE id = $1 RETURNING *",
//       [batchId],
//     );
//     await client.query("COMMIT");
//     if (!rows.length)
//       return res.status(404).json({ ok: false, error: "Batch not found" });
//     res.json({ ok: true, deleted: rows[0] });
//   } catch (e) {
//     await client.query("ROLLBACK");
//     console.error("delete-batch error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   } finally {
//     client.release();
//   }
// });

// /* ----------------------------------------------------------------
//    GET /api/dispatch/batches?division=&vendor=&batchLabel=
//    Lists every set (admin ref + all branches) for a batch, with ids
//    so the frontend can offer delete/manage actions.
// ---------------------------------------------------------------- */
// app.get("/api/dispatch/batches", async (req, res) => {
//   const { division, vendor, batchLabel } = req.query;
//   if (!division || !vendor || !batchLabel)
//     return res.status(400).json({ ok: false, error: "division, vendor, batchLabel required" });
//   try {
//     const { rows } = await pool.query(
//       `SELECT b.id, b.branch_name, b.source, b.uploaded_by, b.uploaded_at,
//               COUNT(i.sku) AS sku_count,
//               COALESCE(SUM(i.scan_count), 0) AS total_scans
//        FROM dispatch_batches b
//        LEFT JOIN dispatch_batch_items i ON i.batch_id = b.id
//        WHERE b.division=$1 AND b.vendor=$2 AND b.batch_label=$3
//        GROUP BY b.id
//        ORDER BY b.branch_name ASC, b.source ASC`,
//       [division, vendor, batchLabel]
//     );
//     res.json({ ok: true, batches: rows });
//   } catch (e) {
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

// /* ----------------------------------------------------------------
//    POST /api/dispatch/rename-batch
//    body: { division, vendor, oldBatchLabel, newBatchLabel }
//    Renames every set (admin ref + all branches) under one batch label
//    at once, since they're grouped together by (division, vendor, batch_label).
// ---------------------------------------------------------------- */
// app.post("/api/dispatch/rename-batch", async (req, res) => {
//   const { division, vendor, oldBatchLabel, newBatchLabel } = req.body;
//   if (!division || !vendor || !oldBatchLabel || !newBatchLabel) {
//     return res.status(400).json({
//       ok: false,
//       error: "division, vendor, oldBatchLabel, newBatchLabel required",
//     });
//   }
//   if (oldBatchLabel === newBatchLabel) {
//     return res
//       .status(400)
//       .json({ ok: false, error: "New label is the same as the old one" });
//   }
//   try {
//     // Prevent silently merging into an already-existing different batch
//     const { rows: clash } = await pool.query(
//       `SELECT 1 FROM dispatch_batches WHERE division=$1 AND vendor=$2 AND batch_label=$3 LIMIT 1`,
//       [division, vendor, newBatchLabel],
//     );
//     if (clash.length > 0) {
//       return res.status(400).json({
//         ok: false,
//         error: `A batch named "${newBatchLabel}" already exists for this vendor — pick a different name or delete it first.`,
//       });
//     }
//     const { rows } = await pool.query(
//       `UPDATE dispatch_batches SET batch_label = $4, updated_at = now()
//        WHERE division=$1 AND vendor=$2 AND batch_label=$3
//        RETURNING id`,
//       [division, vendor, oldBatchLabel, newBatchLabel],
//     );
//     res.json({ ok: true, renamed: rows.length });
//   } catch (e) {
//     console.error("rename-batch error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });


// app.post("/api/dispatch/scan-undo", async (req, res) => {
//   const { batchId, sku } = req.body;
//   if (!batchId || !sku) return res.status(400).json({ ok: false, error: "batchId and sku required" });
//   const client = await pool.connect();
//   try {
//     await client.query("BEGIN");
//     const { rows } = await client.query(
//       `UPDATE dispatch_batch_items SET scan_count = scan_count - 1, last_scanned_at = now()
//        WHERE batch_id=$1 AND sku=$2 AND scan_count > 0
//        RETURNING scan_count`,
//       [batchId, sku]
//     );
//     if (!rows.length) {
//       await client.query("ROLLBACK");
//       return res.status(404).json({ ok: false, error: "Item not found" });
//     }
//     let scanCount = rows[0].scan_count;
//     let removed = false;
//     if (scanCount <= 0) {
//       await client.query(`DELETE FROM dispatch_batch_items WHERE batch_id=$1 AND sku=$2`, [batchId, sku]);
//       removed = true;
//     }
//     await client.query("COMMIT");
//     res.json({ ok: true, scanCount, removed });
//   } catch (e) {
//     await client.query("ROLLBACK");
//     console.error("scan-undo error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   } finally { client.release(); }
// });




// app.post("/api/dispatch/scan", async (req, res) => {
//   const { division, vendor, batchLabel, setLabel, branchName, source, sku, scannedBy } = req.body;
//   if (!division || !vendor || !batchLabel || !setLabel || !branchName || !source || !sku) {
//     return res.status(400).json({ ok: false, error: "division, vendor, batchLabel, setLabel, branchName, source, sku required" });
//   }
//   if (!["dispatched", "received"].includes(source)) {
//     return res.status(400).json({ ok: false, error: "source must be 'dispatched' or 'received'" });
//   }
//   const client = await pool.connect();
//   try {
//     await client.query("BEGIN");

//     const { rows: vcheck } = await client.query("SELECT 1 FROM vendors WHERE division=$1 AND vendor_name=$2", [division, vendor]);
//     if (!vcheck.length) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: `Vendor "${vendor}" not found.` }); }
//     const { rows: scheck } = await client.query("SELECT 1 FROM store_list WHERE store_name=$1", [branchName]);
//     if (!scheck.length) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: `Unknown branch "${branchName}".` }); }

//     // Branch scanning "received" against a set that was never dispatched to
//     // them is almost certainly a mistake — block it early with a clear error.
//     if (source === "received") {
//       const { rows: dcheck } = await client.query(
//         `SELECT id FROM dispatch_batches
//          WHERE division=$1 AND vendor=$2 AND batch_label=$3 AND set_label=$4 AND branch_name=$5 AND source='dispatched'`,
//         [division, vendor, batchLabel, setLabel, branchName]
//       );
//       if (!dcheck.length) {
//         await client.query("ROLLBACK");
//         return res.status(400).json({ ok: false, error: `${setLabel} was never dispatched to ${branchName} for this batch.` });
//       }

//       // NEW: the scanned SKU must actually be part of what was dispatched
//       // for this set/branch — not just "something" was dispatched.
//       const dispatchedBatchId = dcheck[0].id;
//       const { rows: skuCheck } = await client.query(
//         `SELECT 1 FROM dispatch_batch_items WHERE batch_id=$1 AND sku ILIKE $2`,
//         [dispatchedBatchId, String(sku).trim()]
//       );
//       if (!skuCheck.length) {
//         await client.query("ROLLBACK");
//         return res.status(400).json({
//           ok: false,
//           error: `SKU "${sku}" was not part of the dispatched list for ${setLabel} → ${branchName}.`,
//         });
//       }
//     }

//     let { rows: batchRows } = await client.query(
//       `SELECT id FROM dispatch_batches WHERE division=$1 AND vendor=$2 AND batch_label=$3 AND set_label=$4 AND branch_name=$5 AND source=$6`,
//       [division, vendor, batchLabel, setLabel, branchName, source]
//     );
//     let batchId;
//     if (batchRows.length === 0) {
//       const ins = await client.query(
//         `INSERT INTO dispatch_batches (division, vendor, batch_label, set_label, branch_name, source, uploaded_by)
//          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
//         [division, vendor, batchLabel, setLabel, branchName, source, scannedBy || "Unattributed"]
//       );
//       batchId = ins.rows[0].id;
//     } else {
//       batchId = batchRows[0].id;
//       await client.query(`UPDATE dispatch_batches SET updated_at=now(), uploaded_by=$2 WHERE id=$1`, [batchId, scannedBy || "Unattributed"]);
//     }

//     const cleanSku = String(sku).trim();
//     const { rows: upsert } = await client.query(
//       `INSERT INTO dispatch_batch_items (batch_id, sku, qty, scan_count, first_scanned_at, last_scanned_at)
//        VALUES ($1,$2,1,1,now(),now())
//        ON CONFLICT (batch_id, sku) DO UPDATE SET
//          scan_count = dispatch_batch_items.scan_count + 1,
//          last_scanned_at = now()
//        RETURNING scan_count`,
//       [batchId, cleanSku]
//     );
//     const scanCount = upsert[0].scan_count;

//     const { rows: totals } = await client.query(
//       `SELECT COUNT(*) AS unique_skus, COALESCE(SUM(scan_count),0) AS total_scans FROM dispatch_batch_items WHERE batch_id=$1`,
//       [batchId]
//     );

//     await client.query("COMMIT");
//     res.json({
//       ok: true, batchId, sku: cleanSku,
//       scanCount, isDuplicate: scanCount > 1,
//       uniqueSkus: Number(totals[0].unique_skus),
//       totalScans: Number(totals[0].total_scans),
//     });
//   } catch (e) {
//     await client.query("ROLLBACK");
//     console.error("dispatch/scan error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   } finally { client.release(); }
// });


// app.get("/api/dispatch/scan-log", async (req, res) => {
//   const { division, vendor, batchLabel, setLabel, branchName, source } = req.query;
//   if (!division || !vendor || !batchLabel || !setLabel || !branchName || !source) {
//     return res.status(400).json({ ok: false, error: "all params required" });
//   }
//   try {
//     const { rows } = await pool.query(
//       `SELECT i.sku, i.scan_count, i.first_scanned_at, i.last_scanned_at, b.id AS batch_id
//        FROM dispatch_batch_items i
//        JOIN dispatch_batches b ON b.id = i.batch_id
//        WHERE b.division=$1 AND b.vendor=$2 AND b.batch_label=$3 AND b.set_label=$4 AND b.branch_name=$5 AND b.source=$6
//        ORDER BY i.last_scanned_at DESC`,
//       [division, vendor, batchLabel, setLabel, branchName, source]
//     );
//     res.json({ ok: true, items: rows, batchId: rows.length ? rows[0].batch_id : null });
//   } catch (e) {
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });


// /* ----------------------------------------------------------------
//    GET /api/dispatch/branch-pending?division=&branchName=
//    Every batch dispatched TO this branch, with whether it's been
//    received yet and when it was dispatched — powers the Branch Upload
//    dashboard so the branch can see what's waiting on them.
// ---------------------------------------------------------------- */
// /* ----------------------------------------------------------------
//    GET /api/dispatch/branch-pending?division=&branchName=
//    Every batch dispatched TO this branch, with how many SKUs are
//    still pending (dispatched but not yet scanned as received) —
//    powers the Branch Upload dashboard.
// ---------------------------------------------------------------- */
// app.get("/api/dispatch/branch-pending", async (req, res) => {
//   const { division, branchName } = req.query;
//   if (!division || !branchName) {
//     return res.status(400).json({ ok: false, error: "division and branchName required" });
//   }
//   try {
//     const { rows } = await pool.query(
//       `SELECT
//          d.id AS dispatch_batch_id,
//          d.vendor, d.batch_label, d.set_label, d.uploaded_at AS dispatched_at,
//          array_agg(DISTINCT di.sku) FILTER (WHERE di.sku IS NOT NULL) AS dispatched_skus,
//          r.id AS received_batch_id,
//          r.uploaded_at AS received_at,
//          array_agg(DISTINCT ri.sku) FILTER (WHERE ri.sku IS NOT NULL) AS received_skus
//        FROM dispatch_batches d
//        LEFT JOIN dispatch_batch_items di ON di.batch_id = d.id
//        LEFT JOIN dispatch_batches r
//          ON r.division = d.division AND r.vendor = d.vendor AND r.batch_label = d.batch_label
//          AND r.set_label = d.set_label AND r.branch_name = d.branch_name AND r.source = 'received'
//        LEFT JOIN dispatch_batch_items ri ON ri.batch_id = r.id
//        WHERE d.division = $1 AND d.branch_name = $2 AND d.source = 'dispatched'
//        GROUP BY d.id, r.id
//        ORDER BY d.uploaded_at DESC`,
//       [division, branchName]
//     );

//     const result = rows.map(r => {
//       const dispatchedSet = new Set((r.dispatched_skus || []).map(s => s.toLowerCase()));
//       const receivedSet = new Set((r.received_skus || []).map(s => s.toLowerCase()));
//       const pendingSkus = [...dispatchedSet].filter(s => !receivedSet.has(s));
//       return {
//         vendor: r.vendor,
//         batch_label: r.batch_label,
//         set_label: r.set_label,
//         dispatched_at: r.dispatched_at,
//         received_at: r.received_at,
//         dispatched_count: dispatchedSet.size,
//         received_count: receivedSet.size,
//         pending_count: pendingSkus.length,
//         fully_received: dispatchedSet.size > 0 && pendingSkus.length === 0,
//       };
//     });

//     res.json({ ok: true, rows: result });
//   } catch (e) {
//     console.error("branch-pending error", e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });


// const server = app.listen(process.env.PORT, () => {
//   console.log(`Server running on http://localhost:${process.env.PORT}`);
// });


// let isShuttingDown = false;

// async function gracefulShutdown(signal) {
//   if (isShuttingDown) return;
//   isShuttingDown = true;
//   console.log(`${signal} received — starting graceful shutdown`);

//   // 1. Stop accepting new HTTP requests
//   server.close(() => {
//     console.log("HTTP server closed — no new requests accepted");
//   });

//   // 2. Give in-flight requests a window to finish before forcing exit
//   const forceExitTimer = setTimeout(() => {
//     console.error("Forced shutdown — requests did not finish in time");
//     process.exit(1);
//   }, 10000); // 10s grace period

//   try {
//     await pool.end(); // waits for checked-out clients to finish their queries
//     clearTimeout(forceExitTimer);
//     console.log("DB pool closed cleanly");
//     process.exit(0);
//   } catch (err) {
//     console.error("Error while closing DB pool:", err); 
//     process.exit(1);
//   }
// }

// process.on("SIGINT", () => gracefulShutdown("SIGINT"));
// process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));





require("dotenv").config();
const express = require("express");
const { BigQuery } = require("@google-cloud/bigquery");
const cors = require("cors");

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "25mb" }));

const PROJECT_ID = process.env.BIGQUERY_PROJECT_ID;
const APP_DATASET = process.env.BQ_APP_DATASET; // card_tracker
const DEST_DATASET = process.env.BQ_DEST_DATASET; // shared_rds_data
const LOCATION = process.env.BQ_LOCATION;

const bigquery = new BigQuery({
  projectId: PROJECT_ID,
  location: LOCATION,
});

const T = (table, dataset = DEST_DATASET) =>
  `\`${PROJECT_ID}.${dataset}.${table}\``;

function toBqParams(params = [], types = {}) {
  const out = {};
  const outTypes = {};
  params.forEach((val, i) => {
    const key = `p${i + 1}`;
    out[key] = val === undefined ? null : val;
    if (types[key]) outTypes[key] = types[key];
    else if (val === null || val === undefined) outTypes[key] = "STRING";
  });
  return { params: out, types: outTypes };
}

async function runQuery(sql, params = [], types = {}) {
  const converted = sql.replace(/\$(\d+)/g, "@p$1");
  const { params: queryParams, types: paramTypes } = toBqParams(params, types);
  const [rows] = await bigquery.query({
    query: converted,
    location: LOCATION,
    params: queryParams,
    types: paramTypes,
  });
  return { rows, rowCount: rows.length };
}
const db = { query: runQuery };

const pool = db;

const MAX_PRODUCTS = 100000;

async function getProductCount(client = db) {
  const { rows } = await client.query(
    `SELECT COUNT(*) AS count FROM ${T("products")}`,
  );
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
    await db.query("SELECT 1");
    res.json({ ok: true, db: "connected to BigQuery successfully!" });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/health/pool", (req, res) => {
  res.json({ type: "bigquery", pool: "not applicable (serverless)" });
});
async function loadFullProduct(client, productId) {
  const { rows: prows } = await client.query(
    `SELECT * FROM ${T("products")} WHERE id = $1`,
    [productId],
  );
  if (!prows.length) return null;
  return hydrateProducts(client, prows).then((arr) => arr[0]);
}
// app.get("/test/schema", async (req, res) => {
//   try {
//     const out = {};
//     const [datasets] = await bigquery.getDatasets();
//     for (const ds of datasets) {
//       const [meta] = await ds.getMetadata();
//       const [tables] = await ds.getTables();
//       out[ds.id] = {
//         location: meta.location,
//         tables: tables.map((t) => t.id),
//       };
//     }
//     res.json(out);
//   } catch (e) {
//     res.json({ error: e.message });
//   }
// });
//
// app.get("/test/products", async (req, res) => {
//   try {
//     const { rows } = await db.query(`SELECT * FROM ${T("products")} LIMIT 3`);
//     res.json(rows);
//   } catch (e) {
//     res.json({ error: e.message });
//   }
// });
//
//
//
//
//
//
/* ----------------------------------------------------------------
   BigQuery value helpers
   TIMESTAMP / DATE come back as { value: "..." } objects, not Dates
---------------------------------------------------------------- */
const iso = (v) => {
  if (!v) return "";
  const raw = v.value ?? v;
  const d = new Date(raw);
  return isNaN(d) ? "" : d.toISOString();
};

const dateOnly = (v) => {
  if (!v) return "";
  const raw = v.value ?? v;
  const d = new Date(raw);
  return isNaN(d) ? String(raw).slice(0, 10) : d.toISOString().slice(0, 10);
};

// Columns that were arrays/JSON in Postgres can come back as a string,
// an array, or a JSON object. This normalises all of them.
const parseJson = (v, fallback = null) => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "object" && "value" in v && typeof v.value === "string") {
    v = v.value; // BigQuery JSON wrapper
  }
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
};

/* ----------------------------------------------------------------
   hydrateProducts
---------------------------------------------------------------- */
async function hydrateProducts(client, productRows) {
  if (productRows.length === 0) return [];
  const ids = productRows.map((p) => String(p.id));

  const [{ rows: stageRows }, { rows: storeRows }] = await Promise.all([
    client.query(
      `SELECT * FROM ${T("stage_entries")} WHERE product_id IN UNNEST($1)`,
      [ids],
    ),
    client.query(
      `SELECT * FROM ${T("stores")} WHERE product_id IN UNNEST($1)`,
      [ids],
    ),
  ]);

  const stagesByProduct = {};
  stageRows.forEach((r) => {
    (stagesByProduct[r.product_id] ||= {})[r.stage_key] = {
      status: r.status,
      person: r.person || "",
      comments: r.comments || "",
      skipped: !!r.skipped,
      at: iso(r.updated_at),
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
      receivedAt: iso(r.received_at),
      receivedBy: r.received_by || "",
      missing: r.missing,
      damaged: r.damaged,
      notes: r.notes || "",
      at: iso(r.updated_at),
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
      inward: dateOnly(p.inward),
      qty: p.qty || 0,
      note: p.note || "",
      set_no: p.set_no || "",
      verdict: p.verdict || "",
      issues: p.issues || "",
      stages,
      stores,
      createdAt: iso(p.created_at),
      updatedAt: iso(p.updated_at),
    };
  });
}

/* ----------------------------------------------------------------
   GET /api/getAll  — equivalent of gsGet() / action=getAll
---------------------------------------------------------------- */
app.get("/api/getAll", async (req, res) => {
  try {
    // Independent queries run in parallel (BigQuery has ~1s latency each)
    const [
      { rows: productRows },
      { rows: vendorRows },
      { rows: teamRows },
      { rows: assignRows },
      { rows: qcRows },
      { rows: auditRows },
      { rows: historyRows },
    ] = await Promise.all([
      db.query(`SELECT * FROM ${T("products")} ORDER BY created_at DESC`),
      db.query(
        `SELECT division, vendor_name FROM ${T("vendors")} ORDER BY vendor_name`,
      ),
      db.query(`SELECT * FROM ${T("users")} WHERE role = 'member'`),
      db.query(`SELECT * FROM ${T("assignments")} ORDER BY assigned_at DESC`),
      db.query(`SELECT * FROM ${T("qc_audit")} ORDER BY audited_at DESC`),
      db.query(
        `SELECT * FROM ${T("audit_log")} ORDER BY logged_at DESC LIMIT 800`,
      ),
      db.query(
        `SELECT ah.*,
                u1.name AS to_member_name,
                u2.name AS from_member_name
         FROM ${T("assignment_history")} ah
         LEFT JOIN ${T("users")} u1 ON u1.id = ah.to_member_id
         LEFT JOIN ${T("users")} u2 ON u2.id = ah.from_member_id
         ORDER BY ah.logged_at DESC LIMIT 500`,
      ),
    ]);

    const products = await hydrateProducts(db, productRows);

    const vendors = {};
    vendorRows.forEach((v) => {
      (vendors[v.division] ||= []).push(v.vendor_name);
    });

    const teamMembers = teamRows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      password: u.password,
      role: u.role,
      stages: parseJson(u.stages, []),
      division: u.division,
      managerId: u.manager_id,
      joinedAt: iso(u.joined_at),
    }));

    const assignments = assignRows.map((a) => ({
      id: a.id,
      memberId: a.member_id,
      managerId: a.manager_id,
      sku: a.sku,
      stage: a.stage,
      division: a.division,
      assignedAt: iso(a.assigned_at),
    }));

    const qcAudit = qcRows.map((q) => ({
      id: q.id,
      at: iso(q.audited_at),
      auditor: q.auditor_name,
      sku: q.sku,
      division: q.division,
      productId: q.product_id,
      verdict: q.verdict,
      comments: q.comments,
      stagesSentBack: parseJson(q.stages_sent_back, []),
    }));

    const audit = auditRows.map((a) => ({
      id: a.id,
      at: iso(a.logged_at),
      actor: a.actor_name,
      action: a.action,
      entity: a.entity,
      detail: a.detail,
      division: a.division,
    }));

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
      at: iso(r.logged_at),
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
  }
});

/* ----------------------------------------------------------------
   GET /api/getUsers
---------------------------------------------------------------- */
app.get("/api/getUsers", async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT * FROM ${T("users")}`);
    res.json(
      rows.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        password: u.password,
        role: u.role,
        stages: parseJson(u.stages, []),
        division: u.division,
        managerId: u.manager_id,
        joinedAt: iso(u.joined_at),
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

   BigQuery notes:
   - Row-by-row upserts would be extremely slow (~1s per statement), so each
     chunk of products is sent as ONE JSON parameter and applied with three
     MERGE statements (products, stage_entries, stores).
   - The three MERGEs run inside one transaction script, so a chunk is
     all-or-nothing.
---------------------------------------------------------------- */
const UPSERT_CHUNK_SIZE = 100;

app.post("/api/batchUpsertProducts", async (req, res) => {
  const input = req.body;
  if (!Array.isArray(input))
    return res.status(400).json({ ok: false, error: "expected array" });
  if (input.length === 0) return res.json({ ok: true, count: 0 });

  try {
    // De-duplicate by id (MERGE fails if two source rows hit the same target row)
    const byId = new Map();
    input.forEach((p) => {
      if (p && p.id) byId.set(String(p.id), p);
    });
    const products = [...byId.values()];
    const nowIso = new Date().toISOString();

    // ---- Cap check ----
    const currentCount = await getProductCount(db);
    const { rows: existingIdCheck } = await db.query(
      `SELECT id FROM ${T("products")} WHERE id IN UNNEST($1)`,
      [[...byId.keys()]],
    );
    const existingIdSet = new Set(existingIdCheck.map((r) => String(r.id)));
    const newCount = products.filter(
      (p) => !existingIdSet.has(String(p.id)),
    ).length;

    if (currentCount + newCount > MAX_PRODUCTS) {
      return res.status(400).json({
        ok: false,
        error: `Product cap of ${MAX_PRODUCTS} would be exceeded. Currently ${currentCount}, trying to add ${newCount} new products.`,
      });
    }

    const numOrNull = (v) => (v ? Number(v) || null : null);

    // ---- Apply in chunks ----
    for (let i = 0; i < products.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = products.slice(i, i + UPSERT_CHUNK_SIZE);

      const productRows = [];
      const stageRows = [];
      const storeRows = [];

      for (const p of chunk) {
        productRows.push({
          id: String(p.id),
          division: p.division ?? null,
          sku: p.sku ?? null,
          name: p.name || "",
          vendor: p.vendor || null,
          inward: p.inward || null,
          qty: p.qty || 0,
          note: p.note || "",
          set_no: p.set_no || null,
          verdict: p.verdict || null,
          issues: p.issues || "",
          created_at: p.createdAt || nowIso,
          updated_at: p.updatedAt || nowIso,
        });

        if (p.stages) {
          for (const key of Object.keys(p.stages)) {
            const s = p.stages[key] || {};
            stageRows.push({
              product_id: String(p.id),
              stage_key: key,
              status: s.status || "Not Started",
              person: s.person || null,
              comments: s.comments || "",
              updated_at: s.at || nowIso,
              width_cm: numOrNull(s.width),
              height_cm: numOrNull(s.height),
              weight_gm: numOrNull(s.weight),
            });
          }
        }

        if (p.stores) {
          for (const store of Object.keys(p.stores)) {
            const s = p.stores[store] || {};
            storeRows.push({
              product_id: String(p.id),
              store,
              dispatched: s.dispatched || 0,
              received: !!s.received,
              received_at: s.receivedAt || null,
              received_by: s.receivedBy || null,
              missing: s.missing || 0,
              damaged: s.damaged || 0,
              notes: s.notes || "",
              updated_at: s.at || nowIso,
            });
          }
        }
      }

      const script = `
BEGIN TRANSACTION;

MERGE ${T("products")} t
USING (
  SELECT
    JSON_VALUE(j, '$.id') AS id,
    JSON_VALUE(j, '$.division') AS division,
    JSON_VALUE(j, '$.sku') AS sku,
    JSON_VALUE(j, '$.name') AS name,
    JSON_VALUE(j, '$.vendor') AS vendor,
    SAFE_CAST(SUBSTR(JSON_VALUE(j, '$.inward'), 1, 10) AS DATE) AS inward,
    SAFE_CAST(JSON_VALUE(j, '$.qty') AS INT64) AS qty,
    JSON_VALUE(j, '$.note') AS note,
    JSON_VALUE(j, '$.set_no') AS set_no,
    JSON_VALUE(j, '$.verdict') AS verdict,
    JSON_VALUE(j, '$.issues') AS issues,
    SAFE_CAST(JSON_VALUE(j, '$.created_at') AS TIMESTAMP) AS created_at,
    SAFE_CAST(JSON_VALUE(j, '$.updated_at') AS TIMESTAMP) AS updated_at
  FROM UNNEST(JSON_QUERY_ARRAY(@p1)) AS j
) s
ON t.id = s.id
WHEN MATCHED THEN UPDATE SET
  division = s.division, sku = s.sku, name = s.name, vendor = s.vendor,
  inward = s.inward, qty = s.qty, note = s.note, set_no = s.set_no,
  verdict = s.verdict, issues = s.issues, updated_at = s.updated_at
WHEN NOT MATCHED THEN INSERT
  (id, division, sku, name, vendor, inward, qty, note, set_no, verdict, issues, created_at, updated_at)
VALUES
  (s.id, s.division, s.sku, s.name, s.vendor, s.inward, s.qty, s.note, s.set_no, s.verdict, s.issues, s.created_at, s.updated_at);

MERGE ${T("stage_entries")} t
USING (
  SELECT
    JSON_VALUE(j, '$.product_id') AS product_id,
    JSON_VALUE(j, '$.stage_key') AS stage_key,
    JSON_VALUE(j, '$.status') AS status,
    JSON_VALUE(j, '$.person') AS person,
    JSON_VALUE(j, '$.comments') AS comments,
    SAFE_CAST(JSON_VALUE(j, '$.updated_at') AS TIMESTAMP) AS updated_at,
    SAFE_CAST(JSON_VALUE(j, '$.width_cm') AS FLOAT64) AS width_cm,
    SAFE_CAST(JSON_VALUE(j, '$.height_cm') AS FLOAT64) AS height_cm,
    SAFE_CAST(JSON_VALUE(j, '$.weight_gm') AS FLOAT64) AS weight_gm
  FROM UNNEST(JSON_QUERY_ARRAY(@p2)) AS j
) s
ON t.product_id = s.product_id AND t.stage_key = s.stage_key
WHEN MATCHED THEN UPDATE SET
  status = s.status, person = s.person, comments = s.comments,
  updated_at = s.updated_at, width_cm = s.width_cm, height_cm = s.height_cm,
  weight_gm = s.weight_gm
WHEN NOT MATCHED THEN INSERT
  (product_id, stage_key, status, person, comments, updated_at, width_cm, height_cm, weight_gm)
VALUES
  (s.product_id, s.stage_key, s.status, s.person, s.comments, s.updated_at, s.width_cm, s.height_cm, s.weight_gm);

MERGE ${T("stores")} t
USING (
  SELECT
    JSON_VALUE(j, '$.product_id') AS product_id,
    JSON_VALUE(j, '$.store') AS store,
    SAFE_CAST(JSON_VALUE(j, '$.dispatched') AS INT64) AS dispatched,
    SAFE_CAST(JSON_VALUE(j, '$.received') AS BOOL) AS received,
    SAFE_CAST(JSON_VALUE(j, '$.received_at') AS TIMESTAMP) AS received_at,
    JSON_VALUE(j, '$.received_by') AS received_by,
    SAFE_CAST(JSON_VALUE(j, '$.missing') AS INT64) AS missing,
    SAFE_CAST(JSON_VALUE(j, '$.damaged') AS INT64) AS damaged,
    JSON_VALUE(j, '$.notes') AS notes,
    SAFE_CAST(JSON_VALUE(j, '$.updated_at') AS TIMESTAMP) AS updated_at
  FROM UNNEST(JSON_QUERY_ARRAY(@p3)) AS j
) s
ON t.product_id = s.product_id AND t.store = s.store
WHEN MATCHED THEN UPDATE SET
  dispatched = s.dispatched, received = s.received, received_at = s.received_at,
  received_by = s.received_by, missing = s.missing, damaged = s.damaged,
  notes = s.notes, updated_at = s.updated_at
WHEN NOT MATCHED THEN INSERT
  (product_id, store, dispatched, received, received_at, received_by, missing, damaged, notes, updated_at)
VALUES
  (s.product_id, s.store, s.dispatched, s.received, s.received_at, s.received_by, s.missing, s.damaged, s.notes, s.updated_at);

COMMIT TRANSACTION;
`;

      // Empty arrays are sent as "[]" so the param type is always STRING
      await db.query(script, [
        JSON.stringify(productRows),
        JSON.stringify(stageRows),
        JSON.stringify(storeRows),
      ]);
    }

    res.json({ ok: true, count: products.length });
  } catch (e) {
    console.error("batchUpsertProducts error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   POST /api/batchPatchStage   body: { ids, stageKey, patch }
   One MERGE for all ids instead of 2 queries per product.
---------------------------------------------------------------- */
app.post("/api/batchPatchStage", async (req, res) => {
  const { ids, stageKey, patch } = req.body;
  if (!Array.isArray(ids) || !stageKey || !patch)
    return res.status(400).json({ ok: false, error: "bad payload" });
  if (ids.length === 0) return res.json({ ok: true, count: 0 });

  try {
    const uniqueIds = [...new Set(ids.map((i) => String(i)))];

    const script = `
BEGIN TRANSACTION;

MERGE ${T("stage_entries")} t
USING (SELECT id AS product_id FROM UNNEST($1) AS id) s
ON t.product_id = s.product_id AND t.stage_key = $2
WHEN MATCHED THEN UPDATE SET
  status = COALESCE($3, t.status),
  person = COALESCE($4, t.person),
  comments = COALESCE($5, t.comments),
  skipped = COALESCE($6, t.skipped),
  updated_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT
  (product_id, stage_key, status, person, comments, skipped, updated_at)
VALUES
  (s.product_id, $2, COALESCE($3, 'Not Started'), $4, $5, COALESCE($6, FALSE), CURRENT_TIMESTAMP());

UPDATE ${T("products")}
SET updated_at = CURRENT_TIMESTAMP()
WHERE id IN UNNEST($1);

COMMIT TRANSACTION;
`;

    await db.query(
      script,
      [
        uniqueIds,
        String(stageKey),
        patch.status || null,
        patch.person ?? null,
        patch.comments ?? "",
        patch.skipped ?? null,
      ],
      { p6: "BOOL" },
    );

    res.json({ ok: true, count: ids.length });
  } catch (e) {
    console.error("batchPatchStage error", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   POST /api/patchQCVerdict   body: { id, verdict, issues }
---------------------------------------------------------------- */
app.post("/api/patchQCVerdict", async (req, res) => {
  const { id, verdict, issues } = req.body;
  try {
    await db.query(
      `UPDATE ${T("products")}
       SET verdict = $2, issues = $3, updated_at = CURRENT_TIMESTAMP()
       WHERE id = $1`,
      [String(id), verdict || null, issues || ""],
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
    // stages_sent_back: arrays are stored as a JSON string
    const sentBack = Array.isArray(e.stagesSentBack)
      ? JSON.stringify(e.stagesSentBack)
      : e.stagesSentBack || "";

    await db.query(
      `INSERT INTO ${T("qc_audit")}
         (id, audited_at, auditor_name, product_id, sku, division, verdict, comments, stages_sent_back)
       VALUES ($1, TIMESTAMP($2), $3, $4, $5, $6, $7, $8, $9)`,
      [
        e.id ? String(e.id) : require("crypto").randomUUID(),
        e.at || new Date().toISOString(),
        e.auditor || "",
        e.productId ?? null,
        e.sku ?? null,
        e.division ?? null,
        e.verdict ?? null,
        e.comments || "",
        sentBack,
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
  if (!productId || !store || !storeData)
    return res.status(400).json({ ok: false, error: "bad payload" });
  try {
    const script = `
BEGIN TRANSACTION;

MERGE ${T("stores")} t
USING (
  SELECT
    $1 AS product_id,
    $2 AS store,
    $3 AS dispatched,
    $4 AS received,
    SAFE_CAST($5 AS TIMESTAMP) AS received_at,
    $6 AS received_by,
    $7 AS missing,
    $8 AS damaged,
    $9 AS notes
) s
ON t.product_id = s.product_id AND t.store = s.store
WHEN MATCHED THEN UPDATE SET
  dispatched = s.dispatched, received = s.received, received_at = s.received_at,
  received_by = s.received_by, missing = s.missing, damaged = s.damaged,
  notes = s.notes, updated_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT
  (product_id, store, dispatched, received, received_at, received_by, missing, damaged, notes, updated_at)
VALUES
  (s.product_id, s.store, s.dispatched, s.received, s.received_at, s.received_by, s.missing, s.damaged, s.notes, CURRENT_TIMESTAMP());

UPDATE ${T("products")} SET updated_at = CURRENT_TIMESTAMP() WHERE id = $1;

COMMIT TRANSACTION;
`;
    await db.query(
      script,
      [
        String(productId),
        store,
        Math.trunc(Number(storeData.dispatched) || 0),
        !!storeData.received,
        storeData.receivedAt || null,
        storeData.receivedBy || null,
        Math.trunc(Number(storeData.missing) || 0),
        Math.trunc(Number(storeData.damaged) || 0),
        storeData.notes || "",
      ],
      { p3: "INT64", p4: "BOOL", p7: "INT64", p8: "INT64" },
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("upsertStore error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   POST /api/appendAssignmentHistory
---------------------------------------------------------------- */
app.post("/api/appendAssignmentHistory", async (req, res) => {
  const e = req.body;
  try {
    await db.query(
      `INSERT INTO ${T("assignment_history")}
         (id, action, sku, division, from_member_id, to_member_id, manager_id, stage, note, logged_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TIMESTAMP($10))`,
      [
        e.id ? String(e.id) : require("crypto").randomUUID(),
        e.action ?? null,
        e.sku ?? null,
        e.division ?? null,
        e.fromMemberId || null,
        e.toMemberId ?? null,
        e.managerId ?? null,
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

/* ----------------------------------------------------------------
   GET /api/assignmentHistory?division=KOC Cards
---------------------------------------------------------------- */
app.get("/api/assignmentHistory", async (req, res) => {
  try {
    const { division } = req.query;
    const { rows } = await db.query(
      `SELECT ah.*,
              u1.name AS to_member_name,
              u2.name AS from_member_name,
              u3.name AS manager_name
       FROM ${T("assignment_history")} ah
       LEFT JOIN ${T("users")} u1 ON u1.id = ah.to_member_id
       LEFT JOIN ${T("users")} u2 ON u2.id = ah.from_member_id
       LEFT JOIN ${T("users")} u3 ON u3.id = ah.manager_id
       WHERE ($1 IS NULL OR ah.division = $1)
       ORDER BY ah.logged_at DESC
       LIMIT 1000`,
      [division || null],
    );
    res.json(rows.map((r) => ({ ...r, logged_at: iso(r.logged_at) })));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   POST /api/deleteProduct   body: { id }
---------------------------------------------------------------- */
app.post("/api/deleteProduct", async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ ok: false, error: "id required" });
  try {
    const script = `
BEGIN TRANSACTION;
DELETE FROM ${T("stage_entries")} WHERE product_id = $1;
DELETE FROM ${T("stores")} WHERE product_id = $1;
DELETE FROM ${T("assignments")} WHERE product_id = $1;
DELETE FROM ${T("qc_audit")} WHERE product_id = $1;
DELETE FROM ${T("products")} WHERE id = $1;
COMMIT TRANSACTION;
`;
    await db.query(script, [String(id)]);
    res.json({ ok: true });
  } catch (e) {
    console.error("deleteProduct error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   GET /api/checkStage?productId=..&stageKey=..
---------------------------------------------------------------- */
app.get("/api/checkStage", async (req, res) => {
  const { productId, stageKey } = req.query;
  try {
    const { rows } = await db.query(
      `SELECT status, updated_at FROM ${T("stage_entries")}
       WHERE product_id = $1 AND stage_key = $2`,
      [String(productId), String(stageKey)],
    );
    const row = rows[0]
      ? { status: rows[0].status, updated_at: iso(rows[0].updated_at) }
      : null;
    res.json({ ok: true, row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   POST /api/setVendors   body: { "KOC Cards": [...], "Bombay Cards": [...] }
---------------------------------------------------------------- */
app.post("/api/setVendors", async (req, res) => {
  try {
    const seen = new Set();
    const rows = [];
    for (const division of Object.keys(req.body || {})) {
      for (const vendorName of req.body[division] || []) {
        const key = `${division}||${vendorName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ division, vendor_name: vendorName });
      }
    }
    if (rows.length === 0) return res.json({ ok: true });

    await db.query(
      `MERGE ${T("vendors")} t
       USING (
         SELECT
           JSON_VALUE(j, '$.division') AS division,
           JSON_VALUE(j, '$.vendor_name') AS vendor_name
         FROM UNNEST(JSON_QUERY_ARRAY($1)) AS j
       ) s
       ON t.division = s.division AND t.vendor_name = s.vendor_name
       WHEN NOT MATCHED THEN INSERT (division, vendor_name)
       VALUES (s.division, s.vendor_name)`,
      [JSON.stringify(rows)],
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("setVendors error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   Helper: stages may arrive as an array or a string.
   Stored as a string in BigQuery (arrays are saved as JSON text).
---------------------------------------------------------------- */
const stagesToStr = (v) => (Array.isArray(v) ? JSON.stringify(v) : v || "");

/* ----------------------------------------------------------------
   POST /api/setTeamMembers   body: array of members
   One MERGE for all members. joined_at is only set on insert,
   same as the old ON CONFLICT clause.
---------------------------------------------------------------- */
app.post("/api/setTeamMembers", async (req, res) => {
  const members = req.body;
  if (!Array.isArray(members))
    return res.status(400).json({ ok: false, error: "expected array" });
  if (members.length === 0) return res.json({ ok: true });

  try {
    const nowIso = new Date().toISOString();
    const byId = new Map();
    members.forEach((m) => {
      if (!m || !m.id) return;
      byId.set(String(m.id), {
        id: String(m.id),
        name: m.name ?? null,
        email: m.email ?? null,
        password: m.password || "",
        role: m.role || "member",
        stages: stagesToStr(m.stages),
        division: m.division || null,
        manager_id: m.managerId || null,
        joined_at: m.joinedAt || nowIso,
      });
    });

    await db.query(
      `MERGE ${T("users")} t
       USING (
         SELECT
           JSON_VALUE(j, '$.id') AS id,
           JSON_VALUE(j, '$.name') AS name,
           JSON_VALUE(j, '$.email') AS email,
           JSON_VALUE(j, '$.password') AS password,
           JSON_VALUE(j, '$.role') AS role,
           JSON_VALUE(j, '$.stages') AS stages,
           JSON_VALUE(j, '$.division') AS division,
           JSON_VALUE(j, '$.manager_id') AS manager_id,
           SAFE_CAST(JSON_VALUE(j, '$.joined_at') AS TIMESTAMP) AS joined_at
         FROM UNNEST(JSON_QUERY_ARRAY($1)) AS j
       ) s
       ON t.id = s.id
       WHEN MATCHED THEN UPDATE SET
         name = s.name, email = s.email, password = s.password, role = s.role,
         stages = s.stages, division = s.division, manager_id = s.manager_id
       WHEN NOT MATCHED THEN INSERT
         (id, name, email, password, role, stages, division, manager_id, joined_at)
       VALUES
         (s.id, s.name, s.email, s.password, s.role, s.stages, s.division, s.manager_id, s.joined_at)`,
      [JSON.stringify([...byId.values()])],
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("setTeamMembers error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   POST /api/saveUsers   body: array of {email, password, name, role, stages}
   Full replace-by-email semantics:
   users whose email is not in the payload are DELETED.
---------------------------------------------------------------- */
app.post("/api/saveUsers", async (req, res) => {
  const users = req.body;
  if (!Array.isArray(users))
    return res.status(400).json({ ok: false, error: "expected array" });

  try {
    const byId = new Map();
    users.forEach((u) => {
      if (!u || !u.email) return;
      const id = String(u.name || u.email)
        .toLowerCase()
        .replace(/\s+/g, "_");
      byId.set(id, {
        id,
        name: u.name || u.email,
        email: u.email,
        password: u.password || "",
        role: u.role || "member",
        stages: stagesToStr(u.stages),
      });
    });
    const rows = [...byId.values()];

    const script = `
BEGIN TRANSACTION;

DELETE FROM ${T("users")}
WHERE LOWER(email) NOT IN (
  SELECT LOWER(JSON_VALUE(j, '$.email'))
  FROM UNNEST(JSON_QUERY_ARRAY(@p1)) AS j
);

MERGE ${T("users")} t
USING (
  SELECT
    JSON_VALUE(j, '$.id') AS id,
    JSON_VALUE(j, '$.name') AS name,
    JSON_VALUE(j, '$.email') AS email,
    JSON_VALUE(j, '$.password') AS password,
    JSON_VALUE(j, '$.role') AS role,
    JSON_VALUE(j, '$.stages') AS stages
  FROM UNNEST(JSON_QUERY_ARRAY(@p1)) AS j
) s
ON t.id = s.id
WHEN MATCHED THEN UPDATE SET
  name = s.name, email = s.email, password = s.password,
  role = s.role, stages = s.stages
WHEN NOT MATCHED THEN INSERT (id, name, email, password, role, stages)
VALUES (s.id, s.name, s.email, s.password, s.role, s.stages);

COMMIT TRANSACTION;
`;
    await db.query(script, [JSON.stringify(rows)]);
    res.json({ ok: true });
  } catch (e) {
    console.error("saveUsers error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   POST /api/setAssignments
   - plain array            -> full sync per division (with safety guards)
   - { mode:"add", assignments:[...] } -> insert/update only, never deletes
---------------------------------------------------------------- */
app.post("/api/setAssignments", async (req, res) => {
  const isAddMode = !Array.isArray(req.body) && req.body?.mode === "add";
  const assignments = isAddMode ? req.body.assignments : req.body;

  if (!Array.isArray(assignments)) {
    return res.status(400).json({
      ok: false,
      error: "expected array (or { mode: 'add', assignments: [...] })",
    });
  }
  if (isAddMode && assignments.length === 0) {
    return res
      .status(400)
      .json({ ok: false, error: "assignments array is empty" });
  }

  const divisionsInPayload = [...new Set(assignments.map((a) => a.division))];

  try {
    // ---- Per-division safety guards (skipped in add mode) ----
    if (!isAddMode) {
      const counts = await Promise.all(
        divisionsInPayload.map((div) =>
          db.query(
            `SELECT COUNT(*) AS count FROM ${T("assignments")} WHERE division = $1`,
            [div ?? null],
          ),
        ),
      );

      for (let i = 0; i < divisionsInPayload.length; i++) {
        const div = divisionsInPayload[i];
        const currentCount = Number(counts[i].rows[0].count);
        const incomingCountForDiv = assignments.filter(
          (a) => a.division === div,
        ).length;

        if (incomingCountForDiv === 0 && currentCount > 0) {
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
          return res.status(400).json({
            ok: false,
            error: `Payload has ${incomingCountForDiv} rows for "${div}" but ${currentCount} currently exist — looks like a stale/partial payload.`,
            division: div,
            currentCount,
            incomingCount: incomingCountForDiv,
          });
        }
      }
    }

    // ---- Resolve product ids from (division, sku) ----
    const prodMap = {};
    if (assignments.length > 0) {
      const skusLower = [
        ...new Set(assignments.map((a) => String(a.sku || "").toLowerCase())),
      ];
      const { rows: prodRows } = await db.query(
        `SELECT id, division, LOWER(sku) AS sku_lower
         FROM ${T("products")}
         WHERE LOWER(sku) IN UNNEST($1)`,
        [skusLower],
      );
      prodRows.forEach((r) => {
        prodMap[r.division + "||" + r.sku_lower] = String(r.id);
      });
    }

    // ---- Build rows (deduplicated by id) ----
    const nowIso = new Date().toISOString();
    const rowsById = new Map();
    const skipped = [];
    const validIdsByDivision = {};

    assignments.forEach((a) => {
      const pid =
        prodMap[a.division + "||" + String(a.sku || "").toLowerCase()];
      if (!pid) {
        skipped.push({ sku: a.sku, division: a.division });
        return;
      }
      const id = a.id ? String(a.id) : require("crypto").randomUUID();
      rowsById.set(id, {
        id,
        member_id: a.memberId ?? null,
        manager_id: a.managerId ?? null,
        product_id: pid,
        sku: a.sku ?? null,
        division: a.division ?? null,
        stage: a.stage ?? null,
        assigned_at: a.assignedAt || nowIso,
      });
    });
    const rows = [...rowsById.values()];

    if (isAddMode && rows.length === 0) {
      return res.status(400).json({
        ok: false,
        error: `No matching product found for ${skipped.length} SKU(s) — check division/SKU spelling.`,
        skipped,
      });
    }

    // Keep-list per division (only divisions that have at least one valid row,
    // same as the old "keepIds.length > 0" check)
    const keepRows = rows.map((r) => ({ id: r.id, division: r.division }));

    // ---- One transaction: MERGE + (optional) scoped delete ----
    let script = `BEGIN TRANSACTION;\n`;

    if (rows.length > 0) {
      script += `
MERGE ${T("assignments")} t
USING (
  SELECT
    JSON_VALUE(j, '$.id') AS id,
    JSON_VALUE(j, '$.member_id') AS member_id,
    JSON_VALUE(j, '$.manager_id') AS manager_id,
    JSON_VALUE(j, '$.product_id') AS product_id,
    JSON_VALUE(j, '$.sku') AS sku,
    JSON_VALUE(j, '$.division') AS division,
    JSON_VALUE(j, '$.stage') AS stage,
    SAFE_CAST(JSON_VALUE(j, '$.assigned_at') AS TIMESTAMP) AS assigned_at
  FROM UNNEST(JSON_QUERY_ARRAY(@p1)) AS j
) s
ON t.id = s.id
WHEN MATCHED THEN UPDATE SET
  member_id = s.member_id, manager_id = s.manager_id, product_id = s.product_id,
  sku = s.sku, division = s.division, stage = s.stage, assigned_at = s.assigned_at
WHEN NOT MATCHED THEN INSERT
  (id, member_id, manager_id, product_id, sku, division, stage, assigned_at)
VALUES
  (s.id, s.member_id, s.manager_id, s.product_id, s.sku, s.division, s.stage, s.assigned_at);
`;
    }

    if (!isAddMode && rows.length > 0) {
      // Delete only rows NOT in the payload, scoped to the divisions in the payload
      script += `
DELETE FROM ${T("assignments")} t
WHERE t.division IN (
    SELECT DISTINCT JSON_VALUE(k, '$.division')
    FROM UNNEST(JSON_QUERY_ARRAY(@p2)) AS k
  )
  AND t.id NOT IN (
    SELECT JSON_VALUE(k, '$.id')
    FROM UNNEST(JSON_QUERY_ARRAY(@p2)) AS k
  );
`;
    }

    script += `COMMIT TRANSACTION;`;

    if (rows.length > 0) {
      await db.query(script, [JSON.stringify(rows), JSON.stringify(keepRows)]);
    }

    res.json({ ok: true, upserted: rows.length, skipped });
  } catch (e) {
    console.error("setAssignments error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   POST /api/clearAssignments   body: { confirm: true }
---------------------------------------------------------------- */
app.post("/api/clearAssignments", async (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({
      ok: false,
      error: "Must pass { confirm: true } to clear all assignments.",
    });
  }
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS count FROM ${T("assignments")}`,
    );
    await db.query(`DELETE FROM ${T("assignments")} WHERE TRUE`);
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
    await db.query(
      `INSERT INTO ${T("audit_log")}
         (id, logged_at, actor_name, action, entity, detail, division)
       VALUES ($1, TIMESTAMP($2), $3, $4, $5, $6, $7)`,
      [
        e.id ? String(e.id) : require("crypto").randomUUID(),
        e.at || new Date().toISOString(),
        e.actor || "Unattributed",
        e.action ?? null,
        e.entity ?? null,
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
   GET /api/memberStats?memberId=chitra&division=Bombay Cards
   Postgres -> BigQuery:
     COUNT(*) FILTER (WHERE x)  ->  COUNTIF(x)
     bool_or(x)                 ->  LOGICAL_OR(x)
---------------------------------------------------------------- */
app.get("/api/memberStats", async (req, res) => {
  const { memberId, division } = req.query;
  if (!memberId || !division)
    return res
      .status(400)
      .json({ ok: false, error: "memberId and division required" });
  try {
    const { rows } = await db.query(
      `
      WITH member_skus AS (
        SELECT DISTINCT sku
        FROM ${T("assignments")}
        WHERE member_id = $1 AND division = $2
      ),
      pushed_skus AS (
        SELECT DISTINCT sku
        FROM ${T("assignments")}
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
        FROM ${T("assignments")} a
        JOIN ${T("products")} p ON p.sku = a.sku AND p.division = a.division
        WHERE a.member_id = $1 AND a.division = $2
      ),
      card_level AS (
        SELECT
          ta.product_id,
          COUNT(*) AS stages_owned,
          COUNTIF(se.status = 'Completed') AS stages_completed,
          LOGICAL_OR(
            COALESCE(se.status, 'Not Started') = 'Issue'
            OR COALESCE(se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%', FALSE)
          ) AS has_open_issue
        FROM target_assignments ta
        LEFT JOIN ${T("stage_entries")} se
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
      [String(memberId), String(division)],
    );

    const r = rows[0] || {};
    res.json({
      ok: true,
      total_assigned: Number(r.total_assigned || 0),
      pushed_to_team: Number(r.pushed_to_team || 0),
      kept_by_manager: Number(r.kept_by_manager || 0),
      completed: Number(r.completed || 0),
      pending: Number(r.pending || 0),
      issues: Number(r.issues || 0),
    });
  } catch (e) {
    console.error("memberStats error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   GET /api/allMemberStats?division=KOC Cards
---------------------------------------------------------------- */
app.get("/api/allMemberStats", async (req, res) => {
  const { division } = req.query;
  if (!division)
    return res.status(400).json({ ok: false, error: "division required" });
  try {
    const { rows } = await db.query(
      `
      WITH target_assignments AS (
        SELECT DISTINCT a.member_id, p.id AS product_id, a.stage AS assigned_stage
        FROM ${T("assignments")} a
        JOIN ${T("products")} p ON p.sku = a.sku AND p.division = a.division
        WHERE a.division = $1
      ),
      card_level AS (
        SELECT
          ta.member_id,
          ta.product_id,
          COUNT(*) AS stages_owned,
          COUNTIF(se.status = 'Completed') AS stages_completed,
          LOGICAL_OR(
            se.status = 'Issue'
            OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
          ) AS has_open_issue
        FROM target_assignments ta
        JOIN ${T("stage_entries")} se
          ON se.product_id = ta.product_id
          AND se.stage_key = ta.assigned_stage
        GROUP BY ta.member_id, ta.product_id
      )
      SELECT
        u.id AS member_id,
        u.name AS member_name,
        COUNT(cl.product_id) AS total_assigned,
        COUNTIF(cl.stages_completed = cl.stages_owned AND NOT cl.has_open_issue) AS completed,
        COUNTIF(cl.stages_completed < cl.stages_owned AND NOT cl.has_open_issue) AS pending,
        COUNTIF(cl.has_open_issue) AS issues
      FROM card_level cl
      JOIN ${T("users")} u ON u.id = cl.member_id
      GROUP BY u.id, u.name
      ORDER BY u.name
    `,
      [String(division)],
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
---------------------------------------------------------------- */
app.get("/api/pipelineStats", async (req, res) => {
  const { memberId, division } = req.query;
  if (!memberId || !division)
    return res
      .status(400)
      .json({ ok: false, error: "memberId and division required" });
  try {
    const { rows } = await db.query(
      `
      WITH member_skus AS (
        SELECT DISTINCT p.id AS product_id, a.stage AS assigned_stage
        FROM ${T("assignments")} a
        JOIN ${T("products")} p ON p.sku = a.sku AND p.division = a.division
        WHERE a.member_id = $1
          AND a.division = $2
      )
      SELECT
        se.stage_key,
        COUNTIF(se.status = 'Not Started') AS not_started,
        COUNTIF(
          se.status = 'In Progress' AND se.comments NOT LIKE 'QC flagged:%'
        ) AS in_progress,
        COUNTIF(se.status = 'Completed') AS completed,
        COUNTIF(
          se.status = 'Issue'
          OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
        ) AS issue
      FROM member_skus ms
      JOIN ${T("stage_entries")} se
        ON se.product_id = ms.product_id
       AND se.stage_key = ms.assigned_stage
      GROUP BY se.stage_key
    `,
      [String(memberId), String(division)],
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
   updated_at is converted to a JS Date so the code that consumes
   these rows (the export route) keeps working unchanged.
---------------------------------------------------------------- */
const toDate = (v) => {
  if (!v) return null;
  const d = new Date(v.value ?? v);
  return isNaN(d) ? null : d;
};

async function getExportRowsForDivision(client, division, scope) {
  const { rows } = await client.query(
    `
    WITH stage_counts AS (
      SELECT
        p.id AS product_id,
        COUNTIF(se.status = 'Completed') AS completed_stages,
        COUNTIF(se.status = 'Issue') AS issue_stages,
        MIN(CASE WHEN se.status IS DISTINCT FROM 'Completed' THEN se.stage_key END) AS next_pending_stage
      FROM ${T("products")} p
      LEFT JOIN ${T("stage_entries")} se
        ON se.product_id = p.id AND se.stage_key != 'finalqc'
      WHERE p.division = $1
      GROUP BY p.id
    )
    SELECT p.sku, p.name, p.vendor, p.division, p.qty, p.verdict, p.updated_at,
           sc.completed_stages, sc.issue_stages, sc.next_pending_stage
    FROM ${T("products")} p
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
    [String(division), String(scope), PIPELINE_STAGE_COUNT],
    { p3: "INT64" },
  );
  return rows.map((r) => ({
    ...r,
    updated_at: toDate(r.updated_at),
    completed_stages: Number(r.completed_stages),
    issue_stages: Number(r.issue_stages),
  }));
}

async function getExportRowsForMember(client, division, memberId, scope) {
  const { rows } = await client.query(
    `
    WITH my_assignments AS (
      SELECT DISTINCT a.sku, a.stage
      FROM ${T("assignments")} a
      WHERE a.member_id = $1 AND a.division = $2
    ),
    card_level AS (
      SELECT
        p.id AS product_id,
        p.sku, p.name, p.vendor, p.division, p.qty, p.verdict, p.updated_at,
        COUNT(*) AS stages_owned,
        COUNTIF(se.status = 'Completed') AS stages_completed,
        COUNTIF(se.status = 'Issue') AS stages_issue,
        MIN(CASE WHEN se.status IS DISTINCT FROM 'Completed' THEN ma.stage END) AS next_pending_stage
      FROM my_assignments ma
      JOIN ${T("products")} p ON p.sku = ma.sku AND p.division = $2
      LEFT JOIN ${T("stage_entries")} se ON se.product_id = p.id AND se.stage_key = ma.stage
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
    [String(memberId), String(division), String(scope)],
  );
  return rows.map((r) => ({
    ...r,
    updated_at: toDate(r.updated_at),
    stages_owned: Number(r.stages_owned),
    stages_completed: Number(r.stages_completed),
    stages_issue: Number(r.stages_issue),
  }));
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

/* ----------------------------------------------------------------
   POST /api/bulkImportProducts   body: array of rows
   BigQuery notes:
   - No ON CONFLICT / RETURNING / gen_random_uuid(), so existing products are
     looked up first by (division, lower(sku)). Existing rows keep their id,
     new rows get a UUID generated here. Then MERGE on id.
   - Each chunk (products + stage_entries + verdicts) runs as one
     transaction, so a chunk is all-or-nothing.
---------------------------------------------------------------- */
const IMPORT_CHUNK_SIZE = 200;

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

  try {
    // ---- De-duplicate by (division, sku); last row wins ----
    const keyOf = (r) =>
      (r.division || "") + "||" + String(r.sku).trim().toLowerCase();
    const byKey = new Map();
    validRows.forEach((r) => byKey.set(keyOf(r), r));
    const uniqueRows = [...byKey.values()];

    // ---- Look up existing products for these divisions ----
    const divisionsInBatch = [
      ...new Set(uniqueRows.map((r) => r.division).filter(Boolean)),
    ];
    const existingIdByKey = new Map();
    if (divisionsInBatch.length > 0) {
      const { rows: existing } = await db.query(
        `SELECT id, division, LOWER(sku) AS sku_lower
         FROM ${T("products")}
         WHERE division IN UNNEST($1)`,
        [divisionsInBatch],
      );
      existing.forEach((r) =>
        existingIdByKey.set(r.division + "||" + r.sku_lower, String(r.id)),
      );
    }

    // ---- Cap check ----
    const currentCount = await getProductCount(db);
    const newRowsCount = uniqueRows.filter(
      (r) => !existingIdByKey.has(keyOf(r)),
    ).length;
    if (currentCount + newRowsCount > MAX_PRODUCTS) {
      return res.status(400).json({
        ok: false,
        error: `Import would exceed max product cap (${MAX_PRODUCTS}). Currently ${currentCount}, trying to add ${newRowsCount} new SKUs.`,
      });
    }

    // ---- 1. Vendors (deduped, ONE MERGE) ----
    const vendorSeen = new Set();
    const vendorRows = [];
    uniqueRows.forEach((r) => {
      if (r.vendor && String(r.vendor).trim()) {
        const division = r.division || "";
        const vendor_name = String(r.vendor).trim();
        const k = division + "||" + vendor_name;
        if (vendorSeen.has(k)) return;
        vendorSeen.add(k);
        vendorRows.push({ division, vendor_name });
      }
    });
    if (vendorRows.length > 0) {
      await db.query(
        `MERGE ${T("vendors")} t
         USING (
           SELECT
             JSON_VALUE(j, '$.division') AS division,
             JSON_VALUE(j, '$.vendor_name') AS vendor_name
           FROM UNNEST(JSON_QUERY_ARRAY($1)) AS j
         ) s
         ON t.division = s.division AND t.vendor_name = s.vendor_name
         WHEN NOT MATCHED THEN INSERT (division, vendor_name)
         VALUES (s.division, s.vendor_name)`,
        [JSON.stringify(vendorRows)],
      );
    }

    // ---- 2. Products + stages + verdicts, chunk by chunk ----
    for (let i = 0; i < uniqueRows.length; i += IMPORT_CHUNK_SIZE) {
      const chunk = uniqueRows.slice(i, i + IMPORT_CHUNK_SIZE);

      const productRows = [];
      const stageRows = [];
      const verdictRows = [];
      let chunkCreated = 0;
      let chunkUpdated = 0;

      for (const r of chunk) {
        const key = keyOf(r);
        let productId = existingIdByKey.get(key);
        if (productId) {
          chunkUpdated++;
        } else {
          productId = require("crypto").randomUUID();
          chunkCreated++;
        }

        productRows.push({
          id: productId,
          division: r.division || null,
          sku: String(r.sku).trim(),
          name: r.name || "",
          vendor: r.vendor ? String(r.vendor).trim() : null,
          inward: r.inward ? String(r.inward) : null,
          qty: Number(r.qty) || 0,
          note: r.note || "",
          set_no: r.set_no || null,
        });

        // One row per stage (except finalqc), even when blank, so every SKU
        // always has stage_entries rows and shows up in the stats queries.
        for (const s of STAGE_KEYS) {
          if (s === "finalqc") continue;
          const isDim = s === "dimensions";
          stageRows.push({
            product_id: productId,
            stage_key: s,
            status: normStatusServer(r[s + "_status"]),
            person: r[s + "_person"] || "",
            comments: r[s + "_comments"] || "",
            width_cm:
              isDim && r.dimensions_width
                ? Number(r.dimensions_width) || null
                : null,
            height_cm:
              isDim && r.dimensions_height
                ? Number(r.dimensions_height) || null
                : null,
            weight_gm:
              isDim && r.dimensions_weight
                ? Number(r.dimensions_weight) || null
                : null,
          });
        }

        if (r.qc_verdict) {
          const v = /appro/i.test(r.qc_verdict)
            ? "Approved"
            : /issue/i.test(r.qc_verdict)
              ? "Issues Found"
              : null;
          if (v)
            verdictRows.push({
              id: productId,
              verdict: v,
              issues: r.qc_issues || "",
            });
        }
      }

      const script = `
BEGIN TRANSACTION;

MERGE ${T("products")} t
USING (
  SELECT
    JSON_VALUE(j, '$.id') AS id,
    JSON_VALUE(j, '$.division') AS division,
    JSON_VALUE(j, '$.sku') AS sku,
    JSON_VALUE(j, '$.name') AS name,
    JSON_VALUE(j, '$.vendor') AS vendor,
    SAFE_CAST(SUBSTR(JSON_VALUE(j, '$.inward'), 1, 10) AS DATE) AS inward,
    SAFE_CAST(JSON_VALUE(j, '$.qty') AS INT64) AS qty,
    JSON_VALUE(j, '$.note') AS note,
    JSON_VALUE(j, '$.set_no') AS set_no
  FROM UNNEST(JSON_QUERY_ARRAY(@p1)) AS j
) s
ON t.id = s.id
WHEN MATCHED THEN UPDATE SET
  name = COALESCE(NULLIF(s.name, ''), t.name),
  vendor = COALESCE(s.vendor, t.vendor),
  inward = COALESCE(s.inward, t.inward),
  qty = IF(s.qty > 0, s.qty, t.qty),
  note = COALESCE(NULLIF(s.note, ''), t.note),
  set_no = COALESCE(NULLIF(s.set_no, ''), t.set_no),
  updated_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT
  (id, division, sku, name, vendor, inward, qty, note, set_no, created_at, updated_at)
VALUES
  (s.id, s.division, s.sku, s.name, s.vendor, s.inward, s.qty, s.note, s.set_no,
   CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP());

MERGE ${T("stage_entries")} t
USING (
  SELECT
    JSON_VALUE(j, '$.product_id') AS product_id,
    JSON_VALUE(j, '$.stage_key') AS stage_key,
    JSON_VALUE(j, '$.status') AS status,
    JSON_VALUE(j, '$.person') AS person,
    JSON_VALUE(j, '$.comments') AS comments,
    SAFE_CAST(JSON_VALUE(j, '$.width_cm') AS FLOAT64) AS width_cm,
    SAFE_CAST(JSON_VALUE(j, '$.height_cm') AS FLOAT64) AS height_cm,
    SAFE_CAST(JSON_VALUE(j, '$.weight_gm') AS FLOAT64) AS weight_gm
  FROM UNNEST(JSON_QUERY_ARRAY(@p2)) AS j
) s
ON t.product_id = s.product_id AND t.stage_key = s.stage_key
WHEN MATCHED THEN UPDATE SET
  status = COALESCE(s.status, t.status),
  person = COALESCE(NULLIF(s.person, ''), t.person),
  comments = COALESCE(NULLIF(s.comments, ''), t.comments),
  updated_at = CURRENT_TIMESTAMP(),
  width_cm = COALESCE(s.width_cm, t.width_cm),
  height_cm = COALESCE(s.height_cm, t.height_cm),
  weight_gm = COALESCE(s.weight_gm, t.weight_gm)
WHEN NOT MATCHED THEN INSERT
  (product_id, stage_key, status, person, comments, updated_at, width_cm, height_cm, weight_gm)
VALUES
  (s.product_id, s.stage_key, COALESCE(s.status, 'Not Started'), s.person, s.comments,
   CURRENT_TIMESTAMP(), s.width_cm, s.height_cm, s.weight_gm);

UPDATE ${T("products")} t
SET verdict = s.verdict, issues = s.issues, updated_at = CURRENT_TIMESTAMP()
FROM (
  SELECT
    JSON_VALUE(j, '$.id') AS id,
    JSON_VALUE(j, '$.verdict') AS verdict,
    JSON_VALUE(j, '$.issues') AS issues
  FROM UNNEST(JSON_QUERY_ARRAY(@p3)) AS j
) s
WHERE t.id = s.id;

COMMIT TRANSACTION;
`;

      await db.query(script, [
        JSON.stringify(productRows),
        JSON.stringify(stageRows),
        JSON.stringify(verdictRows),
      ]);

      // Only count a chunk once it has been committed
      results.created += chunkCreated;
      results.updated += chunkUpdated;
    }

    res.json({ ok: true, ...results });
  } catch (e) {
    console.error("bulkImportProducts error", e);
    res.status(500).json({ ok: false, error: e.message, ...results });
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
  try {
    const rows = memberId
      ? await getExportRowsForMember(db, division, memberId, scope)
      : await getExportRowsForDivision(db, division, scope);

    res.json({ ok: true, scope, count: rows.length, rows });
  } catch (e) {
    console.error("exportProducts error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   GET /api/stageIssueStats?division=KOC Cards
---------------------------------------------------------------- */
app.get("/api/stageIssueStats", async (req, res) => {
  const { division } = req.query;
  if (!division)
    return res.status(400).json({ ok: false, error: "division required" });
  try {
    const { rows } = await db.query(
      `
      SELECT se.stage_key, COUNT(*) AS issue_count
      FROM ${T("stage_entries")} se
      JOIN ${T("products")} p ON p.id = se.product_id
      WHERE p.division = $1
        AND (
          se.status = 'Issue'
          OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
        )
      GROUP BY se.stage_key
    `,
      [String(division)],
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
   GET /api/pipelineBreakdown?division=..&memberId=..&vendor=..&setNo=..
   Postgres -> BigQuery:
     COUNT(*) FILTER (WHERE x) -> COUNTIF(x)
     $3::text IS NULL          -> @p3 IS NULL (null params are sent as STRING)
---------------------------------------------------------------- */
app.get("/api/pipelineBreakdown", async (req, res) => {
  const { division, memberId, vendor, setNo } = req.query;
  if (!division)
    return res.status(400).json({ ok: false, error: "division required" });

  try {
    let rows;
    if (memberId) {
      const { rows: r } = await db.query(
        `
        WITH member_scope AS (
          SELECT DISTINCT p.id AS product_id, a.stage AS stage_key, p.vendor AS vendor
          FROM ${T("assignments")} a
          JOIN ${T("products")} p
            ON p.sku = a.sku AND p.division = a.division
          WHERE a.member_id = $1
            AND a.division = $2
            AND ($3 IS NULL OR p.vendor = $3)
            AND ($4 IS NULL OR p.set_no = $4)
        )
        SELECT
          ms.stage_key,
          ms.vendor,
          COUNTIF(COALESCE(se.status, 'Not Started') = 'Not Started') AS not_started,
          COUNTIF(se.status = 'In Progress' AND COALESCE(se.comments, '') NOT LIKE 'QC flagged:%') AS in_progress,
          COUNTIF(se.status = 'Completed') AS completed,
          COUNTIF(
            se.status = 'Issue'
            OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
          ) AS issue
        FROM member_scope ms
        LEFT JOIN ${T("stage_entries")} se
          ON se.product_id = ms.product_id AND se.stage_key = ms.stage_key
        GROUP BY ms.stage_key, ms.vendor
        ORDER BY ms.vendor, ms.stage_key
      `,
        [
          String(memberId),
          String(division),
          vendor ? String(vendor) : null,
          setNo ? String(setNo) : null,
        ],
      );
      rows = r;
    } else {
      const { rows: r } = await db.query(
        `
        SELECT
          se.stage_key,
          p.vendor AS vendor,
          COUNTIF(se.status = 'Not Started') AS not_started,
          COUNTIF(se.status = 'In Progress' AND se.comments NOT LIKE 'QC flagged:%') AS in_progress,
          COUNTIF(se.status = 'Completed') AS completed,
          COUNTIF(
            se.status = 'Issue'
            OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
          ) AS issue
        FROM ${T("stage_entries")} se
        JOIN ${T("products")} p ON p.id = se.product_id
        WHERE p.division = $1
          AND se.stage_key != 'finalqc'
          AND ($2 IS NULL OR p.vendor = $2)
          AND ($3 IS NULL OR p.set_no = $3)
        GROUP BY se.stage_key, p.vendor
        ORDER BY p.vendor, se.stage_key
      `,
        [
          String(division),
          vendor ? String(vendor) : null,
          setNo ? String(setNo) : null,
        ],
      );
      rows = r;
    }

    // `stages`   - aggregated across all vendors (backward compatible)
    // `byVendor` - { vendorName: { stageKey: {...} } }
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

      if (!stages[r.stage_key]) {
        stages[r.stage_key] = {
          notStarted: 0,
          inProgress: 0,
          completed: 0,
          issue: 0,
        };
      }
      stages[r.stage_key].notStarted += cell.notStarted;
      stages[r.stage_key].inProgress += cell.inProgress;
      stages[r.stage_key].completed += cell.completed;
      stages[r.stage_key].issue += cell.issue;

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
    const { rows } = await db.query(
      `SELECT entity, detail, logged_at FROM ${T("audit_log")}
       WHERE action = 'Stage update' AND division = $1
       ORDER BY entity, logged_at ASC`,
      [String(division)],
    );

    // entity+stage -> { firstInProgress, firstCompleted }
    const track = {};
    rows.forEach((r) => {
      const m = String(r.detail || "").match(/^(.+?)\s*→\s*([^·]+?)(?:\s*·|$)/);
      if (!m) return;
      const stageName = m[1].trim();
      const status = m[2].trim();
      const key = r.entity + "||" + stageName;
      const at = toDate(r.logged_at);
      if (!track[key])
        track[key] = { stageName, firstInProgress: null, firstCompleted: null };
      const t = track[key];
      if (status === "In Progress" && !t.firstInProgress)
        t.firstInProgress = at;
      if (status === "Completed" && !t.firstCompleted && t.firstInProgress)
        t.firstCompleted = at;
    });

    const byStage = {};
    Object.values(track).forEach((t) => {
      if (!t.firstInProgress || !t.firstCompleted) return;
      const hours = (t.firstCompleted - t.firstInProgress) / 3600000;
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
---------------------------------------------------------------- */
app.get("/api/memberSpeedStats", async (req, res) => {
  const { division } = req.query;
  if (!division)
    return res.status(400).json({ ok: false, error: "division required" });
  try {
    const { rows } = await db.query(
      `SELECT entity, detail, logged_at, actor_name FROM ${T("audit_log")}
       WHERE action = 'Stage update' AND division = $1
       ORDER BY entity, logged_at ASC`,
      [String(division)],
    );

    const lastInProgress = {}; // "sku||stageName" -> Date
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
      const at = toDate(r.logged_at);

      if (status === "In Progress") {
        lastInProgress[key] = at;
      } else if (status === "Completed") {
        const startedAt = lastInProgress[key];
        if (startedAt && at && person) {
          const hours = (at - startedAt) / 3600000;
          // discard bad/stalled outliers (>60 days)
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
   GET /api/teamStageStats?division=...&vendor=&set_no=&dateFrom=&dateTo=
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

    const { rows: userRows } = await db.query(
      `SELECT id, manager_id FROM ${T("users")}`,
    );
    const managerIdOf = {};
    userRows.forEach((u) => {
      managerIdOf[u.id] = u.manager_id;
    });

    // Postgres: a.stage = ANY($2)   ->   BigQuery: a.stage IN UNNEST($2)
    const conditions = ["a.division = $1", "a.stage IN UNNEST($2)"];
    const params = [String(division), allStageKeys];

    if (vendor) {
      params.push(String(vendor));
      conditions.push(`p.vendor = $${params.length}`);
    }
    if (set_no) {
      params.push(String(set_no));
      conditions.push(`p.set_no = $${params.length}`);
    }
    // assigned_at is a TIMESTAMP, so string params are converted with TIMESTAMP()
    if (dateFrom) {
      params.push(String(dateFrom));
      conditions.push(`a.assigned_at >= TIMESTAMP($${params.length})`);
    }
    if (dateTo) {
      params.push(dateTo + " 23:59:59");
      conditions.push(`a.assigned_at <= TIMESTAMP($${params.length})`);
    }
    // NOTE: status is intentionally NOT added to `conditions` — it must not
    // shrink the row set, or Total Assigned would change with it.

    const { rows } = await db.query(
      `SELECT a.member_id, u.name AS member_name, a.stage, a.sku, se.status AS stage_status
       FROM ${T("assignments")} a
       JOIN ${T("users")} u ON u.id = a.member_id
       JOIN ${T("products")} p ON p.id = a.product_id
       LEFT JOIN ${T("stage_entries")} se
         ON se.product_id = a.product_id AND se.stage_key = a.stage
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

          // Never assigned that stage -> null so the frontend shows "—"
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

/* ----------------------------------------------------------------
   GET /api/memberStageDetail?division=&completedFrom=&completedTo=&vendor=
   Per-member, per-division, per-stage counts using "effective
   assignment" logic (a manager's sku/stage that was pushed to a
   report is excluded from the manager's set).

   Postgres -> BigQuery:
     $1::division_name           -> plain STRING
     $2::timestamptz             -> SAFE_CAST($2 AS TIMESTAMP)
     MAX(x) FILTER (WHERE c)     -> MAX(IF(c, x, NULL))
     COUNT(DISTINCT x) FILTER    -> COUNT(DISTINCT IF(c, x, NULL))
---------------------------------------------------------------- */
app.get("/api/memberStageDetail", async (req, res) => {
  const { division, completedFrom, completedTo, vendor } = req.query;

  try {
    const { rows } = await db.query(
      `
      WITH target_assignments AS (
          SELECT DISTINCT a.member_id, a.manager_id, a.division, a.stage AS assigned_stage,
                 p.id AS product_id, a.sku, a.assigned_at
          FROM ${T("assignments")} a
          JOIN ${T("products")} p ON p.sku = a.sku AND p.division = a.division
          WHERE a.division IN ('KOC Cards', 'Bombay Cards')
            AND ($1 IS NULL OR a.division = $1)
            AND ($4 IS NULL OR p.vendor = $4)
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
              -- Completion is the only thing that gets date-scoped.
              MAX(IF(
                  se.status = 'Completed'
                    AND (SAFE_CAST($2 AS TIMESTAMP) IS NULL OR se.updated_at >= SAFE_CAST($2 AS TIMESTAMP))
                    AND (SAFE_CAST($3 AS TIMESTAMP) IS NULL OR se.updated_at < SAFE_CAST($3 AS TIMESTAMP)),
                  se.updated_at, NULL
              )) AS last_completed_at,
              COUNT(DISTINCT e.sku) AS assigned_skus,
              COUNT(DISTINCT IF(
                  se.status = 'Completed'
                    AND (SAFE_CAST($2 AS TIMESTAMP) IS NULL OR se.updated_at >= SAFE_CAST($2 AS TIMESTAMP))
                    AND (SAFE_CAST($3 AS TIMESTAMP) IS NULL OR se.updated_at < SAFE_CAST($3 AS TIMESTAMP)),
                  e.sku, NULL
              )) AS completed_skus,
              -- Pending/issue always reflect the current live state
              COUNT(DISTINCT IF(
                  se.status = 'In Progress' AND se.comments NOT LIKE 'QC flagged:%',
                  e.sku, NULL
              )) AS in_progress_skus,
              COUNT(DISTINCT IF(se.status = 'Not Started', e.sku, NULL)) AS not_started_skus,
              COUNT(DISTINCT IF(
                  se.status = 'Issue'
                    OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%'),
                  e.sku, NULL
              )) AS issue_skus
          FROM effective e
          LEFT JOIN ${T("stage_entries")} se
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
      JOIN ${T("users")} u ON u.id = t.member_id
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

    // Flat rows with timestamps/counts converted to plain JSON values
    const flatRows = rows.map((r) => ({
      ...r,
      total_assigned_skus: Number(r.total_assigned_skus),
      assigned_skus: Number(r.assigned_skus),
      completed_skus: Number(r.completed_skus),
      in_progress_skus: Number(r.in_progress_skus),
      not_started_skus: Number(r.not_started_skus),
      issue_skus: Number(r.issue_skus),
      last_assigned_at: iso(r.last_assigned_at) || null,
      last_completed_at: iso(r.last_completed_at) || null,
    }));

    // Reshape into a nested per-member structure
    const byKey = {};
    flatRows.forEach((r) => {
      const key = r.member_id + "||" + r.division;
      if (!byKey[key]) {
        byKey[key] = {
          memberId: r.member_id,
          memberName: r.member_name,
          division: r.division,
          totalAssignedSkus: r.total_assigned_skus,
          stages: [],
        };
      }
      byKey[key].stages.push({
        stage: r.stage,
        assignedAt: r.last_assigned_at,
        completedAt: r.last_completed_at,
        assignedSkus: r.assigned_skus,
        completedSkus: r.completed_skus,
        inProgressSkus: r.in_progress_skus,
        notStartedSkus: r.not_started_skus,
        issueSkus: r.issue_skus,
      });
    });

    res.json({
      ok: true,
      rows: flatRows, // raw rows, in case the frontend wants the flat shape
      members: Object.values(byKey),
    });
  } catch (e) {
    console.error("memberStageDetail error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   GET /api/memberDailyActivity?person=..&division=..&from=..&to=..
   Postgres -> BigQuery:
     ILIKE                 -> LOWER(x) LIKE LOWER(y)
     date_trunc('day', ts) -> DATE(ts)
     $n::timestamptz       -> SAFE_CAST($n AS TIMESTAMP)
---------------------------------------------------------------- */
app.get("/api/memberDailyActivity", async (req, res) => {
  const { person, division, from, to } = req.query;
  if (!person)
    return res.status(400).json({ ok: false, error: "person required" });
  try {
    const { rows } = await db.query(
      `SELECT
         DATE(se.updated_at) AS work_date,
         se.stage_key,
         COUNT(*) AS completed_count,
         ARRAY_AGG(p.sku ORDER BY se.updated_at) AS skus
       FROM ${T("stage_entries")} se
       JOIN ${T("products")} p ON p.id = se.product_id
       WHERE LOWER(se.person) LIKE LOWER($1)
         AND se.status = 'Completed'
         AND ($2 IS NULL OR p.division = $2)
         AND (SAFE_CAST($3 AS TIMESTAMP) IS NULL OR se.updated_at >= SAFE_CAST($3 AS TIMESTAMP))
         AND (SAFE_CAST($4 AS TIMESTAMP) IS NULL OR se.updated_at < SAFE_CAST($4 AS TIMESTAMP))
       GROUP BY work_date, se.stage_key
       ORDER BY work_date, se.stage_key`,
      [
        String(person),
        division ? String(division) : null,
        from ? String(from) : null,
        to ? String(to) : null,
      ],
    );
    res.json({
      ok: true,
      rows: rows.map((r) => ({
        date: dateOnly(r.work_date),
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
   GET /api/teamStageActivity?division=KOC Cards&from=..&to=..
---------------------------------------------------------------- */
app.get("/api/teamStageActivity", async (req, res) => {
  const { division, from, to } = req.query;
  if (!division)
    return res.status(400).json({ ok: false, error: "division required" });
  try {
    const params = [
      String(division),
      from ? String(from) : null,
      to ? String(to) : null,
    ];

    const [{ rows }, { rows: totalsRows }] = await Promise.all([
      db.query(
        `SELECT
           se.person AS member_name,
           se.stage_key,
           COUNT(*) AS completed_count
         FROM ${T("stage_entries")} se
         JOIN ${T("products")} p ON p.id = se.product_id
         WHERE p.division = $1
           AND se.status = 'Completed'
           AND se.person IS NOT NULL AND se.person != ''
           AND (SAFE_CAST($2 AS TIMESTAMP) IS NULL OR se.updated_at >= SAFE_CAST($2 AS TIMESTAMP))
           AND (SAFE_CAST($3 AS TIMESTAMP) IS NULL OR se.updated_at < SAFE_CAST($3 AS TIMESTAMP))
         GROUP BY se.person, se.stage_key
         ORDER BY se.person, se.stage_key`,
        params,
      ),
      // Distinct cards touched per person in this window
      db.query(
        `SELECT se.person AS member_name, COUNT(DISTINCT p.id) AS total_cards
         FROM ${T("stage_entries")} se
         JOIN ${T("products")} p ON p.id = se.product_id
         WHERE p.division = $1
           AND se.status = 'Completed'
           AND se.person IS NOT NULL AND se.person != ''
           AND (SAFE_CAST($2 AS TIMESTAMP) IS NULL OR se.updated_at >= SAFE_CAST($2 AS TIMESTAMP))
           AND (SAFE_CAST($3 AS TIMESTAMP) IS NULL OR se.updated_at < SAFE_CAST($3 AS TIMESTAMP))
         GROUP BY se.person`,
        params,
      ),
    ]);

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

/* ----------------------------------------------------------------
   GET /api/store-list — for populating the branch dropdown
---------------------------------------------------------------- */
app.get("/api/store-list", async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT TRIM(string_field_0) AS store_name
       FROM ${T("store_list")}
       WHERE string_field_0 IS NOT NULL
         AND TRIM(string_field_0) != ''
         AND LOWER(TRIM(string_field_0)) NOT IN ('store_name', 'store', 'name', 'branch_name')
       ORDER BY store_name`,
    );
    res.json({ ok: true, stores: rows.map((r) => r.store_name) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   Dispatch helpers
---------------------------------------------------------------- */
async function dispatchValidate(division, vendor, branchName) {
  const [{ rows: vcheck }, { rows: scheck }] = await Promise.all([
    db.query(
      `SELECT 1 FROM ${T("vendors")} WHERE division = $1 AND vendor_name = $2`,
      [String(division), String(vendor)],
    ),
    db.query(
      `SELECT 1 FROM ${T("store_list")} WHERE TRIM(string_field_0) = $1 LIMIT 1`,
      [String(branchName).trim()],
    ),
  ]);
  if (vcheck.length === 0)
    return `Vendor "${vendor}" not found for ${division}.`;
  if (scheck.length === 0) return `Unknown branch "${branchName}".`;
  return null;
}

/* ----------------------------------------------------------------
   POST /api/dispatch/admin-upload — admin's reference set (set_number = 1)
   BigQuery: no ON CONFLICT / RETURNING, so the batch is looked up first;
   if it exists it is updated, otherwise inserted with a generated id.
   Items are MERGEd (scan_count is added to, like the old ON CONFLICT).
---------------------------------------------------------------- */
app.post("/api/dispatch/admin-upload", async (req, res) => {
  const {
    division,
    vendor,
    batchLabel,
    setLabel,
    branchName,
    uploadedBy,
    filename,
    skus,
  } = req.body;
  if (
    !division ||
    !vendor ||
    !batchLabel ||
    !setLabel ||
    !branchName ||
    !Array.isArray(skus) ||
    skus.length === 0
  ) {
    return res.status(400).json({
      ok: false,
      error:
        "division, vendor, batchLabel, setLabel, branchName and skus[] required",
    });
  }
  try {
    const problem = await dispatchValidate(division, vendor, branchName);
    if (problem) return res.status(400).json({ ok: false, error: problem });

    const { rows: existing } = await db.query(
      `SELECT id FROM ${T("dispatch_batches")}
       WHERE division = $1 AND vendor = $2 AND batch_label = $3
         AND set_label = $4 AND branch_name = $5 AND source = 'dispatched'
       LIMIT 1`,
      [
        String(division),
        String(vendor),
        String(batchLabel),
        String(setLabel),
        String(branchName),
      ],
    );
    const isNew = existing.length === 0;
    const batchId = isNew
      ? require("crypto").randomUUID()
      : String(existing[0].id);

    const counts = {};
    skus.forEach((s) => {
      const k = String(s.sku || s).trim();
      if (k) counts[k] = (counts[k] || 0) + (Number(s.qty) || 1);
    });
    const itemRows = Object.keys(counts).map((sku) => ({
      sku,
      qty: counts[sku],
    }));

    const batchStmt = isNew
      ? `INSERT INTO ${T("dispatch_batches")}
            (id, division, vendor, batch_label, set_label, branch_name,
            source, uploaded_by, source_filename, uploaded_at, updated_at)
         VALUES (@p1, @p2, @p3, @p4, @p5, @p6, 'dispatched', @p7, @p8,
                 CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP());`
      : `UPDATE ${T("dispatch_batches")}
         SET uploaded_by = @p7, source_filename = @p8, updated_at = CURRENT_TIMESTAMP()
         WHERE id = @p1;`;

    const script = `
BEGIN TRANSACTION;

${batchStmt}

MERGE ${T("dispatch_batch_items")} t
USING (
  SELECT
    JSON_VALUE(j, '$.sku') AS sku,
    SAFE_CAST(JSON_VALUE(j, '$.qty') AS INT64) AS qty
  FROM UNNEST(JSON_QUERY_ARRAY(@p9)) AS j
) s
ON t.batch_id = @p1 AND t.sku = s.sku
WHEN MATCHED THEN UPDATE SET
  scan_count = t.scan_count + s.qty,
  last_scanned_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT
  (id, batch_id, sku, qty, scan_count, first_scanned_at, last_scanned_at)
VALUES
  (ABS(FARM_FINGERPRINT(CONCAT(@p1, '|', s.sku))), @p1, s.sku, s.qty, s.qty,
   CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP());

COMMIT TRANSACTION;
`;
    await db.query(script, [
      batchId,
      String(division),
      String(vendor),
      String(batchLabel),
      String(setLabel),
      String(branchName),
      uploadedBy || "Unattributed",
      filename || null,
      JSON.stringify(itemRows),
    ]);

    res.json({ ok: true, batchId, skuCount: itemRows.length });
  } catch (e) {
    console.error("admin-upload error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// /* ----------------------------------------------------------------
//    POST /api/dispatch/branch-upload — branch's received set (auto set_number)
//    Items are replaced (DELETE + INSERT) in one transaction.
// ---------------------------------------------------------------- */

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
  try {
    const problem = await dispatchValidate(division, vendor, branchName);
    if (problem) return res.status(400).json({ ok: false, error: problem });

    const { rows: existing } = await db.query(
      `SELECT id, set_label FROM ${T("dispatch_batches")}
       WHERE division = $1 AND vendor = $2 AND batch_label = $3 AND branch_name = $4
       LIMIT 1`,
      [
        String(division),
        String(vendor),
        String(batchLabel),
        String(branchName),
      ],
    );

    const isNew = existing.length === 0;
    let batchId, setLabel;
    if (!isNew) {
      batchId = String(existing[0].id);
      setLabel = existing[0].set_label || null;
    } else {
      // no set_number column in BigQuery: the number lives in set_label as "Set N"
      const { rows: cntRow } = await db.query(
        `SELECT COUNT(*) AS n FROM ${T("dispatch_batches")}
         WHERE division = $1 AND vendor = $2 AND batch_label = $3`,
        [String(division), String(vendor), String(batchLabel)],
      );
      setLabel = `Set ${Number(cntRow[0].n) + 1}`;
      batchId = require("crypto").randomUUID();
    }
    const setNumber = setLabel
      ? Number((setLabel.match(/\d+/) || [])[0]) || null
      : null;

    const qtyMap = {};
    skus.forEach((s) => {
      const k = String(s.sku || s).trim();
      if (k) qtyMap[k] = Number(s.qty) || 1;
    });
    const itemRows = Object.keys(qtyMap).map((sku) => ({
      sku,
      qty: qtyMap[sku],
    }));

    const batchStmt = isNew
      ? `INSERT INTO ${T("dispatch_batches")}
           (id, division, vendor, batch_label, set_label, branch_name,
            source, uploaded_by, source_filename, uploaded_at, updated_at)
         VALUES (@p1, @p2, @p3, @p4, @p5, @p6, 'received', @p7, @p8,
                 CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP());`
      : `UPDATE ${T("dispatch_batches")}
         SET uploaded_by = @p7, source_filename = @p8, updated_at = CURRENT_TIMESTAMP()
         WHERE id = @p1;`;

    const script = `
BEGIN TRANSACTION;

${batchStmt}

DELETE FROM ${T("dispatch_batch_items")} WHERE batch_id = @p1;

INSERT INTO ${T("dispatch_batch_items")} (id, batch_id, sku, qty, scan_count, first_scanned_at, last_scanned_at)
SELECT
  ABS(FARM_FINGERPRINT(CONCAT(@p1, '|', JSON_VALUE(j, '$.sku')))),
  @p1,
  JSON_VALUE(j, '$.sku'),
  SAFE_CAST(JSON_VALUE(j, '$.qty') AS INT64),
  1,
  CURRENT_TIMESTAMP(),
  CURRENT_TIMESTAMP()
FROM UNNEST(JSON_QUERY_ARRAY(@p9)) AS j;

COMMIT TRANSACTION;
`;
    await db.query(script, [
      batchId,
      String(division),
      String(vendor),
      String(batchLabel),
      setLabel,
      String(branchName),
      uploadedBy || "Unattributed",
      filename || null,
      JSON.stringify(itemRows),
    ]);

    res.json({ ok: true, batchId, setNumber, skuCount: itemRows.length });
  } catch (e) {
    console.error("branch-upload error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   GET /api/dispatch/comparison?division=&vendor=&batchLabel=
   Postgres -> BigQuery:
     array_agg(DISTINCT x) FILTER (WHERE x IS NOT NULL)
       -> ARRAY_AGG(DISTINCT x IGNORE NULLS)
---------------------------------------------------------------- */
app.get("/api/dispatch/comparison", async (req, res) => {
  const { division, vendor, batchLabel, setLabel, branchName } = req.query;
  if (!division || !vendor || !batchLabel)
    return res
      .status(400)
      .json({ ok: false, error: "division, vendor, batchLabel required" });
  try {
    const { rows } = await db.query(
      `SELECT b.branch_name, b.source, b.uploaded_by, b.uploaded_at,
              ARRAY_AGG(DISTINCT i.sku IGNORE NULLS) AS skus
       FROM ${T("dispatch_batches")} b
       LEFT JOIN ${T("dispatch_batch_items")} i ON i.batch_id = b.id
       WHERE b.division = $1 AND b.vendor = $2 AND b.batch_label = $3
         AND ($4 IS NULL OR b.set_label = $4)
         AND ($5 IS NULL OR b.branch_name = $5)
       GROUP BY b.branch_name, b.source, b.uploaded_by, b.uploaded_at`,
      [
        String(division),
        String(vendor),
        String(batchLabel),
        setLabel ? String(setLabel) : null,
        branchName ? String(branchName) : null,
      ],
    );

    const byBranch = {};
    rows.forEach((r) => {
      (byBranch[r.branch_name] ||= {})[r.source] = r;
    });

    const results = Object.entries(byBranch).map(([branch, sides]) => {
      const dispatched = new Set(
        (sides.dispatched?.skus || []).map((s) => s.toLowerCase()),
      );
      const received = new Set(
        (sides.received?.skus || []).map((s) => s.toLowerCase()),
      );
      const missing = [...dispatched].filter((s) => !received.has(s));
      const extra = [...received].filter((s) => !dispatched.has(s));
      return {
        branchName: branch,
        dispatchedCount: dispatched.size,
        receivedCount: received.size,
        matched: dispatched.size - missing.length,
        missingSkus: missing,
        extraSkus: extra,
        allMatching:
          !!sides.dispatched &&
          !!sides.received &&
          missing.length === 0 &&
          extra.length === 0,
        hasDispatch: !!sides.dispatched,
        hasReceipt: !!sides.received,
        dispatchedAt: iso(sides.dispatched?.uploaded_at) || null,
        receivedAt: iso(sides.received?.uploaded_at) || null,
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
  if (!division)
    return res.status(400).json({ ok: false, error: "division required" });
  try {
    const { rows } = await db.query(
      `SELECT vendor, batch_label,
              COUNT(DISTINCT IF(source = 'dispatched', branch_name, NULL)) AS dispatched_branches,
              COUNT(DISTINCT IF(source = 'received', branch_name, NULL)) AS received_branches
       FROM ${T("dispatch_batches")}
       WHERE division = $1
       GROUP BY vendor, batch_label
       ORDER BY vendor, batch_label DESC`,
      [String(division)],
    );
    res.json({
      ok: true,
      groups: rows.map((r) => ({
        ...r,
        dispatched_branches: Number(r.dispatched_branches),
        received_branches: Number(r.received_branches),
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   GET /api/dispatch/batch-labels?division=&vendor=
---------------------------------------------------------------- */
app.get("/api/dispatch/batch-labels", async (req, res) => {
  const { division, vendor } = req.query;
  if (!division || !vendor)
    return res
      .status(400)
      .json({ ok: false, error: "division and vendor required" });
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT batch_label FROM ${T("dispatch_batches")}
       WHERE division = $1 AND vendor = $2
       ORDER BY batch_label DESC`,
      [String(division), String(vendor)],
    );
    res.json({ ok: true, batchLabels: rows.map((r) => r.batch_label) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   GET /api/dispatch/set-labels?division=&vendor=&batchLabel=&branchName=
---------------------------------------------------------------- */
app.get("/api/dispatch/set-labels", async (req, res) => {
  const { division, vendor, batchLabel, branchName } = req.query;
  if (!division || !vendor || !batchLabel) {
    return res
      .status(400)
      .json({ ok: false, error: "division, vendor, batchLabel required" });
  }
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT set_label FROM ${T("dispatch_batches")}
       WHERE division = $1 AND vendor = $2 AND batch_label = $3
         AND source = 'dispatched'
         AND ($4 IS NULL OR branch_name = $4)
       ORDER BY set_label ASC`,
      [
        String(division),
        String(vendor),
        String(batchLabel),
        branchName ? String(branchName) : null,
      ],
    );
    res.json({ ok: true, setLabels: rows.map((r) => r.set_label) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   GET /api/dispatch/set-summary?division=&vendor=&batchLabel=
   The old correlated COUNT subquery is now a LEFT JOIN + GROUP BY.
---------------------------------------------------------------- */
app.get("/api/dispatch/set-summary", async (req, res) => {
  const { division, vendor, batchLabel } = req.query;
  if (!division || !vendor || !batchLabel) {
    return res
      .status(400)
      .json({ ok: false, error: "division, vendor, batchLabel required" });
  }
  try {
    const { rows } = await db.query(
      `SELECT b.set_label, b.branch_name, b.source, b.uploaded_at,
              COUNT(i.sku) AS sku_count
       FROM ${T("dispatch_batches")} b
       LEFT JOIN ${T("dispatch_batch_items")} i ON i.batch_id = b.id
       WHERE b.division = $1 AND b.vendor = $2 AND b.batch_label = $3
       GROUP BY b.id, b.set_label, b.branch_name, b.source, b.uploaded_at
       ORDER BY b.set_label, b.branch_name, b.source`,
      [String(division), String(vendor), String(batchLabel)],
    );

    const bySet = {};
    rows.forEach((r) => {
      const set = (bySet[r.set_label] ||= {});
      const branch = (set[r.branch_name] ||= {});
      branch[r.source] = {
        uploadedAt: iso(r.uploaded_at) || null,
        skuCount: Number(r.sku_count),
      };
    });

    const sets = Object.entries(bySet).map(([setLabel, branches]) => ({
      setLabel,
      branches: Object.entries(branches).map(([branchName, sides]) => ({
        branchName,
        dispatchedAt: sides.dispatched?.uploadedAt || null,
        dispatchedCount: sides.dispatched?.skuCount || 0,
        receivedAt: sides.received?.uploadedAt || null,
        receivedCount: sides.received?.skuCount || 0,
        status: !sides.dispatched
          ? "not_dispatched"
          : !sides.received
            ? "awaiting_receipt"
            : "received",
      })),
    }));

    res.json({ ok: true, sets });
  } catch (e) {
    console.error("set-summary error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   POST /api/dispatch/delete-batch   body: { batchId }
   BigQuery has no DELETE ... RETURNING, so the row is read first.
---------------------------------------------------------------- */
app.post("/api/dispatch/delete-batch", async (req, res) => {
  const { batchId } = req.body;
  if (!batchId)
    return res.status(400).json({ ok: false, error: "batchId required" });
  try {
    const { rows } = await db.query(
      `SELECT * FROM ${T("dispatch_batches")} WHERE id = $1`,
      [String(batchId)],
    );
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Batch not found" });

    await db.query(
      `BEGIN TRANSACTION;
       DELETE FROM ${T("dispatch_batch_items")} WHERE batch_id = @p1;
       DELETE FROM ${T("dispatch_batches")} WHERE id = @p1;
       COMMIT TRANSACTION;`,
      [String(batchId)],
    );

    const b = rows[0];
    res.json({
      ok: true,
      deleted: {
        ...b,
        uploaded_at: iso(b.uploaded_at) || null,
        updated_at: iso(b.updated_at) || null,
      },
    });
  } catch (e) {
    console.error("delete-batch error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   GET /api/dispatch/batches?division=&vendor=&batchLabel=
---------------------------------------------------------------- */
app.get("/api/dispatch/batches", async (req, res) => {
  const { division, vendor, batchLabel } = req.query;
  if (!division || !vendor || !batchLabel)
    return res
      .status(400)
      .json({ ok: false, error: "division, vendor, batchLabel required" });
  try {
    const { rows } = await db.query(
      `SELECT b.id, b.branch_name, b.source, b.uploaded_by, b.uploaded_at,
              COUNT(i.sku) AS sku_count,
              COALESCE(SUM(i.scan_count), 0) AS total_scans
       FROM ${T("dispatch_batches")} b
       LEFT JOIN ${T("dispatch_batch_items")} i ON i.batch_id = b.id
       WHERE b.division = $1 AND b.vendor = $2 AND b.batch_label = $3
       GROUP BY b.id, b.branch_name, b.source, b.uploaded_by, b.uploaded_at
       ORDER BY b.branch_name ASC, b.source ASC`,
      [String(division), String(vendor), String(batchLabel)],
    );
    res.json({
      ok: true,
      batches: rows.map((r) => ({
        ...r,
        uploaded_at: iso(r.uploaded_at) || null,
        sku_count: Number(r.sku_count),
        total_scans: Number(r.total_scans),
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   POST /api/dispatch/rename-batch
   body: { division, vendor, oldBatchLabel, newBatchLabel }
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
    const { rows: clash } = await db.query(
      `SELECT 1 FROM ${T("dispatch_batches")}
       WHERE division = $1 AND vendor = $2 AND batch_label = $3 LIMIT 1`,
      [String(division), String(vendor), String(newBatchLabel)],
    );
    if (clash.length > 0) {
      return res.status(400).json({
        ok: false,
        error: `A batch named "${newBatchLabel}" already exists for this vendor — pick a different name or delete it first.`,
      });
    }

    const { rows: cnt } = await db.query(
      `SELECT COUNT(*) AS n FROM ${T("dispatch_batches")}
       WHERE division = $1 AND vendor = $2 AND batch_label = $3`,
      [String(division), String(vendor), String(oldBatchLabel)],
    );

    await db.query(
      `UPDATE ${T("dispatch_batches")}
       SET batch_label = $4, updated_at = CURRENT_TIMESTAMP()
       WHERE division = $1 AND vendor = $2 AND batch_label = $3`,
      [
        String(division),
        String(vendor),
        String(oldBatchLabel),
        String(newBatchLabel),
      ],
    );
    res.json({ ok: true, renamed: Number(cnt[0].n) });
  } catch (e) {
    console.error("rename-batch error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   Retry helper: BigQuery DML on the same table can collide when two
   scans arrive at once ("concurrent update" / "could not serialize").
---------------------------------------------------------------- */
async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || "");
      if (!/concurrent|serialize|conflict|rateLimit|too many/i.test(msg))
        throw e;
      await new Promise((r) =>
        setTimeout(r, 400 * (i + 1) + Math.random() * 300),
      );
    }
  }
  throw lastErr;
}

/* ----------------------------------------------------------------
   POST /api/dispatch/scan-undo   body: { batchId, sku }
   No UPDATE ... RETURNING in BigQuery: read the count, then either
   decrement or delete inside one transaction.
---------------------------------------------------------------- */
app.post("/api/dispatch/scan-undo", async (req, res) => {
  const { batchId, sku } = req.body;
  if (!batchId || !sku)
    return res
      .status(400)
      .json({ ok: false, error: "batchId and sku required" });
  try {
    const { rows } = await db.query(
      `SELECT scan_count FROM ${T("dispatch_batch_items")}
       WHERE batch_id = $1 AND sku = $2 AND scan_count > 0`,
      [String(batchId), String(sku)],
    );
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Item not found" });

    const scanCount = Number(rows[0].scan_count) - 1;
    const removed = scanCount <= 0;

    await withRetry(() =>
      db.query(
        removed
          ? `DELETE FROM ${T("dispatch_batch_items")} WHERE batch_id = $1 AND sku = $2`
          : `UPDATE ${T("dispatch_batch_items")}
             SET scan_count = scan_count - 1, last_scanned_at = CURRENT_TIMESTAMP()
             WHERE batch_id = $1 AND sku = $2`,
        [String(batchId), String(sku)],
      ),
    );

    res.json({ ok: true, scanCount: Math.max(scanCount, 0), removed });
  } catch (e) {
    console.error("scan-undo error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   POST /api/dispatch/scan
---------------------------------------------------------------- */
app.post("/api/dispatch/scan", async (req, res) => {
  const {
    division,
    vendor,
    batchLabel,
    setLabel,
    branchName,
    source,
    sku,
    scannedBy,
  } = req.body;
  if (
    !division ||
    !vendor ||
    !batchLabel ||
    !setLabel ||
    !branchName ||
    !source ||
    !sku
  ) {
    return res.status(400).json({
      ok: false,
      error:
        "division, vendor, batchLabel, setLabel, branchName, source, sku required",
    });
  }
  if (!["dispatched", "received"].includes(source)) {
    return res
      .status(400)
      .json({ ok: false, error: "source must be 'dispatched' or 'received'" });
  }

  try {
    const problem = await dispatchValidate(division, vendor, branchName);
    if (problem) return res.status(400).json({ ok: false, error: problem });

    const cleanSku = String(sku).trim();
    const keyParams = [
      String(division),
      String(vendor),
      String(batchLabel),
      String(setLabel),
      String(branchName),
    ];

    // A "received" scan must match something that was actually dispatched
    if (source === "received") {
      const { rows: dcheck } = await db.query(
        `SELECT id FROM ${T("dispatch_batches")}
         WHERE division = $1 AND vendor = $2 AND batch_label = $3
           AND set_label = $4 AND branch_name = $5 AND source = 'dispatched'
         LIMIT 1`,
        keyParams,
      );
      if (!dcheck.length) {
        return res.status(400).json({
          ok: false,
          error: `${setLabel} was never dispatched to ${branchName} for this batch.`,
        });
      }
      const { rows: skuCheck } = await db.query(
        `SELECT 1 FROM ${T("dispatch_batch_items")}
         WHERE batch_id = $1 AND LOWER(sku) = LOWER($2) LIMIT 1`,
        [String(dcheck[0].id), cleanSku],
      );
      if (!skuCheck.length) {
        return res.status(400).json({
          ok: false,
          error: `SKU "${sku}" was not part of the dispatched list for ${setLabel} → ${branchName}.`,
        });
      }
    }

    // Find (or create) this side's batch
    const { rows: batchRows } = await db.query(
      `SELECT id FROM ${T("dispatch_batches")}
       WHERE division = $1 AND vendor = $2 AND batch_label = $3
         AND set_label = $4 AND branch_name = $5 AND source = $6
       LIMIT 1`,
      [...keyParams, String(source)],
    );
    const isNew = batchRows.length === 0;
    const batchId = isNew
      ? require("crypto").randomUUID()
      : String(batchRows[0].id);

    const batchStmt = isNew
      ? `INSERT INTO ${T("dispatch_batches")}
           (id, division, vendor, batch_label, set_label, branch_name, source,
            uploaded_by, uploaded_at, updated_at)
         VALUES (@p1, @p2, @p3, @p4, @p5, @p6, @p7, @p8,
                 CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP());`
      : `UPDATE ${T("dispatch_batches")}
         SET updated_at = CURRENT_TIMESTAMP(), uploaded_by = @p8
         WHERE id = @p1;`;

    const script = `
BEGIN TRANSACTION;

${batchStmt}

MERGE ${T("dispatch_batch_items")} t
USING (SELECT @p1 AS batch_id, @p9 AS sku) s
ON t.batch_id = s.batch_id AND t.sku = s.sku
WHEN MATCHED THEN UPDATE SET
  scan_count = IFNULL(t.scan_count, 0) + 1,
  last_scanned_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT
  (id, batch_id, sku, qty, scan_count, first_scanned_at, last_scanned_at)
VALUES
  (ABS(FARM_FINGERPRINT(CONCAT(s.batch_id, '|', s.sku))), s.batch_id, s.sku, 1, 1,
   CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP());

COMMIT TRANSACTION;
`;

    await withRetry(() =>
      db.query(script, [
        batchId,
        ...keyParams.slice(0, 5),
        String(source),
        scannedBy || "Unattributed",
        cleanSku,
      ]),
    );

    // One read for the scanned SKU's count plus the batch totals
    const { rows } = await db.query(
      `SELECT
         IFNULL(SUM(IF(sku = $2, scan_count, 0)), 0) AS scan_count,
         COUNT(*) AS unique_skus,
         IFNULL(SUM(scan_count), 0) AS total_scans
       FROM ${T("dispatch_batch_items")}
       WHERE batch_id = $1`,
      [batchId, cleanSku],
    );
    const scanCount = Number(rows[0].scan_count);

    res.json({
      ok: true,
      batchId,
      sku: cleanSku,
      scanCount,
      isDuplicate: scanCount > 1,
      uniqueSkus: Number(rows[0].unique_skus),
      totalScans: Number(rows[0].total_scans),
    });
  } catch (e) {
    console.error("dispatch/scan error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   GET /api/dispatch/scan-log
---------------------------------------------------------------- */
app.get("/api/dispatch/scan-log", async (req, res) => {
  const { division, vendor, batchLabel, setLabel, branchName, source } =
    req.query;
  if (
    !division ||
    !vendor ||
    !batchLabel ||
    !setLabel ||
    !branchName ||
    !source
  ) {
    return res.status(400).json({ ok: false, error: "all params required" });
  }
  try {
    const { rows } = await db.query(
      `SELECT i.sku, i.scan_count, i.first_scanned_at, i.last_scanned_at, b.id AS batch_id
       FROM ${T("dispatch_batch_items")} i
       JOIN ${T("dispatch_batches")} b ON b.id = i.batch_id
       WHERE b.division = $1 AND b.vendor = $2 AND b.batch_label = $3
         AND b.set_label = $4 AND b.branch_name = $5 AND b.source = $6
       ORDER BY i.last_scanned_at DESC`,
      [
        String(division),
        String(vendor),
        String(batchLabel),
        String(setLabel),
        String(branchName),
        String(source),
      ],
    );
    res.json({
      ok: true,
      items: rows.map((r) => ({
        ...r,
        scan_count: Number(r.scan_count),
        first_scanned_at: iso(r.first_scanned_at) || null,
        last_scanned_at: iso(r.last_scanned_at) || null,
      })),
      batchId: rows.length ? rows[0].batch_id : null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------------------------------------------
   GET /api/dispatch/branch-pending?division=&branchName=
   SKU arrays are built per batch in CTEs first, then joined, so the
   dispatched x received item lists are never cross-multiplied.
---------------------------------------------------------------- */
app.get("/api/dispatch/branch-pending", async (req, res) => {
  const { division, branchName } = req.query;
  if (!division || !branchName) {
    return res
      .status(400)
      .json({ ok: false, error: "division and branchName required" });
  }
  try {
    const { rows } = await db.query(
      `WITH skus_by_batch AS (
         SELECT batch_id, ARRAY_AGG(DISTINCT sku IGNORE NULLS) AS skus
         FROM ${T("dispatch_batch_items")}
         GROUP BY batch_id
       )
       SELECT
         d.id AS dispatch_batch_id,
         d.vendor, d.batch_label, d.set_label, d.uploaded_at AS dispatched_at,
         ds.skus AS dispatched_skus,
         r.id AS received_batch_id,
         r.uploaded_at AS received_at,
         rs.skus AS received_skus
       FROM ${T("dispatch_batches")} d
       LEFT JOIN skus_by_batch ds ON ds.batch_id = d.id
       LEFT JOIN ${T("dispatch_batches")} r
         ON r.division = d.division AND r.vendor = d.vendor
        AND r.batch_label = d.batch_label AND r.set_label = d.set_label
        AND r.branch_name = d.branch_name AND r.source = 'received'
       LEFT JOIN skus_by_batch rs ON rs.batch_id = r.id
       WHERE d.division = $1 AND d.branch_name = $2 AND d.source = 'dispatched'
       ORDER BY d.uploaded_at DESC`,
      [String(division), String(branchName)],
    );

    const result = rows.map((r) => {
      const dispatchedSet = new Set(
        (r.dispatched_skus || []).map((s) => s.toLowerCase()),
      );
      const receivedSet = new Set(
        (r.received_skus || []).map((s) => s.toLowerCase()),
      );
      const pendingSkus = [...dispatchedSet].filter((s) => !receivedSet.has(s));
      return {
        vendor: r.vendor,
        batch_label: r.batch_label,
        set_label: r.set_label,
        dispatched_at: iso(r.dispatched_at) || null,
        received_at: iso(r.received_at) || null,
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

/* ----------------------------------------------------------------
   Server start + graceful shutdown
   (no DB pool to close with BigQuery, so only the HTTP server is stopped)
---------------------------------------------------------------- */
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`${signal} received — starting graceful shutdown`);

  const forceExitTimer = setTimeout(() => {
    console.error("Forced shutdown — requests did not finish in time");
    process.exit(1);
  }, 10000);

  server.close(() => {
    clearTimeout(forceExitTimer);
    console.log("HTTP server closed cleanly");
    process.exit(0);
  });
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
//
// const PORT = process.env.PORT || 8080;
// app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
//



