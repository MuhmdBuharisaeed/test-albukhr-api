"use strict";

// Static contract test for the Testnet payment-evidence hardening migration.
// Run from test-albukhr-api repository root:
// node tests/testnet-stake-payment-finalization-evidence-regression.test.cjs

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const migrationPath = path.join(
  __dirname, "..", "supabase", "migrations",
  "20261111140000_testnet_stake_payment_finalization_evidence_guard_v1.sql"
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
assert.match(sql, /CREATE UNIQUE INDEX testnet_stake_payments_network_txid_uidx\s+ON public\.testnet_stake_payments\s*\(network,txid\)/);
assert.match(sql, /verification_status\s*<>\s*'verified'[\s\S]*?pi_status IS NOT DISTINCT FROM 'completed'[\s\S]*?verified_at IS NOT NULL[\s\S]*?verification_reference[\s\S]*?recipient_wallet/);
assert.match(sql, /v_patched_definition:=replace\(v_definition,v_payment_guard,v_payment_guard\|\|v_evidence_guard\)/);
assert.match(sql, /length\(v_definition\)-length\(replace\(v_definition,v_payment_guard,''\)\)<>length\(v_payment_guard\)/);
assert.match(sql, /EXECUTE v_patched_definition/);
assert.doesNotMatch(sql, /UPDATE\s+public\.(stakes|testnet_stake_intents|testnet_stake_payments|project_staking_ledger)\b/i);
assert.doesNotMatch(sql, /UPDATE\s+public\.testnet_global_treasury_policy/i);

console.log(JSON.stringify({
  result: "PASS",
  checks: required.length + 6,
  migration: path.basename(migrationPath),
  scope: "Testnet payment evidence, recipient binding, and TXID uniqueness",
  historical_rows_updated: false,
  global_activation_changed: false,
  Pi_payments_submitted: false
}, null, 2));
