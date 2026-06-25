-- ============================================================
--  Card Tracker — PostgreSQL Schema for AWS RDS
--  DB   : koc-card-game-db
--  Run  : psql -h king-of-cards-rds.cjm1rmhm3mxx.ap-south-1.rds.amazonaws.com \
--              -U koccardgameuser -d koc-card-game-db -f card_tracker_schema.sql
-- ============================================================

-- ── ENUMS ────────────────────────────────────────────────────

CREATE TYPE stage_status   AS ENUM ('Not Started', 'In Progress', 'Completed', 'Issue');
CREATE TYPE qc_verdict     AS ENUM ('Approved', 'Issues Found');
CREATE TYPE user_role      AS ENUM ('master', 'admin', 'member');
CREATE TYPE division_name  AS ENUM ('KOC Cards', 'Bombay Cards');

-- ── 1. VENDORS ───────────────────────────────────────────────
--  One row per vendor per division.
--  Replaces the JSON-array "vendors" sheet.

CREATE TABLE vendors (
    division     division_name   NOT NULL,
    vendor_name  TEXT            NOT NULL,
    created_at   TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (division, vendor_name)
);

-- ── 2. PRODUCTS ──────────────────────────────────────────────
--  Core card / SKU catalogue. One row = one design.

CREATE TABLE products (
    id           TEXT            PRIMARY KEY,          -- random 7-char id (kept from GSheets)
    division     division_name   NOT NULL,
    sku          TEXT            NOT NULL,
    name         TEXT            NOT NULL DEFAULT '',
    vendor       TEXT,
    inward       DATE,
    qty          INTEGER         NOT NULL DEFAULT 0,
    note         TEXT            NOT NULL DEFAULT '',
    set_no       TEXT,
    verdict      qc_verdict,                           -- latest QC outcome
    issues       TEXT            NOT NULL DEFAULT '',  -- latest QC notes
    created_at   TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ     NOT NULL DEFAULT now(),

    UNIQUE (division, sku),
    FOREIGN KEY (division, vendor) REFERENCES vendors (division, vendor_name)
        ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE INDEX idx_products_division ON products (division);
CREATE INDEX idx_products_sku      ON products (sku);
CREATE INDEX idx_products_vendor   ON products (division, vendor);

-- ── 3. STAGE_ENTRIES ─────────────────────────────────────────
--  12 pipeline stages per product. Replaces 50+ fat columns.
--  stage_key values:
--    barcoding | content | photography | videography | dimensions
--    videoedit | images  | backend     | website     | scan | qc | finalqc

CREATE TABLE stage_entries (
    product_id  TEXT            NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    stage_key   TEXT            NOT NULL,
    status      stage_status    NOT NULL DEFAULT 'Not Started',
    person      TEXT,                    -- operator name who last touched it
    comments    TEXT            NOT NULL DEFAULT '',
    updated_at  TIMESTAMPTZ,
    -- dimensions stage only
    width_cm    NUMERIC(6,2),
    height_cm   NUMERIC(6,2),
    weight_gm   NUMERIC(8,2),
    PRIMARY KEY (product_id, stage_key)
);

CREATE INDEX idx_stage_product  ON stage_entries (product_id);
CREATE INDEX idx_stage_key      ON stage_entries (stage_key);
CREATE INDEX idx_stage_status   ON stage_entries (status);
CREATE INDEX idx_stage_person   ON stage_entries (person);

-- ── 4. STORES ────────────────────────────────────────────────
--  One row per product × store (11 stores × N products).

CREATE TABLE stores (
    product_id    TEXT            NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    store         TEXT            NOT NULL,
    dispatched    INTEGER         NOT NULL DEFAULT 0,
    received      BOOLEAN         NOT NULL DEFAULT FALSE,
    received_at   TIMESTAMPTZ,
    received_by   TEXT,
    missing       INTEGER         NOT NULL DEFAULT 0,
    damaged       INTEGER         NOT NULL DEFAULT 0,
    notes         TEXT            NOT NULL DEFAULT '',
    updated_at    TIMESTAMPTZ,
    PRIMARY KEY (product_id, store)
);

CREATE INDEX idx_stores_product   ON stores (product_id);
CREATE INDEX idx_stores_store     ON stores (store);
CREATE INDEX idx_stores_missing   ON stores (missing) WHERE missing > 0;
CREATE INDEX idx_stores_damaged   ON stores (damaged) WHERE damaged > 0;

-- ── 5. USERS ─────────────────────────────────────────────────
--  Login credentials + role + stage permissions.
--  Merges "Users" and "teamMembers" sheets into one table.

CREATE TABLE users (
    id           TEXT            PRIMARY KEY,          -- slug e.g. "dharani", "sunny_john"
    name         TEXT            NOT NULL,
    email        TEXT            NOT NULL UNIQUE,
    password     TEXT            NOT NULL,             -- store hashed in production!
    role         user_role       NOT NULL DEFAULT 'member',
    stages       TEXT            NOT NULL DEFAULT '',  -- comma-sep stage keys or "all"
    division     division_name,
    manager_id   TEXT            REFERENCES users (id) ON DELETE SET NULL,
    joined_at    TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_email      ON users (email);
CREATE INDEX idx_users_division   ON users (division);
CREATE INDEX idx_users_manager    ON users (manager_id);

-- ── 6. ASSIGNMENTS ───────────────────────────────────────────
--  Links a user to a specific SKU + stage.
--  manager_id = "master" means assigned directly by an admin.

CREATE TABLE assignments (
    id           TEXT            PRIMARY KEY,
    member_id    TEXT            NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    manager_id   TEXT            NOT NULL,             -- user id or "master"
    product_id   TEXT            NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    sku          TEXT            NOT NULL,             -- denorm for fast lookup
    division     division_name   NOT NULL,
    stage        TEXT            NOT NULL,             -- stage_key or "all"
    assigned_at  TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_assign_member   ON assignments (member_id);
CREATE INDEX idx_assign_manager  ON assignments (manager_id);
CREATE INDEX idx_assign_product  ON assignments (product_id);
CREATE INDEX idx_assign_sku      ON assignments (division, sku);
CREATE INDEX idx_assign_stage    ON assignments (member_id, stage);

-- ── 7. QC_AUDIT ──────────────────────────────────────────────
--  Every QC verdict event — full history per product.

CREATE TABLE qc_audit (
    id                TEXT            PRIMARY KEY,
    audited_at        TIMESTAMPTZ     NOT NULL DEFAULT now(),
    auditor_id        TEXT            REFERENCES users (id) ON DELETE SET NULL,
    auditor_name      TEXT            NOT NULL,        -- denorm for display
    product_id        TEXT            NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    sku               TEXT            NOT NULL,
    division          division_name   NOT NULL,
    verdict           qc_verdict      NOT NULL,
    comments          TEXT            NOT NULL DEFAULT '',
    stages_sent_back  TEXT            NOT NULL DEFAULT '' -- comma-sep stage keys
);

CREATE INDEX idx_qcaudit_product   ON qc_audit (product_id);
CREATE INDEX idx_qcaudit_auditor   ON qc_audit (auditor_id);
CREATE INDEX idx_qcaudit_verdict   ON qc_audit (verdict);
CREATE INDEX idx_qcaudit_at        ON qc_audit (audited_at DESC);

-- ── 8. AUDIT_LOG ─────────────────────────────────────────────
--  Immutable activity log. Every action appended, never updated.

CREATE TABLE audit_log (
    id          TEXT            PRIMARY KEY,
    logged_at   TIMESTAMPTZ     NOT NULL DEFAULT now(),
    actor_id    TEXT            REFERENCES users (id) ON DELETE SET NULL,
    actor_name  TEXT            NOT NULL,
    action      TEXT            NOT NULL,   -- "Stage update", "Bulk stage update", etc.
    entity      TEXT            NOT NULL,   -- SKU or description
    detail      TEXT            NOT NULL DEFAULT '',
    division    division_name
);

CREATE INDEX idx_audit_actor     ON audit_log (actor_id);
CREATE INDEX idx_audit_action    ON audit_log (action);
CREATE INDEX idx_audit_division  ON audit_log (division);
CREATE INDEX idx_audit_at        ON audit_log (logged_at DESC);

-- ── HELPER: auto-update updated_at ───────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER trg_products_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── SEED: known stores ────────────────────────────────────────

CREATE TABLE store_list (
    store_name TEXT PRIMARY KEY
);

INSERT INTO store_list (store_name) VALUES
    ('Chamrajpet'), ('HSR Layout'), ('Sahakar Nagar'), ('Hoodi'),
    ('Jayanagar'), ('Bommasandra'), ('Hyderabad'), ('Mysore'),
    ('Vizag'), ('Hubli'), ('Chitradurga');

-- ── SEED: stage list ─────────────────────────────────────────

CREATE TABLE stage_list (
    stage_key   TEXT PRIMARY KEY,
    stage_name  TEXT NOT NULL,
    sort_order  SMALLINT NOT NULL
);

INSERT INTO stage_list (stage_key, stage_name, sort_order) VALUES
    ('barcoding',  'Bar Coding',              1),
    ('content',    'Content',                 2),
    ('photography','Photography',             3),
    ('videography','Videography',             4),
    ('dimensions', 'Dimensions',              5),
    ('videoedit',  'Video Editing',           6),
    ('images',     'Video Uploaded',          7),
    ('backend',    'Backend Listing (App)',   8),
    ('website',    'Website Listing (Shopify)',9),
    ('scan',       'Scan Before Dispatch',   10),
    ('qc',         'QC Check',               11),
    ('finalqc',    'Final QC / Audit',       12);

-- ── USEFUL VIEWS ─────────────────────────────────────────────

-- Overview: product + how many stages are completed
CREATE VIEW v_product_progress AS
SELECT
    p.id,
    p.division,
    p.sku,
    p.name,
    p.vendor,
    p.set_no,
    p.verdict,
    COUNT(*)                                           AS total_stages,
    COUNT(*) FILTER (WHERE se.status = 'Completed')   AS done_stages,
    COUNT(*) FILTER (WHERE se.status = 'Issue')        AS issue_stages,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE se.status = 'Completed') / NULLIF(COUNT(*), 0)
    )                                                  AS pct_complete
FROM products p
LEFT JOIN stage_entries se ON se.product_id = p.id
GROUP BY p.id;

-- Store alerts: missing or damaged items
CREATE VIEW v_store_alerts AS
SELECT
    s.product_id,
    p.division,
    p.sku,
    p.name,
    s.store,
    s.missing,
    s.damaged,
    s.notes,
    s.updated_at
FROM stores s
JOIN products p ON p.id = s.product_id
WHERE s.missing > 0 OR s.damaged > 0;

-- Member workload: cards assigned + stages done
CREATE VIEW v_member_workload AS
SELECT
    u.id            AS member_id,
    u.name          AS member_name,
    u.division,
    COUNT(DISTINCT a.product_id)                                          AS cards_assigned,
    COUNT(a.id)                                                           AS stage_tasks_total,
    COUNT(a.id) FILTER (
        WHERE se.status = 'Completed'
    )                                                                     AS stage_tasks_done,
    COUNT(a.id) FILTER (
        WHERE se.status = 'Issue'
    )                                                                     AS stage_tasks_issue
FROM users u
JOIN assignments a  ON a.member_id = u.id
LEFT JOIN stage_entries se
    ON se.product_id = a.product_id AND se.stage_key = a.stage
GROUP BY u.id, u.name, u.division;

-- ============================================================
--  Schema complete. Seed data (existing products / users)
--  should be migrated from Google Sheets using the
--  migration script: card_tracker_migrate.py
-- ============================================================