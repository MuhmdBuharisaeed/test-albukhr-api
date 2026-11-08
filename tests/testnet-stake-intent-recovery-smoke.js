"use strict";

// Run from test-albukhr-api repository root:
// node tests/testnet-stake-intent-recovery-smoke.js

const fs = require("node:fs");
const assert = require("node:assert/strict");

const source = fs.readFileSync(
  "testnet-staking-router.js",
  "utf8"
);

const startToken =
  'router.post("/pending", async (req, res) => {';

const endToken =
  'router.post("/intent", async (req, res) => {';

const start = source.indexOf(startToken);

assert.ok(
  start >= 0,
  "pending recovery route exists"
);

const end = source.indexOf(
  endToken,
  start + startToken.length
);

assert.ok(
  end > start,
  "pending route is positioned before intent creation"
);

const route = source.slice(start, end);

// --------------------------------------------------
// TESTNET SESSION AND IDENTITY VALIDATION
// --------------------------------------------------

assert.match(
  route,
  /getTestnetSession\(req\)/,
  "requires a validated Testnet session"
);

assert.match(
  route,
  /session\s*&&\s*session\.pi_uid/,
  "uses the authenticated session Pi UID"
);

// --------------------------------------------------
// NETWORK AND OWNER ISOLATION
// --------------------------------------------------

assert.match(
  route,
  /\.eq\("network", NETWORK\)/,
  "filters the Testnet network"
);

assert.match(
  route,
  /\.eq\("pi_uid", piUid\)/,
  "restricts recovery to the authenticated owner"
);

assert.match(
  route,
  /\.eq\("project_id", projectId\)/,
  "filters by project ID"
);

assert.match(
  route,
  /\.eq\("project_code", projectCode\)/,
  "filters by project code"
);

assert.match(
  route,
  /\.eq\("status", "pending_payment"\)/,
  "returns only pending-payment intents"
);

// --------------------------------------------------
// DUPLICATE AND AMBIGUOUS INTENT PROTECTION
// --------------------------------------------------

assert.match(
  route,
  /\.limit\(2\)/,
  "detects duplicate or ambiguous pending intents"
);

assert.match(
  route,
  /STAKE_INTENT_RECOVERY_CONFLICT/,
  "fails closed on ambiguous recovery state"
);

// --------------------------------------------------
// PAYMENT RECOVERY STATE
// --------------------------------------------------

assert.match(
  route,
  /payment_armed:\s*metadata\.payment_started\s*===\s*true/,
  "returns an explicit payment-armed state"
);

// --------------------------------------------------
// READ-ONLY RECOVERY PROTECTION
// --------------------------------------------------

assert.doesNotMatch(
  route,
  /\.update\(|\.insert\(|\.delete\(/,
  "recovery endpoint is read-only"
);

assert.doesNotMatch(
  route,
  /res\.json\(\{[\s\S]*?metadata:\s*row\.metadata/,
  "does not expose raw intent metadata"
);

assert.doesNotMatch(
  route,
  /pi_uid:\s*row\.pi_uid/,
  "does not expose the user's Pi UID"
);

// --------------------------------------------------
// HTTP ERROR STATUS MAPPING
// --------------------------------------------------

assert.match(
  source,
  /^\s*STAKE_INTENT_RECOVERY_CONFLICT:\s*409,\s*$/m,
  "maps recovery conflicts to HTTP 409"
);

assert.match(
  source,
  /^\s*STAKE_INTENT_RECOVERY_READ_FAILED:\s*500,\s*$/m,
  "maps recovery read failures to HTTP 500"
);

// --------------------------------------------------
// RESULT
// --------------------------------------------------

console.log(JSON.stringify({
  result: "PASS",
  checks: 15,
  network: "testnet",
  database_writes: false,
  payment_launched: false,
  recovery_conflict_status: 409,
  recovery_read_failed_status: 500
}, null, 2));
