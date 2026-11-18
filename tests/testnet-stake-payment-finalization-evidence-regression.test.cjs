"use strict";

// Static regression test for Testnet verified payment evidence preservation.
// Run from test-albukhr-api repository root:
// node tests/testnet-stake-payment-finalization-evidence-regression.test.cjs

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const migrationPath = path.join(
  __dirname, "..", "supabase", "migrations",
  "20261111134212_testnet_stake_payment_finalization_evidence_guard_v1.sql"
);
const sql = fs.readFileSync(migrationPath, "utf8");

const required = [
  "BEGIN;", "COMMIT;",
  "public.finalize_testnet_stake_intent(uuid,text,text)",
  "v_payment.recipient_wallet", "v_payment.txid", "v_payment.verified_at",
  "v_payment.verification_reference", "v_payment.metadata",
  "public.project_treasury", "public.testnet_global_treasury_policy", "public.users",
  "VERIFIED_PAYMENT_EVIDENCE_INVALID", "SET search_path TO ''", "RETURNS public.stakes",
  "has_function_privilege('anon'", "has_function_privilege('authenticated'",
  "has_function_privilege('service_role'",
  "testnet_stake_payments_verified_evidence_check",
  "testnet_stake_payments_network_txid_uidx"
];

for (const fragment of required) {
  assert.ok(sql.includes(fragment), `Missing payment evidence guard: ${fragment}`);
}

assert.match(
  sql,
  /CREATE UNIQUE INDEX testnet_stake_payments_network_txid_uidx\s+ON public\.testnet_stake_payments\s*\(network,txid\)/
);
assert.match(
  sql,
  /verification_status\s*<>\s*'verified'[\s\S]*?pi_status IS NOT DISTINCT FROM 'completed'[\s\S]*?verified_at IS NOT NULL[\s\S]*?verification_reference[\s\S]*?recipient_wallet/
);
assert.match(
  sql,
  /v_patched_definition:=replace\(v_definition,v_payment_guard,v_payment_guard\|\|v_evidence_guard\)/
);
assert.match(
  sql,
  /length\(v_definition\)-length\(replace\(v_definition,v_payment_guard,''\)\)<>length\(v_payment_guard\)/
);
assert.match(sql, /EXECUTE v_patched_definition/);
assert.doesNotMatch(
  sql,
  /UPDATE\s+public\.(stakes|testnet_stake_intents|testnet_stake_payments|project_staking_ledger)\b/i
);
assert.doesNotMatch(sql, /UPDATE\s+public\.testnet_global_treasury_policy/i);

// The API must preserve an already-verified record instead of replacing its
// TXID, recipient wallet, verification timestamp/reference, or metadata.
const routerPath = path.join(__dirname, "..", "testnet-staking-router.js");
const router = fs.readFileSync(routerPath, "utf8");

assert.match(
  router,
  /^\s*STAKE_PAYMENT_EVIDENCE_CONFLICT:\s*409,\s*$/m,
  "maps evidence conflicts to HTTP 409"
);

const writerStartToken = "  async function writeVerifiedPayment(";
const writerStart = router.indexOf(writerStartToken);
assert.ok(writerStart >= 0, "writeVerifiedPayment helper exists");

const writerEndMarker = "// TESTNET ADMIN — GLOBAL STAKING PROJECT STAGES";
const writerEnd = router.indexOf(writerEndMarker, writerStart + writerStartToken.length);
assert.ok(writerEnd > writerStart, "writeVerifiedPayment helper has a clear end boundary");

const writer = router.slice(writerStart, writerEnd);

const requiredWriterFragments = [
  '.select("*")',
  'existing.verification_status === "verified"',
  "validateVerifiedPaymentRecord",
  "STAKE_PAYMENT_EVIDENCE_CONFLICT",
  "verification_reference",
  "metadata",
  '.or("verification_status.is.null,verification_status.neq.verified")',
  '.is("txid", null)',
  "return existing;"
];

for (const fragment of requiredWriterFragments) {
  assert.ok(
    writer.includes(fragment),
    `Payment writer is missing evidence-preservation behavior: ${fragment}`
  );
}

assert.doesNotMatch(
  writer,
  /\.update\(payload\)\.eq\("id",\s*existing\.id\)/,
  "must not blindly overwrite a pre-existing payment row with the new payload"
);

console.log(JSON.stringify({
  result: "PASS",
  checks: required.length + 16,
  migration: path.basename(migrationPath),
  api_helper: "writeVerifiedPayment",
  scope: "Testnet verified payment evidence preservation",
  verified_rows_overwritten: false,
  historical_rows_updated: false,
  global_activation_changed: false,
  Pi_payments_submitted: false
}, null, 2));
