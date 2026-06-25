require("dotenv").config();

const API = `http://localhost:${process.env.PORT || 4000}`;

// ── helpers ──────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 9);

async function get(path) {
  const r = await fetch(API + path);
  return r.json();
}

async function post(path, body) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

function pass(msg) { console.log("  ✅", msg); }
function fail(msg) { console.log("  ❌", msg); process.exitCode = 1; }
function section(msg) { console.log(`\n── ${msg} ${"─".repeat(50 - msg.length)}`); }

// ── tests ─────────────────────────────────────────────────────
async function run() {
  console.log(`\nCard Tracker — Assignment History Test Suite`);
  console.log(`API: ${API}\n`);

  // ── 1. Health check ──────────────────────────────────────────
  section("1. Health check");
  try {
    const h = await get("/health");
    h.ok ? pass("Server is up and DB connected") : fail(`Health check failed: ${JSON.stringify(h)}`);
  } catch (e) {
    fail(`Cannot reach server at ${API} — is it running? (${e.message})`);
    return; // no point continuing
  }

  // ── 2. getAll includes assignmentHistory ─────────────────────
  section("2. GET /api/getAll — assignmentHistory key present");
  try {
    const data = await get("/api/getAll");
    if (!data.assignmentHistory) {
      fail("assignmentHistory key missing from /api/getAll response");
    } else {
      pass(`assignmentHistory present — ${data.assignmentHistory.length} existing rows`);
    }

    // also sanity check other keys still exist
    const keys = ["products", "vendors", "teamMembers", "assignments", "qcAudit", "audit", "assignmentHistory"];
    const missing = keys.filter(k => !(k in data));
    missing.length === 0
      ? pass("All expected keys present in getAll response")
      : fail(`Missing keys in getAll: ${missing.join(", ")}`);

  } catch (e) {
    fail(`getAll failed: ${e.message}`);
  }

  // ── 3. appendAssignmentHistory — assigned action ─────────────
  section("3. POST /api/appendAssignmentHistory — 'assigned'");
  const testId1 = uid();
  try {
    const res = await post("/api/appendAssignmentHistory", {
      id: testId1,
      action: "assigned",
      sku: "TEST-SKU-001",
      division: "KOC Cards",
      fromMemberId: null,
      toMemberId: "chitra",
      managerId: "master",
      stage: "barcoding",
      note: "Test assignment from test suite",
      at: new Date().toISOString(),
    });
    res.ok
      ? pass(`Row inserted — id: ${testId1}`)
      : fail(`Insert failed: ${JSON.stringify(res)}`);
  } catch (e) {
    fail(`appendAssignmentHistory request failed: ${e.message}`);
  }

  // ── 4. appendAssignmentHistory — unassigned action ───────────
  section("4. POST /api/appendAssignmentHistory — 'unassigned'");
  const testId2 = uid();
  try {
    const res = await post("/api/appendAssignmentHistory", {
      id: testId2,
      action: "unassigned",
      sku: "TEST-SKU-001",
      division: "KOC Cards",
      fromMemberId: "chitra",
      toMemberId: null,
      managerId: "master",
      stage: "barcoding",
      note: "Test unassign from test suite",
      at: new Date().toISOString(),
    });
    res.ok
      ? pass(`Row inserted — id: ${testId2}`)
      : fail(`Insert failed: ${JSON.stringify(res)}`);
  } catch (e) {
    fail(`appendAssignmentHistory request failed: ${e.message}`);
  }

  // ── 5. Verify rows appear in getAll ──────────────────────────
  section("5. Verify new rows appear in GET /api/getAll");
  try {
    const data = await get("/api/getAll");
    const history = data.assignmentHistory || [];
    const found1 = history.find(r => r.id === testId1);
    const found2 = history.find(r => r.id === testId2);

    found1
      ? pass(`'assigned' row found in getAll — sku=${found1.sku}, to=${found1.toMemberId}, stage=${found1.stage}`)
      : fail(`'assigned' row (id=${testId1}) NOT found in getAll`);

    found2
      ? pass(`'unassigned' row found in getAll — sku=${found2.sku}, from=${found2.fromMemberId}`)
      : fail(`'unassigned' row (id=${testId2}) NOT found in getAll`);

  } catch (e) {
    fail(`getAll verification failed: ${e.message}`);
  }

  // ── 6. GET /api/assignmentHistory?division=KOC Cards ─────────
  section("6. GET /api/assignmentHistory (division filter)");
  try {
    const rows = await get("/api/assignmentHistory?division=KOC%20Cards");
    if (!Array.isArray(rows)) {
      fail(`Expected array, got: ${JSON.stringify(rows).slice(0, 100)}`);
    } else {
      pass(`${rows.length} rows returned for KOC Cards`);
      const found = rows.find(r => r.id === testId1);
      found
        ? pass(`Test row found with toMemberName=${found.toMemberName || "(no join — member may not exist)"}`)
        : fail(`Test row not found in /api/assignmentHistory`);
    }
  } catch (e) {
    fail(`/api/assignmentHistory request failed: ${e.message}`);
  }

  // ── 7. Duplicate id rejection ────────────────────────────────
  section("7. Duplicate id should fail (PRIMARY KEY constraint)");
  try {
    const res = await post("/api/appendAssignmentHistory", {
      id: testId1, // same id as test 3
      action: "assigned",
      sku: "TEST-SKU-002",
      division: "KOC Cards",
      fromMemberId: null,
      toMemberId: "chitra",
      managerId: "master",
      stage: "content",
      note: "Duplicate test",
      at: new Date().toISOString(),
    });
    res.ok
      ? fail("Duplicate id was accepted — PRIMARY KEY not enforced!")
      : pass(`Duplicate correctly rejected: ${res.error || "constraint violation"}`);
  } catch (e) {
    fail(`Request itself failed (expected a 500 response, not a network error): ${e.message}`);
  }

  // ── Summary ──────────────────────────────────────────────────
  console.log("\n" + "─".repeat(55));
  if (process.exitCode === 1) {
    console.log("❌ Some tests failed — check the output above.");
  } else {
    console.log("✅ All tests passed.");
  }
  console.log("─".repeat(55) + "\n");
}

run().catch(e => {
  console.error("Unexpected error:", e);
  process.exit(1);
});