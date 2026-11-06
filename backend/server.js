/* ===================== TOP OF FILE ===================== */

require('dotenv').config()
const express = require('express')
const mysql = require('mysql2/promise')
const cors = require('cors')
const { randomUUID, createHash } = require('node:crypto')

const app = express()
app.use(cors({ origin: '*' }))
app.use(express.json({ limit: '25mb' }))

/* ===================== 🔄 CHANGED: connection ===================== */
// Removed: PROJECT_ID, APP_DATASET, DEST_DATASET, LOCATION, new BigQuery(...)

const mysqlPool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DB,
  waitForConnections: true,
  connectionLimit: Number(process.env.MYSQL_POOL_SIZE || 5),
  queueLimit: 0,
  charset: 'utf8mb4',
  dateStrings: true,
  decimalNumbers: true,
  multipleStatements: false,
  connectTimeout: 20000,

  // new: keep connections alive and drop idle ones before the network kills them
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  maxIdle: 2,
  idleTimeout: 60000
})

mysqlPool
  .query('SELECT 1')
  .then(() => console.log('MySQL connected'))
  .catch(e => console.error('MySQL connection failed:', e.message))

/* ===================== 🔄 CHANGED: query layer ===================== */
// Removed: toBqParams, isWrite queue, writeQueue, BigQuery execQuery

// Same name, same usage: T('products'). Only the quoting changed.
const T = table => `\`${table}\``

// $1, $2 -> ?  (handles reused / out-of-order placeholders)
function convertPlaceholders (sql, params = []) {
  const values = []
  const converted = sql.replace(/\$(\d+)/g, (_, n) => {
    const v = params[Number(n) - 1]
    values.push(v === undefined ? null : v)
    return '?'
  })
  return { sql: converted, values }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

const isRetryable = e =>
  e &&
  (e.code === 'ER_LOCK_DEADLOCK' ||
    e.code === 'ER_LOCK_WAIT_TIMEOUT' ||
    e.errno === 1213 ||
    e.errno === 1205)

const isWrite = sql =>
  /^\s*(INSERT|UPDATE|DELETE|REPLACE|START TRANSACTION|BEGIN)\b/i.test(sql)

async function execQuery (sql, params = [], conn = mysqlPool) {
  const { sql: converted, values } = convertPlaceholders(sql, params)
  const [result] = await conn.query(converted, values)

  if (Array.isArray(result)) {
    return { rows: result, rowCount: result.length }
  }
  return {
    rows: [],
    rowCount: result.affectedRows,
    insertId: result.insertId,
    affectedRows: result.affectedRows,
    changedRows: result.changedRows
  }
}

async function runQuery (sql, params = []) {
  if (!isWrite(sql)) return execQuery(sql, params)
  let lastErr
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await execQuery(sql, params)
    } catch (e) {
      lastErr = e
      if (!isRetryable(e)) throw e
      await sleep(500 * (attempt + 1) + Math.random() * 300)
    }
  }
  throw lastErr
}

// FIXED: passes a client object with .query(), so it works with
// functions like loadFullProduct(client, id) and hydrateProducts(client, rows)
//
//   await db.transaction(async client => {
//     await client.query('UPDATE ... WHERE id = $1', [id])
//     await client.query('INSERT ...', [...])
//   })
async function transaction (fn) {
  const conn = await mysqlPool.getConnection()
  try {
    await conn.beginTransaction()
    const client = { query: (sql, params = []) => execQuery(sql, params, conn) }
    const result = await fn(client)
    await conn.commit()
    return result
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
}

const db = { query: runQuery, transaction } // 🔄 CHANGED (added transaction)
const pool = db // ✅ NO CHANGE
const MAX_PRODUCTS = 100000 // ✅ NO CHANGE

/* ===================== ✅ NO CHANGE ===================== */

async function getProductCount (client = db) {
  const { rows } = await client.query(
    `SELECT COUNT(*) AS count FROM ${T('products')}`
  )
  return Number(rows[0].count)
}

const STAGE_KEYS = [
  'barcoding',
  'content',
  'photography',
  'photoedit',
  'videography',
  'dimensions',
  'videoedit',
  'images',
  'backend',
  'website',
  'scan',
  'qc',
  'finalqc'
]

const STORES = [
  'Chamrajpet',
  'HSR Layout',
  'Sahakar Nagar',
  'Hoodi',
  'Jayanagar',
  'Bommasandra',
  'Hyderabad',
  'Mysore',
  'Vizag',
  'Hubli',
  'Chitradurga'
]

const PIPELINE_STAGE_COUNT = STAGE_KEYS.filter(k => k !== 'finalqc').length // 11

app.get('/', (req, res) =>
  res.json({ message: 'Card Tracker API is running!' })
)

/* ===================== 🔄 CHANGED: health routes ===================== */

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1')
    res.json({
      ok: true,
      version: 'assignments-no-txn-mysql',
      db: 'connected to MySQL successfully!'
    })
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

app.get('/health/pool', (req, res) => {
  const p = mysqlPool.pool
  res.json({
    type: 'mysql',
    connectionLimit: p.config.connectionLimit,
    totalConnections: p._allConnections ? p._allConnections.length : null,
    freeConnections: p._freeConnections ? p._freeConnections.length : null,
    queuedRequests: p._connectionQueue ? p._connectionQueue.length : null
  })
})

/* ===================== ✅ NO CHANGE ===================== */

async function loadFullProduct (client, productId) {
  const { rows: prows } = await client.query(
    `SELECT * FROM ${T('products')} WHERE id = $1`,
    [productId]
  )
  if (!prows.length) return null
  return hydrateProducts(client, prows).then(arr => arr[0])
}

/* ===================== 🔄 CHANGED: value helpers ===================== */
// Removed: BigQuery { value: "..." } handling

const toDate = v => {
  if (!v) return null
  if (v instanceof Date) return isNaN(v) ? null : v
  let s = String(v).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00Z'
  else if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) s = s.replace(' ', 'T') + 'Z'
  const d = new Date(s)
  return isNaN(d) ? null : d
}

const iso = v => {
  const d = toDate(v)
  return d ? d.toISOString() : ''
}

const dateOnly = v => {
  if (!v) return ''
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v))
    return v.slice(0, 10)
  const d = toDate(v)
  return d ? d.toISOString().slice(0, 10) : String(v).slice(0, 10)
}

const parseJson = (v, fallback = null) => {
  if (v === null || v === undefined) return fallback
  if (Buffer.isBuffer(v)) v = v.toString('utf8')
  if (typeof v === 'string') {
    try {
      return JSON.parse(v)
    } catch {
      return v
    }
  }
  return v
}

// 🆕 NEW helper: replaces `IN UNNEST($1)` and splits very large id lists
const chunk = (arr, size = 5000) => {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function selectByProductIds (client, table, ids) {
  const parts = await Promise.all(
    chunk(ids).map(part =>
      client.query(`SELECT * FROM ${T(table)} WHERE product_id IN ($1)`, [part])
    )
  )
  return parts.flatMap(r => r.rows)
}

/* ===================== hydrateProducts ===================== */

async function hydrateProducts (client, productRows) {
  if (productRows.length === 0) return []
  const ids = productRows.map(p => String(p.id))

  // 🔄 CHANGED: was `WHERE product_id IN UNNEST($1)`
  const [stageRows, storeRows] = await Promise.all([
    selectByProductIds(client, 'stage_entries', ids),
    selectByProductIds(client, 'stores', ids)
  ])

  // ✅ NO CHANGE
  const stagesByProduct = {}
  stageRows.forEach(r => {
    ;(stagesByProduct[r.product_id] ||= {})[r.stage_key] = {
      status: r.status,
      person: r.person || '',
      comments: r.comments || '',
      skipped: !!r.skipped,
      at: iso(r.updated_at),
      ...(r.stage_key === 'dimensions'
        ? {
            width: r.width_cm != null ? String(r.width_cm) : '',
            height: r.height_cm != null ? String(r.height_cm) : '',
            weight: r.weight_gm != null ? String(r.weight_gm) : ''
          }
        : {})
    }
  })

  // 🔄 CHANGED: dispatched/received/missing/damaged conversions
  const storesByProduct = {}
  storeRows.forEach(r => {
    ;(storesByProduct[r.product_id] ||= {})[r.store] = {
      dispatched: Number(r.dispatched) || 0,
      received: !!r.received,
      receivedAt: iso(r.received_at),
      receivedBy: r.received_by || '',
      missing: Number(r.missing) || 0,
      damaged: Number(r.damaged) || 0,
      notes: r.notes || '',
      at: iso(r.updated_at)
    }
  })

  // ✅ NO CHANGE (entire return block)
  return productRows.map(p => {
    const stages = {}
    STAGE_KEYS.forEach(k => {
      stages[k] = (stagesByProduct[p.id] && stagesByProduct[p.id][k]) || {
        status: 'Not Started',
        person: '',
        comments: '',
        at: ''
      }
      if (k === 'dimensions' && !stages[k].width) {
        stages[k].width = stages[k].width || ''
        stages[k].height = stages[k].height || ''
        stages[k].weight = stages[k].weight || ''
      }
    })

    const stores = {}
    STORES.forEach(st => {
      stores[st] = (storesByProduct[p.id] && storesByProduct[p.id][st]) || {
        dispatched: 0,
        received: false,
        receivedAt: '',
        receivedBy: '',
        missing: 0,
        damaged: 0,
        notes: '',
        at: ''
      }
    })

    return {
      id: p.id,
      division: p.division,
      sku: p.sku,
      name: p.name || '',
      vendor: p.vendor || '',
      inward: dateOnly(p.inward),
      qty: p.qty || 0,
      note: p.note || '',
      set_no: p.set_no || '',
      verdict: p.verdict || '',
      issues: p.issues || '',
      stages,
      stores,
      createdAt: iso(p.created_at),
      updatedAt: iso(p.updated_at)
    }
  })
}

/* ===================== ✅ NO CHANGE: GET /api/getAll ===================== */
// Only the comment changed. All queries are standard SQL and work in MySQL as they are.

app.get('/api/getAll', async (req, res) => {
  try {
    // Independent queries run in parallel
    const [
      { rows: productRows },
      { rows: vendorRows },
      { rows: teamRows },
      { rows: assignRows },
      { rows: qcRows },
      { rows: auditRows },
      { rows: historyRows }
    ] = await Promise.all([
      db.query(`SELECT * FROM ${T('products')} ORDER BY created_at DESC`),
      db.query(
        `SELECT division, vendor_name FROM ${T('vendors')} ORDER BY vendor_name`
      ),
      db.query(`SELECT * FROM ${T('users')} WHERE role = 'member'`),
      db.query(`SELECT * FROM ${T('assignments')} ORDER BY assigned_at DESC`),
      db.query(`SELECT * FROM ${T('qc_audit')} ORDER BY audited_at DESC`),
      db.query(
        `SELECT * FROM ${T('audit_log')} ORDER BY logged_at DESC LIMIT 800`
      ),
      db.query(
        `SELECT ah.*,
                u1.name AS to_member_name,
                u2.name AS from_member_name
         FROM ${T('assignment_history')} ah
         LEFT JOIN ${T('users')} u1 ON u1.id = ah.to_member_id
         LEFT JOIN ${T('users')} u2 ON u2.id = ah.from_member_id
         ORDER BY ah.logged_at DESC LIMIT 500`
      )
    ])

    const products = await hydrateProducts(db, productRows)

    const vendors = {}
    vendorRows.forEach(v => {
      ;(vendors[v.division] ||= []).push(v.vendor_name)
    })

    const teamMembers = teamRows.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      password: u.password,
      role: u.role,
      stages: parseJson(u.stages, []),
      division: u.division,
      managerId: u.manager_id,
      joinedAt: iso(u.joined_at)
    }))

    const assignments = assignRows.map(a => ({
      id: a.id,
      memberId: a.member_id,
      managerId: a.manager_id,
      sku: a.sku,
      stage: a.stage,
      division: a.division,
      assignedAt: iso(a.assigned_at)
    }))

    const qcAudit = qcRows.map(q => ({
      id: q.id,
      at: iso(q.audited_at),
      auditor: q.auditor_name,
      sku: q.sku,
      division: q.division,
      productId: q.product_id,
      verdict: q.verdict,
      comments: q.comments,
      stagesSentBack: parseJson(q.stages_sent_back, [])
    }))

    const audit = auditRows.map(a => ({
      id: a.id,
      at: iso(a.logged_at),
      actor: a.actor_name,
      action: a.action,
      entity: a.entity,
      detail: a.detail,
      division: a.division
    }))

    const assignmentHistory = historyRows.map(r => ({
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
      at: iso(r.logged_at)
    }))

    res.json({
      products,
      vendors,
      teamMembers,
      assignments,
      qcAudit,
      audit,
      assignmentHistory
    })
  } catch (e) {
    console.error('getAll error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== ✅ NO CHANGE: GET /api/getUsers ===================== */

app.get('/api/getUsers', async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT * FROM ${T('users')}`)
    res.json(
      rows.map(u => ({
        id: u.id,
        name: u.name,
        email: u.email,
        password: u.password,
        role: u.role,
        stages: parseJson(u.stages, []),
        division: u.division,
        managerId: u.manager_id,
        joinedAt: iso(u.joined_at)
      }))
    )
  } catch (e) {
    console.error('getUsers error', e)
    res.status(500).json([])
  }
})

/* ===================== 🆕 NEW helpers (put above the two routes below) ===================== */

// MySQL DATETIME does not accept "2026-11-06T10:30:00.000Z".
// This converts any date/ISO value to "2026-11-06 10:30:00" (UTC), or null.
const toMysqlDt = v => {
  const d = toDate(v)
  return d ? d.toISOString().slice(0, 19).replace('T', ' ') : null
}

// Runs a transaction and retries it automatically on deadlock / lock wait timeout
async function txWithRetry (fn) {
  let lastErr
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await db.transaction(fn)
    } catch (e) {
      lastErr = e
      if (!isRetryable(e)) throw e
      await sleep(500 * (attempt + 1) + Math.random() * 300)
    }
  }
  throw lastErr
}

/* ===================== 🔄 CHANGED: POST /api/batchUpsertProducts ===================== */

const UPSERT_CHUNK_SIZE = 100

app.post('/api/batchUpsertProducts', async (req, res) => {
  const input = req.body
  if (!Array.isArray(input))
    return res.status(400).json({ ok: false, error: 'expected array' })
  if (input.length === 0) return res.json({ ok: true, count: 0 })

  try {
    // De-duplicate by id
    const byId = new Map()
    input.forEach(p => {
      if (p && p.id) byId.set(String(p.id), p)
    })
    const products = [...byId.values()]
    const nowDt = toMysqlDt(new Date())

    // ---- Cap check ----
    // 🔄 CHANGED: was `WHERE id IN UNNEST($1)`
    const currentCount = await getProductCount(db)
    const existingIdSet = new Set()
    for (const part of chunk([...byId.keys()])) {
      const { rows } = await db.query(
        `SELECT id FROM ${T('products')} WHERE id IN ($1)`,
        [part]
      )
      rows.forEach(r => existingIdSet.add(String(r.id)))
    }
    const newCount = products.filter(
      p => !existingIdSet.has(String(p.id))
    ).length

    if (currentCount + newCount > MAX_PRODUCTS) {
      return res.status(400).json({
        ok: false,
        error: `Product cap of ${MAX_PRODUCTS} would be exceeded. Currently ${currentCount}, trying to add ${newCount} new products.`
      })
    }

    const numOrNull = v => (v ? Number(v) || null : null)

    // ---- Apply in chunks ----
    for (let i = 0; i < products.length; i += UPSERT_CHUNK_SIZE) {
      const part = products.slice(i, i + UPSERT_CHUNK_SIZE)

      // Rows are plain arrays, in the same order as the column lists below
      const productRows = []
      const stageRows = []
      const storeRows = []

      for (const p of part) {
        productRows.push([
          String(p.id),
          p.division ?? null,
          p.sku ?? null,
          p.name || '',
          p.vendor || null,
          p.inward ? dateOnly(p.inward) || null : null,
          Number(p.qty) || 0,
          p.note || '',
          p.set_no || null,
          p.verdict || null,
          p.issues || '',
          toMysqlDt(p.createdAt) || nowDt,
          toMysqlDt(p.updatedAt) || nowDt
        ])

        if (p.stages) {
          for (const key of Object.keys(p.stages)) {
            const s = p.stages[key] || {}
            stageRows.push([
              String(p.id),
              key,
              s.status || 'Not Started',
              s.person || null,
              s.comments || '',
              toMysqlDt(s.at) || nowDt,
              numOrNull(s.width),
              numOrNull(s.height),
              numOrNull(s.weight)
            ])
          }
        }

        if (p.stores) {
          for (const store of Object.keys(p.stores)) {
            const s = p.stores[store] || {}
            storeRows.push([
              String(p.id),
              store,
              Number(s.dispatched) || 0,
              s.received ? 1 : 0,
              toMysqlDt(s.receivedAt),
              s.receivedBy || null,
              Number(s.missing) || 0,
              Number(s.damaged) || 0,
              s.notes || '',
              toMysqlDt(s.at) || nowDt
            ])
          }
        }
      }

      // 🔄 CHANGED: three MERGEs become three INSERT ... ON DUPLICATE KEY UPDATE,
      // all inside one transaction (chunk is all-or-nothing, same as before).
      // Note: created_at is not updated on existing rows, same as the old MERGE.
      await txWithRetry(async client => {
        if (productRows.length) {
          await client.query(
            `INSERT INTO ${T('products')}
               (id, division, sku, name, vendor, inward, qty, note, set_no,
                verdict, issues, created_at, updated_at)
             VALUES $1
             ON DUPLICATE KEY UPDATE
               division = VALUES(division), sku = VALUES(sku), name = VALUES(name),
               vendor = VALUES(vendor), inward = VALUES(inward), qty = VALUES(qty),
               note = VALUES(note), set_no = VALUES(set_no),
               verdict = VALUES(verdict), issues = VALUES(issues),
               updated_at = VALUES(updated_at)`,
            [productRows]
          )
        }

        if (stageRows.length) {
          await client.query(
            `INSERT INTO ${T('stage_entries')}
               (product_id, stage_key, status, person, comments, updated_at,
                width_cm, height_cm, weight_gm)
             VALUES $1
             ON DUPLICATE KEY UPDATE
               status = VALUES(status), person = VALUES(person),
               comments = VALUES(comments), updated_at = VALUES(updated_at),
               width_cm = VALUES(width_cm), height_cm = VALUES(height_cm),
               weight_gm = VALUES(weight_gm)`,
            [stageRows]
          )
        }

        if (storeRows.length) {
          await client.query(
            `INSERT INTO ${T('stores')}
               (product_id, store, dispatched, received, received_at,
                received_by, missing, damaged, notes, updated_at)
             VALUES $1
             ON DUPLICATE KEY UPDATE
               dispatched = VALUES(dispatched), received = VALUES(received),
               received_at = VALUES(received_at), received_by = VALUES(received_by),
               missing = VALUES(missing), damaged = VALUES(damaged),
               notes = VALUES(notes), updated_at = VALUES(updated_at)`,
            [storeRows]
          )
        }
      })
    }

    res.json({ ok: true, count: products.length })
  } catch (e) {
    console.error('batchUpsertProducts error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: POST /api/batchPatchStage ===================== */

app.post('/api/batchPatchStage', async (req, res) => {
  const { ids, stageKey, patch } = req.body
  if (!Array.isArray(ids) || !stageKey || !patch)
    return res.status(400).json({ ok: false, error: 'bad payload' })
  if (ids.length === 0) return res.json({ ok: true, count: 0 })

  try {
    const uniqueIds = [...new Set(ids.map(i => String(i)))]
    const nowDt = toMysqlDt(new Date())

    // Same values as before
    const status = patch.status || null
    const person = patch.person ?? null
    const comments = patch.comments ?? ''
    const skipped = patch.skipped == null ? null : patch.skipped ? 1 : 0

    await txWithRetry(async client => {
      for (const part of chunk(uniqueIds, 1000)) {
        // Rows used only when the stage entry does not exist yet (INSERT path)
        const rows = part.map(id => [
          id,
          String(stageKey),
          status || 'Not Started',
          person,
          comments,
          skipped ?? 0,
          nowDt
        ])

        // If the row exists, the UPDATE part runs with COALESCE, so fields
        // you did not send keep their current values (same as the old MERGE).
        await client.query(
          `INSERT INTO ${T('stage_entries')}
             (product_id, stage_key, status, person, comments, skipped, updated_at)
           VALUES $1
           ON DUPLICATE KEY UPDATE
             status     = COALESCE($2, status),
             person     = COALESCE($3, person),
             comments   = COALESCE($4, comments),
             skipped    = COALESCE($5, skipped),
             updated_at = $6`,
          [rows, status, person, comments, skipped, nowDt]
        )

        await client.query(
          `UPDATE ${T('products')} SET updated_at = $1 WHERE id IN ($2)`,
          [nowDt, part]
        )
      }
    })

    res.json({ ok: true, count: ids.length })
  } catch (e) {
    console.error('batchPatchStage error', e.message)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: POST /api/patchQCVerdict ===================== */

app.post('/api/patchQCVerdict', async (req, res) => {
  const { id, verdict, issues } = req.body
  try {
    await db.query(
      `UPDATE ${T('products')}
       SET verdict = $2, issues = $3, updated_at = $4
       WHERE id = $1`,
      [String(id), verdict || null, issues || '', toMysqlDt(new Date())]
    )
    res.json({ ok: true })
  } catch (e) {
    console.error('patchQCVerdict error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: POST /api/appendQCAudit ===================== */

app.post('/api/appendQCAudit', async (req, res) => {
  const e = req.body
  try {
    // stages_sent_back: arrays are stored as a JSON string
    const sentBack = Array.isArray(e.stagesSentBack)
      ? JSON.stringify(e.stagesSentBack)
      : e.stagesSentBack || ''

    await db.query(
      `INSERT INTO ${T('qc_audit')}
         (id, audited_at, auditor_name, product_id, sku, division, verdict, comments, stages_sent_back)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        e.id ? String(e.id) : randomUUID(),
        toMysqlDt(e.at) || toMysqlDt(new Date()),
        e.auditor || '',
        e.productId ?? null,
        e.sku ?? null,
        e.division ?? null,
        e.verdict ?? null,
        e.comments || '',
        sentBack
      ]
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('appendQCAudit error', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

/* ===================== 🔄 CHANGED: POST /api/upsertStore ===================== */

app.post('/api/upsertStore', async (req, res) => {
  const { productId, store, storeData } = req.body
  if (!productId || !store || !storeData)
    return res.status(400).json({ ok: false, error: 'bad payload' })
  try {
    const nowDt = toMysqlDt(new Date())
    const dispatched = Math.trunc(Number(storeData.dispatched) || 0)
    const received = storeData.received ? 1 : 0
    const receivedAt = toMysqlDt(storeData.receivedAt)
    const receivedBy = storeData.receivedBy || null
    const missing = Math.trunc(Number(storeData.missing) || 0)
    const damaged = Math.trunc(Number(storeData.damaged) || 0)
    const notes = storeData.notes || ''

    await txWithRetry(async client => {
      await client.query(
        `INSERT INTO ${T('stores')}
           (product_id, store, dispatched, received, received_at,
            received_by, missing, damaged, notes, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON DUPLICATE KEY UPDATE
           dispatched = VALUES(dispatched), received = VALUES(received),
           received_at = VALUES(received_at), received_by = VALUES(received_by),
           missing = VALUES(missing), damaged = VALUES(damaged),
           notes = VALUES(notes), updated_at = VALUES(updated_at)`,
        [
          String(productId),
          store,
          dispatched,
          received,
          receivedAt,
          receivedBy,
          missing,
          damaged,
          notes,
          nowDt
        ]
      )

      await client.query(
        `UPDATE ${T('products')} SET updated_at = $1 WHERE id = $2`,
        [nowDt, String(productId)]
      )
    })

    res.json({ ok: true })
  } catch (e) {
    console.error('upsertStore error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: POST /api/appendAssignmentHistory ===================== */

app.post('/api/appendAssignmentHistory', async (req, res) => {
  const e = req.body
  try {
    await db.query(
      `INSERT INTO ${T('assignment_history')}
         (id, action, sku, division, from_member_id, to_member_id, manager_id, stage, note, logged_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        e.id ? String(e.id) : randomUUID(),
        e.action ?? null,
        e.sku ?? null,
        e.division ?? null,
        e.fromMemberId || null,
        e.toMemberId ?? null,
        e.managerId ?? null,
        e.stage || '',
        e.note || '',
        toMysqlDt(e.at) || toMysqlDt(new Date())
      ]
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('appendAssignmentHistory error', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

/* ===================== 🔄 CHANGED: POST /api/appendAssignmentHistoryBatch ===================== */

app.post('/api/appendAssignmentHistoryBatch', async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : []
  if (list.length === 0) return res.json({ ok: true, count: 0 })
  try {
    const nowDt = toMysqlDt(new Date())

    // Plain arrays, in the same order as the column list below
    const rows = list.map(e => [
      e.id ? String(e.id) : randomUUID(),
      e.action ?? null,
      e.sku ?? null,
      e.division ?? null,
      e.fromMemberId || null,
      e.toMemberId ?? null,
      e.managerId ?? null,
      e.stage || '',
      e.note || '',
      toMysqlDt(e.at) || nowDt
    ])

    // All chunks succeed or none do
    await txWithRetry(async client => {
      for (const part of chunk(rows, 1000)) {
        await client.query(
          `INSERT INTO ${T('assignment_history')}
             (id, action, sku, division, from_member_id, to_member_id, manager_id, stage, note, logged_at)
           VALUES $1`,
          [part]
        )
      }
    })

    res.json({ ok: true, count: rows.length })
  } catch (err) {
    console.error('appendAssignmentHistoryBatch error', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

/* ===================== ✅ NO CHANGE: GET /api/assignmentHistory ===================== */
// `($1 IS NULL OR ah.division = $1)` works in MySQL as is. The placeholder
// converter handles the reused $1.

app.get('/api/assignmentHistory', async (req, res) => {
  try {
    const { division } = req.query
    const { rows } = await db.query(
      `SELECT ah.*,
              u1.name AS to_member_name,
              u2.name AS from_member_name,
              u3.name AS manager_name
       FROM ${T('assignment_history')} ah
       LEFT JOIN ${T('users')} u1 ON u1.id = ah.to_member_id
       LEFT JOIN ${T('users')} u2 ON u2.id = ah.from_member_id
       LEFT JOIN ${T('users')} u3 ON u3.id = ah.manager_id
       WHERE ($1 IS NULL OR ah.division = $1)
       ORDER BY ah.logged_at DESC
       LIMIT 1000`,
      [division || null]
    )
    res.json(rows.map(r => ({ ...r, logged_at: iso(r.logged_at) })))
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: POST /api/deleteProduct ===================== */

app.post('/api/deleteProduct', async (req, res) => {
  const { id } = req.body
  if (!id) return res.status(400).json({ ok: false, error: 'id required' })
  try {
    const pid = String(id)

    // MySQL cannot run several statements in one query (multipleStatements is
    // off, which is safer). They now run in one transaction, so either
    // everything is deleted or nothing is. The product row goes last.
    await txWithRetry(async client => {
      await client.query(
        `DELETE FROM ${T('stage_entries')} WHERE product_id = $1`,
        [pid]
      )
      await client.query(`DELETE FROM ${T('stores')} WHERE product_id = $1`, [
        pid
      ])
      await client.query(
        `DELETE FROM ${T('assignments')} WHERE product_id = $1`,
        [pid]
      )
      await client.query(`DELETE FROM ${T('qc_audit')} WHERE product_id = $1`, [
        pid
      ])
      await client.query(`DELETE FROM ${T('products')} WHERE id = $1`, [pid])
    })

    res.json({ ok: true })
  } catch (e) {
    console.error('deleteProduct error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== ✅ NO CHANGE: GET /api/checkStage ===================== */

app.get('/api/checkStage', async (req, res) => {
  const { productId, stageKey } = req.query
  try {
    const { rows } = await db.query(
      `SELECT status, updated_at FROM ${T('stage_entries')}
       WHERE product_id = $1 AND stage_key = $2`,
      [String(productId), String(stageKey)]
    )
    const row = rows[0]
      ? { status: rows[0].status, updated_at: iso(rows[0].updated_at) }
      : null
    res.json({ ok: true, row })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: POST /api/setVendors ===================== */

app.post('/api/setVendors', async (req, res) => {
  try {
    const seen = new Set()
    const rows = []
    for (const division of Object.keys(req.body || {})) {
      for (const vendorName of req.body[division] || []) {
        const key = `${division}||${vendorName}`
        if (seen.has(key)) continue
        seen.add(key)
        rows.push([division, vendorName])
      }
    }
    if (rows.length === 0) return res.json({ ok: true })

    // Insert only new vendors. Existing ones are left as they are, the same as
    // the old "WHEN NOT MATCHED" only MERGE.
    await txWithRetry(async client => {
      for (const part of chunk(rows, 1000)) {
        await client.query(
          `INSERT INTO ${T('vendors')} (division, vendor_name)
           VALUES $1
           ON DUPLICATE KEY UPDATE vendor_name = vendor_name`,
          [part]
        )
      }
    })

    res.json({ ok: true })
  } catch (e) {
    console.error('setVendors error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== ✅ NO CHANGE: auth helpers ===================== */

async function attachUserFromHeader (req, res, next) {
  try {
    const email = String(req.headers['x-user-email'] || '')
      .trim()
      .toLowerCase()
    if (email) {
      const { rows } = await db.query(
        `SELECT email, role FROM ${T('users')} WHERE LOWER(email) = $1 LIMIT 1`,
        [email]
      )
      if (rows.length) req.user = { email: rows[0].email, role: rows[0].role }
    }
    next()
  } catch (e) {
    console.error('attachUserFromHeader error:', e)
    res.status(500).json({ ok: false, error: 'Could not verify user' })
  }
}

function requireVendorIssueUser (req, res, next) {
  if (!req.user || !req.user.email || !req.user.role) {
    return res.status(401).json({ ok: false, error: 'Authentication required' })
  }
  next()
}

function requireVendorIssueMaster (req, res, next) {
  if (String(req.user.role).toLowerCase() !== 'master') {
    return res
      .status(403)
      .json({ ok: false, error: 'Only Masters can modify vendor issues' })
  }
  next()
}

/* ===================== ✅ NO CHANGE: GET /api/vendor-issues ===================== */

app.get('/api/vendor-issues', async (req, res) => {
  try {
    const vendor = String(req.query.vendor || '').trim()
    if (!vendor) {
      return res
        .status(400)
        .json({ ok: false, error: 'Vendor name is required' })
    }
    const { rows } = await db.query(
      `SELECT id, vendor_name, note, created_by, created_at, updated_by, updated_at
       FROM ${T('vendor_issues')}
       WHERE vendor_name = $1
       ORDER BY created_at DESC`,
      [vendor]
    )
    res.json({
      ok: true,
      issues: rows.map(r => ({
        ...r,
        created_at: iso(r.created_at) || null,
        updated_at: iso(r.updated_at) || null
      }))
    })
  } catch (error) {
    console.error('getVendorIssues error:', error)
    res.status(500).json({ ok: false, error: 'Failed to fetch vendor issues' })
  }
})

/* ===================== 🔄 CHANGED: POST /api/vendor-issues ===================== */

app.post(
  '/api/vendor-issues',
  attachUserFromHeader,
  requireVendorIssueUser,
  requireVendorIssueMaster,
  async (req, res) => {
    try {
      const { vendorName, note } = req.body || {}
      if (
        typeof vendorName !== 'string' ||
        !vendorName.trim() ||
        typeof note !== 'string' ||
        !note.trim()
      ) {
        return res
          .status(400)
          .json({ ok: false, error: 'Vendor name and note are required' })
      }
      if (note.trim().length > 5000) {
        return res
          .status(400)
          .json({ ok: false, error: 'Note cannot exceed 5000 characters' })
      }

      const vendor = vendorName.trim()
      const { rows: vendors } = await db.query(
        `SELECT vendor_name FROM ${T(
          'vendors'
        )} WHERE vendor_name = $1 LIMIT 1`,
        [vendor]
      )
      if (!vendors.length) {
        return res.status(404).json({ ok: false, error: 'Vendor not found' })
      }

      const id = randomUUID()
      await db.query(
        `INSERT INTO ${T('vendor_issues')}
           (id, vendor_name, note, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, vendor, note.trim(), req.user.email, toMysqlDt(new Date())]
      )
      res
        .status(201)
        .json({ ok: true, message: 'Vendor issue created successfully', id })
    } catch (error) {
      console.error('createVendorIssue error:', error)
      res
        .status(500)
        .json({ ok: false, error: 'Failed to create vendor issue' })
    }
  }
)

/* ===================== 🔄 CHANGED: PATCH /api/vendor-issues/:id ===================== */

app.patch(
  '/api/vendor-issues/:id',
  attachUserFromHeader,
  requireVendorIssueUser,
  requireVendorIssueMaster,
  async (req, res) => {
    try {
      const id = String(req.params.id || '').trim()
      if (!id) {
        return res.status(400).json({ ok: false, error: 'Invalid note ID' })
      }
      const { note } = req.body || {}
      if (
        typeof note !== 'string' ||
        !note.trim() ||
        note.trim().length > 5000
      ) {
        return res.status(400).json({ ok: false, error: 'Invalid note' })
      }

      const { rows: existing } = await db.query(
        `SELECT id FROM ${T('vendor_issues')} WHERE id = $1 LIMIT 1`,
        [id]
      )
      if (!existing.length) {
        return res
          .status(404)
          .json({ ok: false, error: 'Vendor issue not found' })
      }

      await db.query(
        `UPDATE ${T('vendor_issues')}
         SET note = $1, updated_by = $2, updated_at = $3
         WHERE id = $4`,
        [note.trim(), req.user.email, toMysqlDt(new Date()), id]
      )
      res.json({ ok: true, message: 'Vendor issue updated successfully' })
    } catch (error) {
      console.error('updateVendorIssue error:', error)
      res
        .status(500)
        .json({ ok: false, error: 'Failed to update vendor issue' })
    }
  }
)

/* ===================== ✅ NO CHANGE: stagesToStr ===================== */
// Arrays are stored as JSON text.
const stagesToStr = v => (Array.isArray(v) ? JSON.stringify(v) : v || '')

/* ===================== 🔄 CHANGED: POST /api/setTeamMembers ===================== */
// joined_at is only set on insert, never updated (same as before).

app.post('/api/setTeamMembers', async (req, res) => {
  const members = req.body
  if (!Array.isArray(members))
    return res.status(400).json({ ok: false, error: 'expected array' })
  if (members.length === 0) return res.json({ ok: true })

  try {
    const nowDt = toMysqlDt(new Date())
    const byId = new Map()
    members.forEach(m => {
      if (!m || !m.id) return
      byId.set(String(m.id), [
        String(m.id),
        m.name ?? null,
        m.email ?? null,
        m.password || '',
        m.role || 'member',
        stagesToStr(m.stages),
        m.division || null,
        m.managerId || null,
        toMysqlDt(m.joinedAt) || nowDt
      ])
    })
    const rows = [...byId.values()]
    if (rows.length === 0) return res.json({ ok: true })

    await txWithRetry(async client => {
      for (const part of chunk(rows, 500)) {
        await client.query(
          `INSERT INTO ${T('users')}
             (id, name, email, password, role, stages, division, manager_id, joined_at)
           VALUES $1
           ON DUPLICATE KEY UPDATE
             name = VALUES(name), email = VALUES(email),
             password = VALUES(password), role = VALUES(role),
             stages = VALUES(stages), division = VALUES(division),
             manager_id = VALUES(manager_id)`,
          [part]
        )
      }
    })
    res.json({ ok: true })
  } catch (e) {
    console.error('setTeamMembers error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: POST /api/saveUsers ===================== */
// Replace-by-email: users whose email is not in the payload are DELETED.

app.post('/api/saveUsers', async (req, res) => {
  const users = req.body
  if (!Array.isArray(users))
    return res.status(400).json({ ok: false, error: 'expected array' })

  try {
    const byId = new Map()
    users.forEach(u => {
      if (!u || !u.email) return
      const id = String(u.name || u.email)
        .toLowerCase()
        .replace(/\s+/g, '_')
      byId.set(id, [
        id,
        u.name || u.email,
        u.email,
        u.password || '',
        u.role || 'member',
        stagesToStr(u.stages)
      ])
    })
    const rows = [...byId.values()]
    const emails = [...new Set(rows.map(r => String(r[2]).toLowerCase()))]

    await txWithRetry(async client => {
      // `NOT IN ()` is a syntax error in MySQL, so the empty case is handled
      // separately. It deletes everyone, same as the old query did.
      if (emails.length === 0) {
        await client.query(`DELETE FROM ${T('users')}`)
      } else {
        await client.query(
          `DELETE FROM ${T('users')} WHERE LOWER(email) NOT IN ($1)`,
          [emails]
        )
      }

      for (const part of chunk(rows, 500)) {
        await client.query(
          `INSERT INTO ${T('users')}
             (id, name, email, password, role, stages)
           VALUES $1
           ON DUPLICATE KEY UPDATE
             name = VALUES(name), email = VALUES(email),
             password = VALUES(password), role = VALUES(role),
             stages = VALUES(stages)`,
          [part]
        )
      }
    })
    res.json({ ok: true })
  } catch (e) {
    console.error('saveUsers error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: POST /api/setAssignments ===================== */
// - plain array            -> full sync per division (with safety guards)
// - { mode:"add", ... }    -> insert/update only, never deletes

app.post('/api/setAssignments', async (req, res) => {
  const isAddMode = !Array.isArray(req.body) && req.body?.mode === 'add'
  const assignments = isAddMode ? req.body.assignments : req.body

  if (!Array.isArray(assignments)) {
    return res.status(400).json({
      ok: false,
      error: "expected array (or { mode: 'add', assignments: [...] })"
    })
  }
  if (isAddMode && assignments.length === 0) {
    return res
      .status(400)
      .json({ ok: false, error: 'assignments array is empty' })
  }

  const divisionsInPayload = [...new Set(assignments.map(a => a.division))]

  try {
    // ---- ✅ NO CHANGE: per-division safety guards (skipped in add mode) ----
    if (!isAddMode) {
      const counts = await Promise.all(
        divisionsInPayload.map(div =>
          db.query(
            `SELECT COUNT(*) AS count FROM ${T(
              'assignments'
            )} WHERE division = $1`,
            [div ?? null]
          )
        )
      )

      for (let i = 0; i < divisionsInPayload.length; i++) {
        const div = divisionsInPayload[i]
        const currentCount = Number(counts[i].rows[0].count)
        const incomingCountForDiv = assignments.filter(
          a => a.division === div
        ).length

        if (incomingCountForDiv === 0 && currentCount > 0) {
          return res.status(400).json({
            ok: false,
            error: `Refusing to clear ${currentCount} existing assignments for "${div}" via empty payload.`
          })
        }
        const SHRINK_THRESHOLD = 0.5
        if (
          currentCount > 20 &&
          incomingCountForDiv < currentCount * SHRINK_THRESHOLD
        ) {
          return res.status(400).json({
            ok: false,
            error: `Payload has ${incomingCountForDiv} rows for "${div}" but ${currentCount} currently exist — looks like a stale/partial payload.`,
            division: div,
            currentCount,
            incomingCount: incomingCountForDiv
          })
        }
      }
    }

    // ---- 🔄 CHANGED: resolve product ids (was IN UNNEST($1)) ----
    const prodMap = {}
    if (assignments.length > 0) {
      const skusLower = [
        ...new Set(assignments.map(a => String(a.sku || '').toLowerCase()))
      ]
      for (const part of chunk(skusLower)) {
        const { rows: prodRows } = await db.query(
          `SELECT id, division, LOWER(sku) AS sku_lower
           FROM ${T('products')}
           WHERE LOWER(sku) IN ($1)`,
          [part]
        )
        prodRows.forEach(r => {
          prodMap[r.division + '||' + r.sku_lower] = String(r.id)
        })
      }
    }

    // ---- 🔄 CHANGED: build rows as arrays (deduplicated by id) ----
    const nowDt = toMysqlDt(new Date())
    const rowsById = new Map()
    const skipped = []

    assignments.forEach(a => {
      const pid = prodMap[a.division + '||' + String(a.sku || '').toLowerCase()]
      if (!pid) {
        skipped.push({ sku: a.sku, division: a.division })
        return
      }
      const id = a.id ? String(a.id) : randomUUID()
      rowsById.set(id, [
        id,
        a.memberId ?? null,
        a.managerId ?? null,
        pid,
        a.sku ?? null,
        a.division ?? null,
        a.stage ?? null,
        toMysqlDt(a.assignedAt) || nowDt
      ])
    })
    const rows = [...rowsById.values()]

    if (isAddMode && rows.length === 0) {
      return res.status(400).json({
        ok: false,
        error: `No matching product found for ${skipped.length} SKU(s) — check division/SKU spelling.`,
        skipped
      })
    }

    // ---- 🔄 CHANGED: upsert, then delete leftovers, in ONE transaction ----
    if (rows.length > 0) {
      const divisionsWithRows = [
        ...new Set(rows.map(r => r[5]).filter(Boolean))
      ]
      const withDelete = !isAddMode && divisionsWithRows.length > 0
      const keepIds = rows.map(r => r[0])

      await txWithRetry(async client => {
        for (const part of chunk(rows, 1000)) {
          await client.query(
            `INSERT INTO ${T('assignments')}
               (id, member_id, manager_id, product_id, sku, division, stage, assigned_at)
             VALUES $1
             ON DUPLICATE KEY UPDATE
               member_id = VALUES(member_id), manager_id = VALUES(manager_id),
               product_id = VALUES(product_id), sku = VALUES(sku),
               division = VALUES(division), stage = VALUES(stage),
               assigned_at = VALUES(assigned_at)`,
            [part]
          )
        }

        // Replaces "WHEN NOT MATCHED BY SOURCE AND t.division IN (...) THEN DELETE":
        // remove rows of the same divisions that are not in the payload.
        if (withDelete) {
          await client.query(
            `DELETE FROM ${T('assignments')}
             WHERE division IN ($1) AND id NOT IN ($2)`,
            [divisionsWithRows, keepIds]
          )
        }
      })
    }

    res.json({ ok: true, upserted: rows.length, skipped })
  } catch (e) {
    console.error('setAssignments error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== ✅ NO CHANGE: POST /api/clearAssignments ===================== */

app.post('/api/clearAssignments', async (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({
      ok: false,
      error: 'Must pass { confirm: true } to clear all assignments.'
    })
  }
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS count FROM ${T('assignments')}`
    )
    await db.query(`DELETE FROM ${T('assignments')} WHERE TRUE`)
    res.json({ ok: true, deleted: Number(rows[0].count) })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: POST /api/appendAudit ===================== */

app.post('/api/appendAudit', async (req, res) => {
  const e = req.body
  try {
    await db.query(
      `INSERT INTO ${T('audit_log')}
         (id, logged_at, actor_name, action, entity, detail, division)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        e.id ? String(e.id) : randomUUID(),
        toMysqlDt(e.at) || toMysqlDt(new Date()),
        e.actor || 'Unattributed',
        e.action ?? null,
        e.entity ?? null,
        e.detail || '',
        e.division || null
      ]
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('appendAudit error', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

/* ===================== 🔄 CHANGED: GET /api/memberStats ===================== */
// COUNTIF(x)    -> SUM(CASE WHEN x THEN 1 ELSE 0 END)
// LOGICAL_OR(x) -> MAX(CASE WHEN x THEN 1 ELSE 0 END)

app.get('/api/memberStats', async (req, res) => {
  const { memberId, division } = req.query
  if (!memberId || !division)
    return res
      .status(400)
      .json({ ok: false, error: 'memberId and division required' })
  try {
    const { rows } = await db.query(
      `
      WITH member_skus AS (
        SELECT DISTINCT sku
        FROM ${T('assignments')}
        WHERE member_id = $1 AND division = $2
      ),
      pushed_skus AS (
        SELECT DISTINCT sku
        FROM ${T('assignments')}
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
        FROM ${T('assignments')} a
        JOIN ${T('products')} p ON p.sku = a.sku AND p.division = a.division
        WHERE a.member_id = $1 AND a.division = $2
      ),
      card_level AS (
        SELECT
          ta.product_id,
          COUNT(*) AS stages_owned,
          SUM(CASE WHEN se.status = 'Completed' THEN 1 ELSE 0 END) AS stages_completed,
          MAX(CASE
                WHEN COALESCE(se.status, 'Not Started') = 'Issue'
                  OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
                THEN 1 ELSE 0
              END) AS has_open_issue
        FROM target_assignments ta
        LEFT JOIN ${T('stage_entries')} se
          ON se.product_id = ta.product_id
          AND se.stage_key = ta.assigned_stage
        GROUP BY ta.product_id
      )
      SELECT
        (SELECT COUNT(*) FROM member_skus) AS total_assigned,
        (SELECT COUNT(*) FROM pushed_skus) AS pushed_to_team,
        (SELECT COUNT(*) FROM kept_skus)   AS kept_by_manager,
        (SELECT COUNT(*) FROM card_level WHERE stages_completed = stages_owned AND has_open_issue = 0) AS completed,
        (SELECT COUNT(*) FROM card_level WHERE stages_completed < stages_owned AND has_open_issue = 0) AS pending,
        (SELECT COUNT(*) FROM card_level WHERE has_open_issue = 1) AS issues
    `,
      [String(memberId), String(division)]
    )

    const r = rows[0] || {}
    res.json({
      ok: true,
      total_assigned: Number(r.total_assigned || 0),
      pushed_to_team: Number(r.pushed_to_team || 0),
      kept_by_manager: Number(r.kept_by_manager || 0),
      completed: Number(r.completed || 0),
      pending: Number(r.pending || 0),
      issues: Number(r.issues || 0)
    })
  } catch (e) {
    console.error('memberStats error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: GET /api/allMemberStats ===================== */

app.get('/api/allMemberStats', async (req, res) => {
  const { division } = req.query
  if (!division)
    return res.status(400).json({ ok: false, error: 'division required' })
  try {
    const { rows } = await db.query(
      `
      WITH target_assignments AS (
        SELECT DISTINCT a.member_id, p.id AS product_id, a.stage AS assigned_stage
        FROM ${T('assignments')} a
        JOIN ${T('products')} p ON p.sku = a.sku AND p.division = a.division
        WHERE a.division = $1
      ),
      card_level AS (
        SELECT
          ta.member_id,
          ta.product_id,
          COUNT(*) AS stages_owned,
          SUM(CASE WHEN se.status = 'Completed' THEN 1 ELSE 0 END) AS stages_completed,
          MAX(CASE
                WHEN se.status = 'Issue'
                  OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
                THEN 1 ELSE 0
              END) AS has_open_issue
        FROM target_assignments ta
        JOIN ${T('stage_entries')} se
          ON se.product_id = ta.product_id
          AND se.stage_key = ta.assigned_stage
        GROUP BY ta.member_id, ta.product_id
      )
      SELECT
        u.id AS member_id,
        u.name AS member_name,
        COUNT(cl.product_id) AS total_assigned,
        SUM(CASE WHEN cl.stages_completed = cl.stages_owned AND cl.has_open_issue = 0 THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN cl.stages_completed < cl.stages_owned AND cl.has_open_issue = 0 THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN cl.has_open_issue = 1 THEN 1 ELSE 0 END) AS issues
      FROM card_level cl
      JOIN ${T('users')} u ON u.id = cl.member_id
      GROUP BY u.id, u.name
      ORDER BY u.name
    `,
      [String(division)]
    )

    res.json({
      ok: true,
      members: rows.map(r => ({
        memberId: r.member_id,
        memberName: r.member_name,
        total: Number(r.total_assigned),
        completed: Number(r.completed),
        pending: Number(r.pending),
        issues: Number(r.issues)
      }))
    })
  } catch (e) {
    console.error('allMemberStats error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: GET /api/pipelineStats ===================== */

app.get('/api/pipelineStats', async (req, res) => {
  const { memberId, division } = req.query
  if (!memberId || !division)
    return res
      .status(400)
      .json({ ok: false, error: 'memberId and division required' })
  try {
    const { rows } = await db.query(
      `
      WITH member_skus AS (
        SELECT DISTINCT p.id AS product_id, a.stage AS assigned_stage
        FROM ${T('assignments')} a
        JOIN ${T('products')} p ON p.sku = a.sku AND p.division = a.division
        WHERE a.member_id = $1
          AND a.division = $2
      )
      SELECT
        se.stage_key,
        SUM(CASE WHEN se.status = 'Not Started' THEN 1 ELSE 0 END) AS not_started,
        SUM(CASE WHEN se.status = 'In Progress'
                  AND se.comments NOT LIKE 'QC flagged:%' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN se.status = 'Completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN se.status = 'Issue'
                  OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
                 THEN 1 ELSE 0 END) AS issue
      FROM member_skus ms
      JOIN ${T('stage_entries')} se
        ON se.product_id = ms.product_id
       AND se.stage_key = ms.assigned_stage
      GROUP BY se.stage_key
    `,
      [String(memberId), String(division)]
    )

    const stages = {}
    rows.forEach(r => {
      stages[r.stage_key] = {
        notStarted: Number(r.not_started),
        inProgress: Number(r.in_progress),
        completed: Number(r.completed),
        issue: Number(r.issue)
      }
    })

    res.json({ ok: true, stages })
  } catch (e) {
    console.error('pipelineStats error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== ❌ DELETE this old block ===================== */
// const toDate = v => { ... new Date(v.value ?? v) ... }
// The toDate from my earlier message already does this and also handles
// MySQL date strings. Keeping both would crash with
// "Identifier 'toDate' has already been declared".

/* ===================== 🔄 CHANGED: export helpers ===================== */
// COUNTIF           -> SUM(CASE WHEN ... )
// IS DISTINCT FROM  -> NOT (a <=> b)    (<=> is MySQL's NULL-safe equals)
// { p3: 'INT64' }   -> removed

async function getExportRowsForDivision (client, division, scope) {
  const { rows } = await client.query(
    `
    WITH stage_counts AS (
      SELECT
        p.id AS product_id,
        SUM(CASE WHEN se.status = 'Completed' THEN 1 ELSE 0 END) AS completed_stages,
        SUM(CASE WHEN se.status = 'Issue' THEN 1 ELSE 0 END) AS issue_stages,
        MIN(CASE WHEN NOT (se.status <=> 'Completed') THEN se.stage_key END) AS next_pending_stage
      FROM ${T('products')} p
      LEFT JOIN ${T('stage_entries')} se
        ON se.product_id = p.id AND se.stage_key != 'finalqc'
      WHERE p.division = $1
      GROUP BY p.id
    )
    SELECT p.sku, p.name, p.vendor, p.division, p.qty, p.verdict, p.updated_at,
           sc.completed_stages, sc.issue_stages, sc.next_pending_stage
    FROM ${T('products')} p
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
    [String(division), String(scope), PIPELINE_STAGE_COUNT]
  )
  return rows.map(r => ({
    ...r,
    updated_at: toDate(r.updated_at),
    completed_stages: Number(r.completed_stages),
    issue_stages: Number(r.issue_stages)
  }))
}

async function getExportRowsForMember (client, division, memberId, scope) {
  const { rows } = await client.query(
    `
    WITH my_assignments AS (
      SELECT DISTINCT a.sku, a.stage
      FROM ${T('assignments')} a
      WHERE a.member_id = $1 AND a.division = $2
    ),
    card_level AS (
      SELECT
        p.id AS product_id,
        p.sku, p.name, p.vendor, p.division, p.qty, p.verdict, p.updated_at,
        COUNT(*) AS stages_owned,
        SUM(CASE WHEN se.status = 'Completed' THEN 1 ELSE 0 END) AS stages_completed,
        SUM(CASE WHEN se.status = 'Issue' THEN 1 ELSE 0 END) AS stages_issue,
        MIN(CASE WHEN NOT (se.status <=> 'Completed') THEN ma.stage END) AS next_pending_stage
      FROM my_assignments ma
      JOIN ${T('products')} p ON p.sku = ma.sku AND p.division = $2
      LEFT JOIN ${T('stage_entries')} se
        ON se.product_id = p.id AND se.stage_key = ma.stage
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
    [String(memberId), String(division), String(scope)]
  )
  return rows.map(r => ({
    ...r,
    updated_at: toDate(r.updated_at),
    stages_owned: Number(r.stages_owned),
    stages_completed: Number(r.stages_completed),
    stages_issue: Number(r.stages_issue)
  }))
}

/* ===================== ✅ NO CHANGE: normStatusServer ===================== */

function normStatusServer (v) {
  if (!v) return null
  const m = {
    'not started': 'Not Started',
    'in progress': 'In Progress',
    wip: 'In Progress',
    pending: 'In Progress',
    completed: 'Completed',
    complete: 'Completed',
    done: 'Completed',
    approved: 'Completed',
    issue: 'Issue',
    issues: 'Issue'
  }
  return m[String(v).trim().toLowerCase()] || null
}

/* ===================== 🆕 NEW helpers for bulkImportProducts ===================== */

// Replaces SAFE_CAST(SUBSTR(x,1,10) AS DATE): returns "YYYY-MM-DD" or null
const safeDate = v => {
  if (!v) return null
  const s = String(v).trim().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const d = new Date(s + 'T00:00:00Z')
  return isNaN(d) || d.toISOString().slice(0, 10) !== s ? null : s
}

// Stage upsert. Rows with a status overwrite it. Rows WITHOUT a status keep
// the existing one (same as COALESCE(s.status, t.status) in the old MERGE),
// and a brand-new row gets 'Not Started'.
const stageUpsertSql = withStatus => `
  INSERT INTO ${T('stage_entries')}
    (product_id, stage_key, status, person, comments, updated_at,
     width_cm, height_cm, weight_gm)
  VALUES $1
  ON DUPLICATE KEY UPDATE
    ${withStatus ? 'status = VALUES(status),' : ''}
    person    = COALESCE(NULLIF(VALUES(person), ''), person),
    comments  = COALESCE(NULLIF(VALUES(comments), ''), comments),
    updated_at = VALUES(updated_at),
    width_cm  = COALESCE(VALUES(width_cm), width_cm),
    height_cm = COALESCE(VALUES(height_cm), height_cm),
    weight_gm = COALESCE(VALUES(weight_gm), weight_gm)`

/* ===================== 🔄 CHANGED: POST /api/bulkImportProducts ===================== */

const IMPORT_CHUNK_SIZE = 200

app.post('/api/bulkImportProducts', async (req, res) => {
  const rows = req.body
  if (!Array.isArray(rows))
    return res.status(400).json({ ok: false, error: 'expected array' })

  const validRows = rows.filter(r => {
    const sku = String(r.sku || '').trim()
    return sku && !sku.toUpperCase().includes('EXAMPLE')
  })

  const results = { total: rows.length, created: 0, updated: 0, failed: [] }
  if (validRows.length === 0) return res.json({ ok: true, ...results })

  try {
    const nowDt = toMysqlDt(new Date())

    // ---- De-duplicate by (division, sku); last row wins ----
    const keyOf = r =>
      (r.division || '') + '||' + String(r.sku).trim().toLowerCase()
    const byKey = new Map()
    validRows.forEach(r => byKey.set(keyOf(r), r))
    const uniqueRows = [...byKey.values()]

    // ---- Look up existing products (🔄 was IN UNNEST($1)) ----
    const divisionsInBatch = [
      ...new Set(uniqueRows.map(r => r.division).filter(Boolean))
    ]
    const existingIdByKey = new Map()
    if (divisionsInBatch.length > 0) {
      const { rows: existing } = await db.query(
        `SELECT id, division, LOWER(sku) AS sku_lower
         FROM ${T('products')}
         WHERE division IN ($1)`,
        [divisionsInBatch]
      )
      existing.forEach(r =>
        existingIdByKey.set(r.division + '||' + r.sku_lower, String(r.id))
      )
    }

    // ---- Cap check (✅ no change) ----
    const currentCount = await getProductCount(db)
    const newRowsCount = uniqueRows.filter(
      r => !existingIdByKey.has(keyOf(r))
    ).length
    if (currentCount + newRowsCount > MAX_PRODUCTS) {
      return res.status(400).json({
        ok: false,
        error: `Import would exceed max product cap (${MAX_PRODUCTS}). Currently ${currentCount}, trying to add ${newRowsCount} new SKUs.`
      })
    }

    // ---- 1. Vendors (🔄 MERGE -> INSERT ... ON DUPLICATE KEY) ----
    const vendorSeen = new Set()
    const vendorRows = []
    uniqueRows.forEach(r => {
      if (r.vendor && String(r.vendor).trim()) {
        const division = r.division || ''
        const vendor_name = String(r.vendor).trim()
        const k = division + '||' + vendor_name
        if (vendorSeen.has(k)) return
        vendorSeen.add(k)
        vendorRows.push([division, vendor_name])
      }
    })
    if (vendorRows.length > 0) {
      await txWithRetry(async client => {
        for (const part of chunk(vendorRows, 1000)) {
          await client.query(
            `INSERT INTO ${T('vendors')} (division, vendor_name)
             VALUES $1
             ON DUPLICATE KEY UPDATE vendor_name = vendor_name`,
            [part]
          )
        }
      })
    }

    // ---- 2. Products + stages + verdicts, chunk by chunk ----
    for (let i = 0; i < uniqueRows.length; i += IMPORT_CHUNK_SIZE) {
      const part = uniqueRows.slice(i, i + IMPORT_CHUNK_SIZE) // 🔄 renamed from `chunk`

      const productRows = []
      const stageRowsWithStatus = []
      const stageRowsNoStatus = []
      const verdictRows = []
      let chunkCreated = 0
      let chunkUpdated = 0

      for (const r of part) {
        const key = keyOf(r)
        let productId = existingIdByKey.get(key)
        if (productId) {
          chunkUpdated++
        } else {
          productId = randomUUID()
          chunkCreated++
        }

        productRows.push([
          productId,
          r.division || null,
          String(r.sku).trim(),
          r.name || '',
          r.vendor ? String(r.vendor).trim() : null,
          safeDate(r.inward),
          Number(r.qty) || 0,
          r.note || '',
          r.set_no || null,
          nowDt, // created_at (not touched on existing rows)
          nowDt // updated_at
        ])

        // One row per stage (except finalqc), even when blank
        for (const s of STAGE_KEYS) {
          if (s === 'finalqc') continue
          const isDim = s === 'dimensions'
          const status = normStatusServer(r[s + '_status'])
          const row = [
            productId,
            s,
            status || 'Not Started',
            r[s + '_person'] || '',
            r[s + '_comments'] || '',
            nowDt,
            isDim && r.dimensions_width
              ? Number(r.dimensions_width) || null
              : null,
            isDim && r.dimensions_height
              ? Number(r.dimensions_height) || null
              : null,
            isDim && r.dimensions_weight
              ? Number(r.dimensions_weight) || null
              : null
          ]
          if (status) stageRowsWithStatus.push(row)
          else stageRowsNoStatus.push(row)
        }

        if (r.qc_verdict) {
          const v = /appro/i.test(r.qc_verdict)
            ? 'Approved'
            : /issue/i.test(r.qc_verdict)
            ? 'Issues Found'
            : null
          if (v) verdictRows.push([productId, v, r.qc_issues || ''])
        }
      }

      // One transaction per chunk: all-or-nothing (same as before)
      await txWithRetry(async client => {
        await client.query(
          `INSERT INTO ${T('products')}
             (id, division, sku, name, vendor, inward, qty, note, set_no,
              created_at, updated_at)
           VALUES $1
           ON DUPLICATE KEY UPDATE
             name   = COALESCE(NULLIF(VALUES(name), ''), name),
             vendor = COALESCE(VALUES(vendor), vendor),
             inward = COALESCE(VALUES(inward), inward),
             qty    = IF(VALUES(qty) > 0, VALUES(qty), qty),
             note   = COALESCE(NULLIF(VALUES(note), ''), note),
             set_no = COALESCE(NULLIF(VALUES(set_no), ''), set_no),
             updated_at = VALUES(updated_at)`,
          [productRows]
        )

        if (stageRowsWithStatus.length) {
          await client.query(stageUpsertSql(true), [stageRowsWithStatus])
        }
        if (stageRowsNoStatus.length) {
          await client.query(stageUpsertSql(false), [stageRowsNoStatus])
        }

        // 🔄 was UPDATE ... FROM (subquery). MySQL has no UPDATE ... FROM,
        // so each verdict is a small UPDATE inside the same transaction.
        for (const [id, verdict, issues] of verdictRows) {
          await client.query(
            `UPDATE ${T('products')}
             SET verdict = $1, issues = $2, updated_at = $3
             WHERE id = $4`,
            [verdict, issues, nowDt, id]
          )
        }
      })

      // Only count a chunk once it has been committed
      results.created += chunkCreated
      results.updated += chunkUpdated
    }

    res.json({ ok: true, ...results })
  } catch (e) {
    console.error('bulkImportProducts error', e)
    res.status(500).json({ ok: false, error: e.message, ...results })
  }
})

/* ===================== ✅ NO CHANGE: GET /api/exportProducts ===================== */

app.get('/api/exportProducts', async (req, res) => {
  const { division, scope, memberId } = req.query
  if (!division)
    return res.status(400).json({ ok: false, error: 'division required' })
  if (!['pending', 'completed', 'issues', 'all'].includes(scope)) {
    return res.status(400).json({ ok: false, error: 'invalid scope' })
  }
  try {
    const rows = memberId
      ? await getExportRowsForMember(db, division, memberId, scope)
      : await getExportRowsForDivision(db, division, scope)

    res.json({ ok: true, scope, count: rows.length, rows })
  } catch (e) {
    console.error('exportProducts error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== ✅ NO CHANGE: GET /api/stageIssueStats ===================== */

app.get('/api/stageIssueStats', async (req, res) => {
  const { division } = req.query
  if (!division)
    return res.status(400).json({ ok: false, error: 'division required' })
  try {
    const { rows } = await db.query(
      `
      SELECT se.stage_key, COUNT(*) AS issue_count
      FROM ${T('stage_entries')} se
      JOIN ${T('products')} p ON p.id = se.product_id
      WHERE p.division = $1
        AND (
          se.status = 'Issue'
          OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
        )
      GROUP BY se.stage_key
    `,
      [String(division)]
    )

    const stages = {}
    rows.forEach(r => {
      stages[r.stage_key] = Number(r.issue_count)
    })
    res.json({ ok: true, stages })
  } catch (e) {
    console.error('stageIssueStats error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: GET /api/pipelineBreakdown ===================== */
// COUNTIF(x) -> SUM(CASE WHEN x THEN 1 ELSE 0 END)
// The `($3 IS NULL OR p.vendor = $3)` filters work in MySQL as they are.

app.get('/api/pipelineBreakdown', async (req, res) => {
  const { division, memberId, vendor, setNo } = req.query
  if (!division)
    return res.status(400).json({ ok: false, error: 'division required' })

  try {
    let rows
    if (memberId) {
      const { rows: r } = await db.query(
        `
        WITH member_scope AS (
          SELECT DISTINCT p.id AS product_id, a.stage AS stage_key, p.vendor AS vendor
          FROM ${T('assignments')} a
          JOIN ${T('products')} p
            ON p.sku = a.sku AND p.division = a.division
          WHERE a.member_id = $1
            AND a.division = $2
            AND ($3 IS NULL OR p.vendor = $3)
            AND ($4 IS NULL OR p.set_no = $4)
        )
        SELECT
          ms.stage_key,
          ms.vendor,
          SUM(CASE WHEN COALESCE(se.status, 'Not Started') = 'Not Started' THEN 1 ELSE 0 END) AS not_started,
          SUM(CASE WHEN se.status = 'In Progress'
                    AND COALESCE(se.comments, '') NOT LIKE 'QC flagged:%' THEN 1 ELSE 0 END) AS in_progress,
          SUM(CASE WHEN se.status = 'Completed' THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN se.status = 'Issue'
                    OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
                   THEN 1 ELSE 0 END) AS issue
        FROM member_scope ms
        LEFT JOIN ${T('stage_entries')} se
          ON se.product_id = ms.product_id AND se.stage_key = ms.stage_key
        GROUP BY ms.stage_key, ms.vendor
        ORDER BY ms.vendor, ms.stage_key
      `,
        [
          String(memberId),
          String(division),
          vendor ? String(vendor) : null,
          setNo ? String(setNo) : null
        ]
      )
      rows = r
    } else {
      const { rows: r } = await db.query(
        `
        SELECT
          se.stage_key,
          p.vendor AS vendor,
          SUM(CASE WHEN se.status = 'Not Started' THEN 1 ELSE 0 END) AS not_started,
          SUM(CASE WHEN se.status = 'In Progress'
                    AND se.comments NOT LIKE 'QC flagged:%' THEN 1 ELSE 0 END) AS in_progress,
          SUM(CASE WHEN se.status = 'Completed' THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN se.status = 'Issue'
                    OR (se.status = 'In Progress' AND se.comments LIKE 'QC flagged:%')
                   THEN 1 ELSE 0 END) AS issue
        FROM ${T('stage_entries')} se
        JOIN ${T('products')} p ON p.id = se.product_id
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
          setNo ? String(setNo) : null
        ]
      )
      rows = r
    }

    // `stages`   - aggregated across all vendors (backward compatible)
    // `byVendor` - { vendorName: { stageKey: {...} } }
    const stages = {}
    const byVendor = {}

    rows.forEach(r => {
      const vendorKey = r.vendor || '—'
      const cell = {
        notStarted: Number(r.not_started),
        inProgress: Number(r.in_progress),
        completed: Number(r.completed),
        issue: Number(r.issue)
      }

      if (!stages[r.stage_key]) {
        stages[r.stage_key] = {
          notStarted: 0,
          inProgress: 0,
          completed: 0,
          issue: 0
        }
      }
      stages[r.stage_key].notStarted += cell.notStarted
      stages[r.stage_key].inProgress += cell.inProgress
      stages[r.stage_key].completed += cell.completed
      stages[r.stage_key].issue += cell.issue

      if (!byVendor[vendorKey]) byVendor[vendorKey] = {}
      byVendor[vendorKey][r.stage_key] = cell
    })

    res.json({ ok: true, stages, byVendor })
  } catch (e) {
    console.error('pipelineBreakdown error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== ✅ NO CHANGE: GET /api/stageSpeedStats ===================== */
// Uses the shared toDate() helper, which already handles MySQL date strings.

app.get('/api/stageSpeedStats', async (req, res) => {
  const { division } = req.query
  if (!division)
    return res.status(400).json({ ok: false, error: 'division required' })
  try {
    const { rows } = await db.query(
      `SELECT entity, detail, logged_at FROM ${T('audit_log')}
       WHERE action = 'Stage update' AND division = $1
       ORDER BY entity, logged_at ASC`,
      [String(division)]
    )

    // entity+stage -> { firstInProgress, firstCompleted }
    const track = {}
    rows.forEach(r => {
      const m = String(r.detail || '').match(/^(.+?)\s*→\s*([^·]+?)(?:\s*·|$)/)
      if (!m) return
      const stageName = m[1].trim()
      const status = m[2].trim()
      const key = r.entity + '||' + stageName
      const at = toDate(r.logged_at)
      if (!track[key])
        track[key] = { stageName, firstInProgress: null, firstCompleted: null }
      const t = track[key]
      if (status === 'In Progress' && !t.firstInProgress) t.firstInProgress = at
      if (status === 'Completed' && !t.firstCompleted && t.firstInProgress)
        t.firstCompleted = at
    })

    const byStage = {}
    Object.values(track).forEach(t => {
      if (!t.firstInProgress || !t.firstCompleted) return
      const hours = (t.firstCompleted - t.firstInProgress) / 3600000
      if (hours < 0 || hours > 24 * 60) return // discard bad/outlier data
      ;(byStage[t.stageName] ||= []).push(hours)
    })

    const stats = Object.entries(byStage)
      .map(([stageName, durations]) => ({
        stageName,
        avgHours: durations.reduce((a, b) => a + b, 0) / durations.length,
        sampleCount: durations.length
      }))
      .sort((a, b) => a.avgHours - b.avgHours)

    res.json({ ok: true, stats })
  } catch (e) {
    console.error('stageSpeedStats error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== ✅ NO CHANGE: GET /api/memberSpeedStats ===================== */

app.get('/api/memberSpeedStats', async (req, res) => {
  const { division } = req.query
  if (!division)
    return res.status(400).json({ ok: false, error: 'division required' })
  try {
    const { rows } = await db.query(
      `SELECT entity, detail, logged_at, actor_name FROM ${T('audit_log')}
       WHERE action = 'Stage update' AND division = $1
       ORDER BY entity, logged_at ASC`,
      [String(division)]
    )

    const lastInProgress = {} // "sku||stageName" -> Date
    const byMember = {} // person name -> accumulator

    const touch = name =>
      (byMember[name] ||= {
        durations: [],
        completions: 0,
        issues: 0,
        byStage: {}
      })

    rows.forEach(r => {
      const m = String(r.detail || '').match(
        /^(.+?)\s*→\s*([^·]+?)(?:\s*·\s*(.+))?$/
      )
      if (!m) return
      const stageName = m[1].trim()
      const status = m[2].trim()
      const person = (m[3] || '').trim() || (r.actor_name || '').trim()
      const key = r.entity + '||' + stageName
      const at = toDate(r.logged_at)

      if (status === 'In Progress') {
        lastInProgress[key] = at
      } else if (status === 'Completed') {
        const startedAt = lastInProgress[key]
        if (startedAt && at && person) {
          const hours = (at - startedAt) / 3600000
          // discard bad/stalled outliers (>60 days)
          if (hours > 0 && hours < 24 * 60) {
            const acc = touch(person)
            acc.durations.push(hours)
            acc.completions++
            ;(acc.byStage[stageName] ||= []).push(hours)
          }
        }
        delete lastInProgress[key]
      } else if (status === 'Issue' && person) {
        touch(person).issues++
      }
    })

    const members = Object.entries(byMember)
      .map(([name, m]) => {
        const avgHours = m.durations.length
          ? m.durations.reduce((a, b) => a + b, 0) / m.durations.length
          : null
        const stageBreakdown = Object.entries(m.byStage)
          .map(([stageName, arr]) => ({
            stageName,
            avgHours: arr.reduce((a, b) => a + b, 0) / arr.length,
            count: arr.length
          }))
          .sort((a, b) => a.avgHours - b.avgHours)
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
          stageBreakdown
        }
      })
      .filter(x => x.completions > 0)
      .sort((a, b) => a.avgHours - b.avgHours) // fastest first

    res.json({ ok: true, members })
  } catch (e) {
    console.error('memberSpeedStats error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== ✅ NO CHANGE: team stage key lists ===================== */

const TEAM_BACKEND_STAGE_KEYS = [
  'content',
  'dimensions',
  'images',
  'backend',
  'website'
]
const TEAM_PHOTO_STAGE_KEYS = [
  'photography',
  'photoedit',
  'videography',
  'videoedit'
]

/* ===================== 🔄 CHANGED: GET /api/teamStageStats ===================== */
// a.stage IN UNNEST($2)   -> a.stage IN ($2)
// TIMESTAMP($n)           -> value converted in JS with toMysqlDt()
// Everything from `buildGroup` down is unchanged.

app.get('/api/teamStageStats', async (req, res) => {
  const { division, vendor, set_no, dateFrom, dateTo } = req.query
  if (!division)
    return res.status(400).json({ ok: false, error: 'division required' })

  try {
    const allStageKeys = [...TEAM_BACKEND_STAGE_KEYS, ...TEAM_PHOTO_STAGE_KEYS]

    const { rows: userRows } = await db.query(
      `SELECT id, manager_id FROM ${T('users')}`
    )
    const managerIdOf = {}
    userRows.forEach(u => {
      managerIdOf[u.id] = u.manager_id
    })

    const conditions = ['a.division = $1', 'a.stage IN ($2)'] // 🔄 CHANGED
    const params = [String(division), allStageKeys]

    if (vendor) {
      params.push(String(vendor))
      conditions.push(`p.vendor = $${params.length}`)
    }
    if (set_no) {
      params.push(String(set_no))
      conditions.push(`p.set_no = $${params.length}`)
    }
    // 🔄 CHANGED: dates are converted in JS. An unparsable date is ignored
    // instead of silently matching nothing.
    const fromDt = dateFrom ? toMysqlDt(String(dateFrom)) : null
    if (fromDt) {
      params.push(fromDt)
      conditions.push(`a.assigned_at >= $${params.length}`)
    }
    const toDt = dateTo ? toMysqlDt(dateTo + ' 23:59:59') : null
    if (toDt) {
      params.push(toDt)
      conditions.push(`a.assigned_at <= $${params.length}`)
    }
    // NOTE: status is intentionally NOT added to `conditions` — it must not
    // shrink the row set, or Total Assigned would change with it.

    const { rows } = await db.query(
      `SELECT a.member_id, u.name AS member_name, a.stage, a.sku, se.status AS stage_status
       FROM ${T('assignments')} a
       JOIN ${T('users')} u ON u.id = a.member_id
       JOIN ${T('products')} p ON p.id = a.product_id
       LEFT JOIN ${T('stage_entries')} se
         ON se.product_id = a.product_id AND se.stage_key = a.stage
       WHERE ${conditions.join(' AND ')}`,
      params
    )

    const buildGroup = stageKeys => {
      const byMember = {}
      rows.forEach(r => {
        if (!stageKeys.includes(r.stage)) return
        const acc = (byMember[r.member_id] ||= {
          memberName: r.member_name,
          skus: new Set(),
          skuStage: {}
        })

        acc.skus.add(r.sku)
        ;(acc.skuStage[r.sku] ||= {})[r.stage] = r.stage_status
      })

      // Subtract reports' skus from their manager's set — same as totalAssigned.
      Object.keys(byMember).forEach(managerId => {
        const reportIds = Object.keys(byMember).filter(
          id => managerIdOf[id] === managerId
        )
        if (reportIds.length === 0) return
        const managerSkus = byMember[managerId].skus
        reportIds.forEach(repId => {
          byMember[repId].skus.forEach(sku => managerSkus.delete(sku))
        })
      })

      return Object.entries(byMember)
        .map(([memberId, m]) => {
          const perStage = stageKeys.reduce(
            (o, k) => ({ ...o, [k]: { completed: 0, pending: 0, issue: 0 } }),
            {}
          )
          m.skus.forEach(sku => {
            const stagesForSku = m.skuStage[sku] || {}
            stageKeys.forEach(stageKey => {
              if (!(stageKey in stagesForSku)) return
              const status = stagesForSku[stageKey]
              if (status === 'Completed') perStage[stageKey].completed++
              else if (status === 'Issue') perStage[stageKey].issue++
              else perStage[stageKey].pending++
            })
          })

          // Never assigned that stage -> null so the frontend shows "—"
          stageKeys.forEach(k => {
            const s = perStage[k]
            if (s.completed + s.pending + s.issue === 0) perStage[k] = null
          })

          return {
            memberId,
            memberName: m.memberName,
            totalAssigned: m.skus.size,
            perStage
          }
        })
        .sort((a, b) => b.totalAssigned - a.totalAssigned)
    }

    res.json({
      ok: true,
      backendTeam: buildGroup(TEAM_BACKEND_STAGE_KEYS),
      photoTeam: buildGroup(TEAM_PHOTO_STAGE_KEYS)
    })
  } catch (e) {
    console.error('teamStageStats error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: GET /api/memberStageDetail ===================== */
// SAFE_CAST($n AS TIMESTAMP) -> the dates are converted in JS before the query.
// The SQL itself is unchanged: IF(), COUNT(DISTINCT IF(...)) and the CTEs all
// work in MySQL 8.

app.get('/api/memberStageDetail', async (req, res) => {
  const { division, completedFrom, completedTo, vendor } = req.query

  try {
    const fromDt = completedFrom ? toMysqlDt(String(completedFrom)) : null
    const toDt = completedTo ? toMysqlDt(String(completedTo)) : null

    const { rows } = await db.query(
      `
      WITH target_assignments AS (
          SELECT DISTINCT a.member_id, a.manager_id, a.division, a.stage AS assigned_stage,
                 p.id AS product_id, a.sku, a.assigned_at
          FROM ${T('assignments')} a
          JOIN ${T('products')} p ON p.sku = a.sku AND p.division = a.division
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
                    AND ($2 IS NULL OR se.updated_at >= $2)
                    AND ($3 IS NULL OR se.updated_at < $3),
                  se.updated_at, NULL
              )) AS last_completed_at,
              COUNT(DISTINCT e.sku) AS assigned_skus,
              COUNT(DISTINCT IF(
                  se.status = 'Completed'
                    AND ($2 IS NULL OR se.updated_at >= $2)
                    AND ($3 IS NULL OR se.updated_at < $3),
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
          LEFT JOIN ${T('stage_entries')} se
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
      JOIN ${T('users')} u ON u.id = t.member_id
      JOIN per_stage ps ON ps.member_id = t.member_id AND ps.division = t.division
      ORDER BY t.division, u.name, ps.stage
      `,
      [division || null, fromDt, toDt, vendor || null]
    )

    // ---- ✅ NO CHANGE from here down ----
    const flatRows = rows.map(r => ({
      ...r,
      total_assigned_skus: Number(r.total_assigned_skus),
      assigned_skus: Number(r.assigned_skus),
      completed_skus: Number(r.completed_skus),
      in_progress_skus: Number(r.in_progress_skus),
      not_started_skus: Number(r.not_started_skus),
      issue_skus: Number(r.issue_skus),
      last_assigned_at: iso(r.last_assigned_at) || null,
      last_completed_at: iso(r.last_completed_at) || null
    }))

    const byKey = {}
    flatRows.forEach(r => {
      const key = r.member_id + '||' + r.division
      if (!byKey[key]) {
        byKey[key] = {
          memberId: r.member_id,
          memberName: r.member_name,
          division: r.division,
          totalAssignedSkus: r.total_assigned_skus,
          stages: []
        }
      }
      byKey[key].stages.push({
        stage: r.stage,
        assignedAt: r.last_assigned_at,
        completedAt: r.last_completed_at,
        assignedSkus: r.assigned_skus,
        completedSkus: r.completed_skus,
        inProgressSkus: r.in_progress_skus,
        notStartedSkus: r.not_started_skus,
        issueSkus: r.issue_skus
      })
    })

    res.json({
      ok: true,
      rows: flatRows,
      members: Object.values(byKey)
    })
  } catch (e) {
    console.error('memberStageDetail error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: GET /api/memberDailyActivity ===================== */
// ARRAY_AGG(sku ORDER BY ...) does not exist in MySQL. The rows are fetched
// in order and grouped in JS, so the response shape stays the same.

app.get('/api/memberDailyActivity', async (req, res) => {
  const { person, division, from, to } = req.query
  if (!person)
    return res.status(400).json({ ok: false, error: 'person required' })
  try {
    const fromDt = from ? toMysqlDt(String(from)) : null
    const toDt = to ? toMysqlDt(String(to)) : null

    const { rows } = await db.query(
      `SELECT
         DATE(se.updated_at) AS work_date,
         se.stage_key,
         p.sku
       FROM ${T('stage_entries')} se
       JOIN ${T('products')} p ON p.id = se.product_id
       WHERE LOWER(se.person) LIKE LOWER($1)
         AND se.status = 'Completed'
         AND ($2 IS NULL OR p.division = $2)
         AND ($3 IS NULL OR se.updated_at >= $3)
         AND ($4 IS NULL OR se.updated_at < $4)
       ORDER BY DATE(se.updated_at), se.stage_key, se.updated_at`,
      [String(person), division ? String(division) : null, fromDt, toDt]
    )

    const groups = new Map()
    rows.forEach(r => {
      const date = dateOnly(r.work_date)
      const key = date + '||' + r.stage_key
      if (!groups.has(key)) {
        groups.set(key, { date, stage: r.stage_key, completed: 0, skus: [] })
      }
      const g = groups.get(key)
      g.completed++
      g.skus.push(r.sku)
    })

    res.json({ ok: true, rows: [...groups.values()] })
  } catch (e) {
    console.error('memberDailyActivity error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: GET /api/teamStageActivity ===================== */

app.get('/api/teamStageActivity', async (req, res) => {
  const { division, from, to } = req.query
  if (!division)
    return res.status(400).json({ ok: false, error: 'division required' })
  try {
    const params = [
      String(division),
      from ? toMysqlDt(String(from)) : null,
      to ? toMysqlDt(String(to)) : null
    ]

    const [{ rows }, { rows: totalsRows }] = await Promise.all([
      db.query(
        `SELECT
           se.person AS member_name,
           se.stage_key,
           COUNT(*) AS completed_count
         FROM ${T('stage_entries')} se
         JOIN ${T('products')} p ON p.id = se.product_id
         WHERE p.division = $1
           AND se.status = 'Completed'
           AND se.person IS NOT NULL AND se.person != ''
           AND ($2 IS NULL OR se.updated_at >= $2)
           AND ($3 IS NULL OR se.updated_at < $3)
         GROUP BY se.person, se.stage_key
         ORDER BY se.person, se.stage_key`,
        params
      ),
      db.query(
        `SELECT se.person AS member_name, COUNT(DISTINCT p.id) AS total_cards
         FROM ${T('stage_entries')} se
         JOIN ${T('products')} p ON p.id = se.product_id
         WHERE p.division = $1
           AND se.status = 'Completed'
           AND se.person IS NOT NULL AND se.person != ''
           AND ($2 IS NULL OR se.updated_at >= $2)
           AND ($3 IS NULL OR se.updated_at < $3)
         GROUP BY se.person`,
        params
      )
    ])

    // ---- ✅ NO CHANGE from here down ----
    const totalsByPerson = {}
    totalsRows.forEach(r => {
      totalsByPerson[r.member_name] = Number(r.total_cards)
    })

    const byMember = {}
    rows.forEach(r => {
      if (!byMember[r.member_name]) {
        byMember[r.member_name] = {
          memberName: r.member_name,
          totalCards: totalsByPerson[r.member_name] || 0,
          stages: []
        }
      }
      byMember[r.member_name].stages.push({
        stage: r.stage_key,
        completedSkus: Number(r.completed_count),
        inProgressSkus: 0,
        notStartedSkus: 0,
        issueSkus: 0
      })
    })

    res.json({ ok: true, members: Object.values(byMember) })
  } catch (e) {
    console.error('teamStageActivity error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== ✅ NO CHANGE: GET /api/store-list ===================== */
// Plain SQL that works in MySQL. See the notes about the string_field_0 column.

app.get('/api/store-list', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT TRIM(string_field_0) AS store_name
       FROM ${T('store_list')}
       WHERE string_field_0 IS NOT NULL
         AND TRIM(string_field_0) != ''
         AND LOWER(TRIM(string_field_0)) NOT IN ('store_name', 'store', 'name', 'branch_name')
       ORDER BY store_name`
    )
    res.json({ ok: true, stores: rows.map(r => r.store_name) })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== ✅ NO CHANGE: dispatchValidate ===================== */

async function dispatchValidate (division, vendor, branchName) {
  const [{ rows: vcheck }, { rows: scheck }] = await Promise.all([
    db.query(
      `SELECT 1 FROM ${T('vendors')} WHERE division = $1 AND vendor_name = $2`,
      [String(division), String(vendor)]
    ),
    db.query(
      `SELECT 1 FROM ${T(
        'store_list'
      )} WHERE TRIM(string_field_0) = $1 LIMIT 1`,
      [String(branchName).trim()]
    )
  ])
  if (vcheck.length === 0)
    return `Vendor "${vendor}" not found for ${division}.`
  if (scheck.length === 0) return `Unknown branch "${branchName}".`
  return null
}

/* ===================== 🆕 NEW helper for admin-upload ===================== */
// Replaces ABS(FARM_FINGERPRINT(CONCAT(batch_id, '|', sku))).
// Gives the same kind of stable BIGINT id for a (batch, sku) pair.
const itemId = (batchId, sku) =>
  BigInt(
    '0x' +
      createHash('md5').update(`${batchId}|${sku}`).digest('hex').slice(0, 15)
  ).toString()

/* ===================== 🔄 CHANGED: POST /api/dispatch/admin-upload ===================== */

app.post('/api/dispatch/admin-upload', async (req, res) => {
  const {
    division,
    vendor,
    batchLabel,
    setLabel,
    branchName,
    uploadedBy,
    filename,
    skus
  } = req.body
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
        'division, vendor, batchLabel, setLabel, branchName and skus[] required'
    })
  }
  try {
    const problem = await dispatchValidate(division, vendor, branchName)
    if (problem) return res.status(400).json({ ok: false, error: problem })

    const { rows: existing } = await db.query(
      `SELECT id FROM ${T('dispatch_batches')}
       WHERE division = $1 AND vendor = $2 AND batch_label = $3
         AND set_label = $4 AND branch_name = $5 AND source = 'dispatched'
       LIMIT 1`,
      [
        String(division),
        String(vendor),
        String(batchLabel),
        String(setLabel),
        String(branchName)
      ]
    )
    const isNew = existing.length === 0
    const batchId = isNew ? randomUUID() : String(existing[0].id)

    const counts = {}
    skus.forEach(s => {
      const k = String(s.sku || s).trim()
      if (k) counts[k] = (counts[k] || 0) + (Number(s.qty) || 1)
    })

    const nowDt = toMysqlDt(new Date())

    // [id, batch_id, sku, qty, scan_count, first_scanned_at, last_scanned_at]
    const itemRows = Object.keys(counts).map(sku => [
      itemId(batchId, sku),
      batchId,
      sku,
      counts[sku],
      counts[sku],
      nowDt,
      nowDt
    ])

    await txWithRetry(async client => {
      if (isNew) {
        await client.query(
          `INSERT INTO ${T('dispatch_batches')}
             (id, division, vendor, batch_label, set_label, branch_name,
              source, uploaded_by, source_filename, uploaded_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'dispatched', $7, $8, $9, $9)`,
          [
            batchId,
            String(division),
            String(vendor),
            String(batchLabel),
            String(setLabel),
            String(branchName),
            uploadedBy || 'Unattributed',
            filename || null,
            nowDt
          ]
        )
      } else {
        await client.query(
          `UPDATE ${T('dispatch_batches')}
           SET uploaded_by = $1, source_filename = $2, updated_at = $3
           WHERE id = $4`,
          [uploadedBy || 'Unattributed', filename || null, nowDt, batchId]
        )
      }

      // scan_count is ADDED to on duplicates, like the old MERGE
      for (const part of chunk(itemRows, 1000)) {
        await client.query(
          `INSERT INTO ${T('dispatch_batch_items')}
             (id, batch_id, sku, qty, scan_count, first_scanned_at, last_scanned_at)
           VALUES $1
           ON DUPLICATE KEY UPDATE
             scan_count = scan_count + VALUES(scan_count),
             last_scanned_at = VALUES(last_scanned_at)`,
          [part]
        )
      }
    })

    res.json({ ok: true, batchId, skuCount: itemRows.length })
  } catch (e) {
    console.error('admin-upload error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: POST /api/dispatch/branch-upload ===================== */

app.post('/api/dispatch/branch-upload', async (req, res) => {
  const {
    division,
    vendor,
    batchLabel,
    branchName,
    uploadedBy,
    filename,
    skus
  } = req.body
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
      error: 'division, vendor, batchLabel, branchName and skus[] required'
    })
  }
  try {
    const problem = await dispatchValidate(division, vendor, branchName)
    if (problem) return res.status(400).json({ ok: false, error: problem })

    const { rows: existing } = await db.query(
      `SELECT id, set_label FROM ${T('dispatch_batches')}
       WHERE division = $1 AND vendor = $2 AND batch_label = $3 AND branch_name = $4
       LIMIT 1`,
      [String(division), String(vendor), String(batchLabel), String(branchName)]
    )

    const isNew = existing.length === 0
    let batchId, setLabel
    if (!isNew) {
      batchId = String(existing[0].id)
      setLabel = existing[0].set_label || null
    } else {
      const { rows: cntRow } = await db.query(
        `SELECT COUNT(*) AS n FROM ${T('dispatch_batches')}
         WHERE division = $1 AND vendor = $2 AND batch_label = $3`,
        [String(division), String(vendor), String(batchLabel)]
      )
      setLabel = `Set ${Number(cntRow[0].n) + 1}`
      batchId = randomUUID() // 🔄 was require('crypto').randomUUID()
    }
    const setNumber = setLabel
      ? Number((setLabel.match(/\d+/) || [])[0]) || null
      : null

    const qtyMap = {}
    skus.forEach(s => {
      const k = String(s.sku || s).trim()
      if (k) qtyMap[k] = Number(s.qty) || 1
    })

    const nowDt = toMysqlDt(new Date())

    // [id, batch_id, sku, qty, scan_count, first_scanned_at, last_scanned_at]
    const itemRows = Object.keys(qtyMap).map(sku => [
      itemId(batchId, sku),
      batchId,
      sku,
      qtyMap[sku],
      1,
      nowDt,
      nowDt
    ])

    // Batch row + delete old items + insert new items: all-or-nothing
    await txWithRetry(async client => {
      if (isNew) {
        await client.query(
          `INSERT INTO ${T('dispatch_batches')}
             (id, division, vendor, batch_label, set_label, branch_name,
              source, uploaded_by, source_filename, uploaded_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'received', $7, $8, $9, $9)`,
          [
            batchId,
            String(division),
            String(vendor),
            String(batchLabel),
            setLabel,
            String(branchName),
            uploadedBy || 'Unattributed',
            filename || null,
            nowDt
          ]
        )
      } else {
        await client.query(
          `UPDATE ${T('dispatch_batches')}
           SET uploaded_by = $1, source_filename = $2, updated_at = $3
           WHERE id = $4`,
          [uploadedBy || 'Unattributed', filename || null, nowDt, batchId]
        )
      }

      await client.query(
        `DELETE FROM ${T('dispatch_batch_items')} WHERE batch_id = $1`,
        [batchId]
      )

      for (const part of chunk(itemRows, 1000)) {
        await client.query(
          `INSERT INTO ${T('dispatch_batch_items')}
             (id, batch_id, sku, qty, scan_count, first_scanned_at, last_scanned_at)
           VALUES $1`,
          [part]
        )
      }
    })

    res.json({ ok: true, batchId, setNumber, skuCount: itemRows.length })
  } catch (e) {
    console.error('branch-upload error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: GET /api/dispatch/comparison ===================== */
// ARRAY_AGG(DISTINCT ... IGNORE NULLS) does not exist in MySQL.
// The rows are fetched one per SKU and grouped in JS, so the response is the same.

app.get('/api/dispatch/comparison', async (req, res) => {
  const { division, vendor, batchLabel, setLabel, branchName } = req.query
  if (!division || !vendor || !batchLabel)
    return res
      .status(400)
      .json({ ok: false, error: 'division, vendor, batchLabel required' })
  try {
    const { rows } = await db.query(
      `SELECT b.branch_name, b.source, b.uploaded_by, b.uploaded_at, i.sku
       FROM ${T('dispatch_batches')} b
       LEFT JOIN ${T('dispatch_batch_items')} i ON i.batch_id = b.id
       WHERE b.division = $1 AND b.vendor = $2 AND b.batch_label = $3
         AND ($4 IS NULL OR b.set_label = $4)
         AND ($5 IS NULL OR b.branch_name = $5)
       ORDER BY b.uploaded_at`,
      [
        String(division),
        String(vendor),
        String(batchLabel),
        setLabel ? String(setLabel) : null,
        branchName ? String(branchName) : null
      ]
    )

    // Same grouping as the old GROUP BY: branch_name, source, uploaded_by, uploaded_at
    const groups = new Map()
    rows.forEach(r => {
      const key = [r.branch_name, r.source, r.uploaded_by, r.uploaded_at].join(
        '||'
      )
      let g = groups.get(key)
      if (!g) {
        g = {
          branch_name: r.branch_name,
          source: r.source,
          uploaded_by: r.uploaded_by,
          uploaded_at: r.uploaded_at,
          skus: new Set()
        }
        groups.set(key, g)
      }
      if (r.sku != null) g.skus.add(r.sku)
    })

    const byBranch = {}
    groups.forEach(g => {
      g.skus = [...g.skus]
      ;(byBranch[g.branch_name] ||= {})[g.source] = g
    })

    // ---- ✅ NO CHANGE from here down ----
    const results = Object.entries(byBranch).map(([branch, sides]) => {
      const dispatched = new Set(
        (sides.dispatched?.skus || []).map(s => s.toLowerCase())
      )
      const received = new Set(
        (sides.received?.skus || []).map(s => s.toLowerCase())
      )
      const missing = [...dispatched].filter(s => !received.has(s))
      const extra = [...received].filter(s => !dispatched.has(s))
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
        receivedAt: iso(sides.received?.uploaded_at) || null
      }
    })

    res.json({ ok: true, branches: results })
  } catch (e) {
    console.error('comparison error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== ✅ NO CHANGE: GET /api/dispatch/groups ===================== */
// COUNT(DISTINCT IF(...)) works in MySQL as is.

app.get('/api/dispatch/groups', async (req, res) => {
  const { division } = req.query
  if (!division)
    return res.status(400).json({ ok: false, error: 'division required' })
  try {
    const { rows } = await db.query(
      `SELECT vendor, batch_label,
              COUNT(DISTINCT IF(source = 'dispatched', branch_name, NULL)) AS dispatched_branches,
              COUNT(DISTINCT IF(source = 'received', branch_name, NULL)) AS received_branches
       FROM ${T('dispatch_batches')}
       WHERE division = $1
       GROUP BY vendor, batch_label
       ORDER BY vendor, batch_label DESC`,
      [String(division)]
    )
    res.json({
      ok: true,
      groups: rows.map(r => ({
        ...r,
        dispatched_branches: Number(r.dispatched_branches),
        received_branches: Number(r.received_branches)
      }))
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== ✅ NO CHANGE: GET /api/dispatch/batch-labels ===================== */

app.get('/api/dispatch/batch-labels', async (req, res) => {
  const { division, vendor } = req.query
  if (!division || !vendor)
    return res
      .status(400)
      .json({ ok: false, error: 'division and vendor required' })
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT batch_label FROM ${T('dispatch_batches')}
       WHERE division = $1 AND vendor = $2
       ORDER BY batch_label DESC`,
      [String(division), String(vendor)]
    )
    res.json({ ok: true, batchLabels: rows.map(r => r.batch_label) })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== ✅ NO CHANGE: GET /api/dispatch/set-labels ===================== */

app.get('/api/dispatch/set-labels', async (req, res) => {
  const { division, vendor, batchLabel, branchName } = req.query
  if (!division || !vendor || !batchLabel) {
    return res
      .status(400)
      .json({ ok: false, error: 'division, vendor, batchLabel required' })
  }
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT set_label FROM ${T('dispatch_batches')}
       WHERE division = $1 AND vendor = $2 AND batch_label = $3
         AND source = 'dispatched'
         AND ($4 IS NULL OR branch_name = $4)
       ORDER BY set_label ASC`,
      [
        String(division),
        String(vendor),
        String(batchLabel),
        branchName ? String(branchName) : null
      ]
    )
    res.json({ ok: true, setLabels: rows.map(r => r.set_label) })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== ✅ NO CHANGE: GET /api/dispatch/set-summary ===================== */

app.get('/api/dispatch/set-summary', async (req, res) => {
  const { division, vendor, batchLabel } = req.query
  if (!division || !vendor || !batchLabel) {
    return res
      .status(400)
      .json({ ok: false, error: 'division, vendor, batchLabel required' })
  }
  try {
    const { rows } = await db.query(
      `SELECT b.set_label, b.branch_name, b.source, b.uploaded_at,
              COUNT(i.sku) AS sku_count
       FROM ${T('dispatch_batches')} b
       LEFT JOIN ${T('dispatch_batch_items')} i ON i.batch_id = b.id
       WHERE b.division = $1 AND b.vendor = $2 AND b.batch_label = $3
       GROUP BY b.id, b.set_label, b.branch_name, b.source, b.uploaded_at
       ORDER BY b.set_label, b.branch_name, b.source`,
      [String(division), String(vendor), String(batchLabel)]
    )

    const bySet = {}
    rows.forEach(r => {
      const set = (bySet[r.set_label] ||= {})
      const branch = (set[r.branch_name] ||= {})
      branch[r.source] = {
        uploadedAt: iso(r.uploaded_at) || null,
        skuCount: Number(r.sku_count)
      }
    })

    const sets = Object.entries(bySet).map(([setLabel, branches]) => ({
      setLabel,
      branches: Object.entries(branches).map(([branchName, sides]) => ({
        branchName,
        dispatchedAt: sides.dispatched?.uploadedAt || null,
        dispatchedCount: sides.dispatched?.skuCount || 0,
        receivedAt: sides.received?.uploadedAt || null,
        receivedCount: sides.received?.skuCount || 0,
        status: !sides.dispatched
          ? 'not_dispatched'
          : !sides.received
          ? 'awaiting_receipt'
          : 'received'
      }))
    }))

    res.json({ ok: true, sets })
  } catch (e) {
    console.error('set-summary error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: POST /api/dispatch/delete-batch ===================== */

app.post('/api/dispatch/delete-batch', async (req, res) => {
  const { batchId } = req.body
  if (!batchId)
    return res.status(400).json({ ok: false, error: 'batchId required' })
  try {
    const { rows } = await db.query(
      `SELECT * FROM ${T('dispatch_batches')} WHERE id = $1`,
      [String(batchId)]
    )
    if (!rows.length)
      return res.status(404).json({ ok: false, error: 'Batch not found' })

    // 🔄 was a BEGIN TRANSACTION script; now a real transaction
    await txWithRetry(async client => {
      await client.query(
        `DELETE FROM ${T('dispatch_batch_items')} WHERE batch_id = $1`,
        [String(batchId)]
      )
      await client.query(`DELETE FROM ${T('dispatch_batches')} WHERE id = $1`, [
        String(batchId)
      ])
    })

    const b = rows[0]
    res.json({
      ok: true,
      deleted: {
        ...b,
        uploaded_at: iso(b.uploaded_at) || null,
        updated_at: iso(b.updated_at) || null
      }
    })
  } catch (e) {
    console.error('delete-batch error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== ✅ NO CHANGE: GET /api/dispatch/batches ===================== */

app.get('/api/dispatch/batches', async (req, res) => {
  const { division, vendor, batchLabel } = req.query
  if (!division || !vendor || !batchLabel)
    return res
      .status(400)
      .json({ ok: false, error: 'division, vendor, batchLabel required' })
  try {
    const { rows } = await db.query(
      `SELECT b.id, b.branch_name, b.source, b.uploaded_by, b.uploaded_at,
              COUNT(i.sku) AS sku_count,
              COALESCE(SUM(i.scan_count), 0) AS total_scans
       FROM ${T('dispatch_batches')} b
       LEFT JOIN ${T('dispatch_batch_items')} i ON i.batch_id = b.id
       WHERE b.division = $1 AND b.vendor = $2 AND b.batch_label = $3
       GROUP BY b.id, b.branch_name, b.source, b.uploaded_by, b.uploaded_at
       ORDER BY b.branch_name ASC, b.source ASC`,
      [String(division), String(vendor), String(batchLabel)]
    )
    res.json({
      ok: true,
      batches: rows.map(r => ({
        ...r,
        uploaded_at: iso(r.uploaded_at) || null,
        sku_count: Number(r.sku_count),
        total_scans: Number(r.total_scans)
      }))
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: POST /api/dispatch/rename-batch ===================== */

app.post('/api/dispatch/rename-batch', async (req, res) => {
  const { division, vendor, oldBatchLabel, newBatchLabel } = req.body
  if (!division || !vendor || !oldBatchLabel || !newBatchLabel) {
    return res.status(400).json({
      ok: false,
      error: 'division, vendor, oldBatchLabel, newBatchLabel required'
    })
  }
  if (oldBatchLabel === newBatchLabel) {
    return res
      .status(400)
      .json({ ok: false, error: 'New label is the same as the old one' })
  }
  try {
    const { rows: clash } = await db.query(
      `SELECT 1 FROM ${T('dispatch_batches')}
       WHERE division = $1 AND vendor = $2 AND batch_label = $3 LIMIT 1`,
      [String(division), String(vendor), String(newBatchLabel)]
    )
    if (clash.length > 0) {
      return res.status(400).json({
        ok: false,
        error: `A batch named "${newBatchLabel}" already exists for this vendor — pick a different name or delete it first.`
      })
    }

    const { rows: cnt } = await db.query(
      `SELECT COUNT(*) AS n FROM ${T('dispatch_batches')}
       WHERE division = $1 AND vendor = $2 AND batch_label = $3`,
      [String(division), String(vendor), String(oldBatchLabel)]
    )

    await db.query(
      `UPDATE ${T('dispatch_batches')}
       SET batch_label = $4, updated_at = $5
       WHERE division = $1 AND vendor = $2 AND batch_label = $3`,
      [
        String(division),
        String(vendor),
        String(oldBatchLabel),
        String(newBatchLabel),
        toMysqlDt(new Date())
      ]
    )
    res.json({ ok: true, renamed: Number(cnt[0].n) })
  } catch (e) {
    console.error('rename-batch error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== ❌ DELETE the old withRetry() helper ===================== */
// It checked for BigQuery error messages ("concurrent update" etc.), which
// MySQL never raises. txWithRetry() now does this job for deadlocks.

/* ===================== 🔄 CHANGED: POST /api/dispatch/scan-undo ===================== */
// The row is locked (FOR UPDATE) while it is read, so two quick undo clicks
// can't both read the same count.

app.post('/api/dispatch/scan-undo', async (req, res) => {
  const { batchId, sku } = req.body
  if (!batchId || !sku)
    return res
      .status(400)
      .json({ ok: false, error: 'batchId and sku required' })
  try {
    const result = await txWithRetry(async client => {
      const { rows } = await client.query(
        `SELECT scan_count FROM ${T('dispatch_batch_items')}
         WHERE batch_id = $1 AND sku = $2 AND scan_count > 0
         FOR UPDATE`,
        [String(batchId), String(sku)]
      )
      if (!rows.length) return null

      const scanCount = Number(rows[0].scan_count) - 1
      const removed = scanCount <= 0

      if (removed) {
        await client.query(
          `DELETE FROM ${T(
            'dispatch_batch_items'
          )} WHERE batch_id = $1 AND sku = $2`,
          [String(batchId), String(sku)]
        )
      } else {
        await client.query(
          `UPDATE ${T('dispatch_batch_items')}
           SET scan_count = scan_count - 1, last_scanned_at = $3
           WHERE batch_id = $1 AND sku = $2`,
          [String(batchId), String(sku), toMysqlDt(new Date())]
        )
      }
      return { scanCount: Math.max(scanCount, 0), removed }
    })

    if (!result)
      return res.status(404).json({ ok: false, error: 'Item not found' })

    res.json({ ok: true, ...result })
  } catch (e) {
    console.error('scan-undo error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: POST /api/dispatch/scan ===================== */

app.post('/api/dispatch/scan', async (req, res) => {
  const {
    division,
    vendor,
    batchLabel,
    setLabel,
    branchName,
    source,
    sku,
    scannedBy
  } = req.body
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
        'division, vendor, batchLabel, setLabel, branchName, source, sku required'
    })
  }
  if (!['dispatched', 'received'].includes(source)) {
    return res
      .status(400)
      .json({ ok: false, error: "source must be 'dispatched' or 'received'" })
  }

  try {
    const problem = await dispatchValidate(division, vendor, branchName)
    if (problem) return res.status(400).json({ ok: false, error: problem })

    const cleanSku = String(sku).trim()
    const keyParams = [
      String(division),
      String(vendor),
      String(batchLabel),
      String(setLabel),
      String(branchName)
    ]

    // ---- ✅ NO CHANGE: a "received" scan must match something dispatched ----
    if (source === 'received') {
      const { rows: dcheck } = await db.query(
        `SELECT id FROM ${T('dispatch_batches')}
         WHERE division = $1 AND vendor = $2 AND batch_label = $3
           AND set_label = $4 AND branch_name = $5 AND source = 'dispatched'
         LIMIT 1`,
        keyParams
      )
      if (!dcheck.length) {
        return res.status(400).json({
          ok: false,
          error: `${setLabel} was never dispatched to ${branchName} for this batch.`
        })
      }
      const { rows: skuCheck } = await db.query(
        `SELECT 1 FROM ${T('dispatch_batch_items')}
         WHERE batch_id = $1 AND LOWER(sku) = LOWER($2) LIMIT 1`,
        [String(dcheck[0].id), cleanSku]
      )
      if (!skuCheck.length) {
        return res.status(400).json({
          ok: false,
          error: `SKU "${sku}" was not part of the dispatched list for ${setLabel} → ${branchName}.`
        })
      }
    }

    // ---- Find (or create) this side's batch ----
    const { rows: batchRows } = await db.query(
      `SELECT id FROM ${T('dispatch_batches')}
       WHERE division = $1 AND vendor = $2 AND batch_label = $3
         AND set_label = $4 AND branch_name = $5 AND source = $6
       LIMIT 1`,
      [...keyParams, String(source)]
    )
    const isNew = batchRows.length === 0
    const batchId = isNew ? randomUUID() : String(batchRows[0].id) // 🔄
    const nowDt = toMysqlDt(new Date())

    // 🔄 CHANGED: script -> transaction. Batch row + item upsert together.
    await txWithRetry(async client => {
      if (isNew) {
        await client.query(
          `INSERT INTO ${T('dispatch_batches')}
             (id, division, vendor, batch_label, set_label, branch_name, source,
              uploaded_by, uploaded_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
          [
            batchId,
            ...keyParams,
            String(source),
            scannedBy || 'Unattributed',
            nowDt
          ]
        )
      } else {
        await client.query(
          `UPDATE ${T('dispatch_batches')}
           SET updated_at = $1, uploaded_by = $2
           WHERE id = $3`,
          [nowDt, scannedBy || 'Unattributed', batchId]
        )
      }

      // MERGE -> INSERT ... ON DUPLICATE KEY UPDATE (needs uq_batch_sku)
      await client.query(
        `INSERT INTO ${T('dispatch_batch_items')}
           (id, batch_id, sku, qty, scan_count, first_scanned_at, last_scanned_at)
         VALUES ($1, $2, $3, 1, 1, $4, $4)
         ON DUPLICATE KEY UPDATE
           scan_count = IFNULL(scan_count, 0) + 1,
           last_scanned_at = VALUES(last_scanned_at)`,
        [itemId(batchId, cleanSku), batchId, cleanSku, nowDt]
      )
    })

    // ---- ✅ NO CHANGE: one read for the scanned SKU's count + batch totals ----
    const { rows } = await db.query(
      `SELECT
         IFNULL(SUM(IF(sku = $2, scan_count, 0)), 0) AS scan_count,
         COUNT(*) AS unique_skus,
         IFNULL(SUM(scan_count), 0) AS total_scans
       FROM ${T('dispatch_batch_items')}
       WHERE batch_id = $1`,
      [batchId, cleanSku]
    )
    const scanCount = Number(rows[0].scan_count)

    res.json({
      ok: true,
      batchId,
      sku: cleanSku,
      scanCount,
      isDuplicate: scanCount > 1,
      uniqueSkus: Number(rows[0].unique_skus),
      totalScans: Number(rows[0].total_scans)
    })
  } catch (e) {
    console.error('dispatch/scan error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== ✅ NO CHANGE: GET /api/dispatch/scan-log ===================== */

app.get('/api/dispatch/scan-log', async (req, res) => {
  const { division, vendor, batchLabel, setLabel, branchName, source } =
    req.query
  if (
    !division ||
    !vendor ||
    !batchLabel ||
    !setLabel ||
    !branchName ||
    !source
  ) {
    return res.status(400).json({ ok: false, error: 'all params required' })
  }
  try {
    const { rows } = await db.query(
      `SELECT i.sku, i.scan_count, i.first_scanned_at, i.last_scanned_at, b.id AS batch_id
       FROM ${T('dispatch_batch_items')} i
       JOIN ${T('dispatch_batches')} b ON b.id = i.batch_id
       WHERE b.division = $1 AND b.vendor = $2 AND b.batch_label = $3
         AND b.set_label = $4 AND b.branch_name = $5 AND b.source = $6
       ORDER BY i.last_scanned_at DESC`,
      [
        String(division),
        String(vendor),
        String(batchLabel),
        String(setLabel),
        String(branchName),
        String(source)
      ]
    )
    res.json({
      ok: true,
      items: rows.map(r => ({
        ...r,
        scan_count: Number(r.scan_count),
        first_scanned_at: iso(r.first_scanned_at) || null,
        last_scanned_at: iso(r.last_scanned_at) || null
      })),
      batchId: rows.length ? rows[0].batch_id : null
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== 🔄 CHANGED: GET /api/dispatch/branch-pending ===================== */
// The SKU arrays are no longer built in SQL. One query returns the
// dispatched/received batch pairs, a second returns the (batch_id, sku) rows
// for this branch, and the arrays are built in JS. The response is the same.

app.get('/api/dispatch/branch-pending', async (req, res) => {
  const { division, branchName } = req.query
  if (!division || !branchName) {
    return res
      .status(400)
      .json({ ok: false, error: 'division and branchName required' })
  }
  try {
    const [{ rows }, { rows: itemRows }] = await Promise.all([
      db.query(
        `SELECT
           d.id AS dispatch_batch_id,
           d.vendor, d.batch_label, d.set_label, d.uploaded_at AS dispatched_at,
           r.id AS received_batch_id,
           r.uploaded_at AS received_at
         FROM ${T('dispatch_batches')} d
         LEFT JOIN ${T('dispatch_batches')} r
           ON r.division = d.division AND r.vendor = d.vendor
          AND r.batch_label = d.batch_label AND r.set_label = d.set_label
          AND r.branch_name = d.branch_name AND r.source = 'received'
         WHERE d.division = $1 AND d.branch_name = $2 AND d.source = 'dispatched'
         ORDER BY d.uploaded_at DESC`,
        [String(division), String(branchName)]
      ),
      // All items of every batch (dispatched and received) for this branch
      db.query(
        `SELECT i.batch_id, i.sku
         FROM ${T('dispatch_batch_items')} i
         JOIN ${T('dispatch_batches')} b ON b.id = i.batch_id
         WHERE b.division = $1 AND b.branch_name = $2`,
        [String(division), String(branchName)]
      )
    ])

    // batch_id -> Set of lowercase SKUs (distinct, nulls ignored)
    const skusByBatch = new Map()
    itemRows.forEach(i => {
      if (i.sku == null) return
      const key = String(i.batch_id)
      if (!skusByBatch.has(key)) skusByBatch.set(key, new Set())
      skusByBatch.get(key).add(String(i.sku).toLowerCase())
    })

    const result = rows.map(r => {
      const dispatchedSet =
        skusByBatch.get(String(r.dispatch_batch_id)) || new Set()
      const receivedSet = r.received_batch_id
        ? skusByBatch.get(String(r.received_batch_id)) || new Set()
        : new Set()
      const pendingSkus = [...dispatchedSet].filter(s => !receivedSet.has(s))
      return {
        vendor: r.vendor,
        batch_label: r.batch_label,
        set_label: r.set_label,
        dispatched_at: iso(r.dispatched_at) || null,
        received_at: iso(r.received_at) || null,
        dispatched_count: dispatchedSet.size,
        received_count: receivedSet.size,
        pending_count: pendingSkus.length,
        fully_received: dispatchedSet.size > 0 && pendingSkus.length === 0
      }
    })

    res.json({ ok: true, rows: result })
  } catch (e) {
    console.error('branch-pending error', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

/* ===================== Server start + graceful shutdown ===================== */

// ✅ NO CHANGE
const PORT = process.env.PORT || 8080
const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})

let isShuttingDown = false

// 🔄 CHANGED: after the HTTP server stops, the MySQL pool is closed too
function gracefulShutdown (signal) {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log(`${signal} received — starting graceful shutdown`)

  const forceExitTimer = setTimeout(() => {
    console.error('Forced shutdown — requests did not finish in time')
    process.exit(1)
  }, 10000)

  server.close(async () => {
    try {
      await mysqlPool.end()
      console.log('MySQL pool closed')
    } catch (e) {
      console.error('Error closing MySQL pool:', e.message)
    }
    clearTimeout(forceExitTimer)
    console.log('HTTP server closed cleanly')
    process.exit(0)
  })
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))

// ❌ DELETE the commented-out PORT / app.listen lines that were at the bottom.
