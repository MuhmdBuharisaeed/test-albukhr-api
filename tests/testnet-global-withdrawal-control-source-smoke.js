'use strict';

// Static source-contract checks. No Supabase/network calls and no database writes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261115090000_testnet_global_withdrawal_control_v1.sql'),
  'utf8'
);
const postflight = fs.readFileSync(
  path.join(root, 'tests/testnet-global-withdrawal-control-postflight.sql'),
  'utf8'
);

const checks = [];
function check(label, fn) {
  fn();
  checks.push(label);
}

check('Migration is explicitly Testnet-only', () => {
  assert.match(migration, /TESTNET ONLY/i);
  assert.match(migration, /network = 'testnet'/);
  assert.doesNotMatch(migration, /network\s*=\s*'mainnet'/i);
});

check('Adds an independent default-disabled withdrawal flag', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS withdrawal_enabled boolean NOT NULL DEFAULT false/i);
  assert.match(migration, /withdrawal_enabled = p_enabled/);
  assert.doesNotMatch(migration, /SET active\s*=\s*p_enabled/i);
  assert.doesNotMatch(migration, /SET staking_policy_active\s*=\s*p_enabled/i);
});

check('Audit constraint accepts withdrawals without removing existing controls', () => {
  assert.match(migration, /control IN \('treasury', 'staking', 'withdrawals'\)/);
  assert.match(migration, /'control', 'withdrawals'/);
  assert.match(migration, /p_control NOT IN \('treasury', 'staking', 'withdrawals'\)/);
});

check('Staker and Project Owner new-request RPCs call the shared lock guard', () => {
  assert.match(migration, /patch_staker_create/);
  assert.match(migration, /patch_owner_create/);
  assert.match(migration, /PERFORM public\.assert_testnet_global_withdrawals_enabled\(\)/);
});

check('New fee assessments are blocked but previously-created assessments are returned first', () => {
  assert.match(migration, /RETURN v_existing;[\s\S]*?PERFORM public\.assert_testnet_global_withdrawals_enabled\(\)/);
});

check('All new payout claims are atomic and service-role-only', () => {
  assert.match(migration, /claim_testnet_withdrawal/);
  assert.match(migration, /claim_testnet_project_owner_withdrawal/);
  assert.match(migration, /claim_testnet_admin_withdrawal/);
  assert.match(migration, /FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /TO service_role/);
});

check('Database triggers protect direct Testnet inserts and transitions into processing', () => {
  assert.match(migration, /BEFORE INSERT OR UPDATE OF status[\s\S]*?ON public\.withdrawal_requests/);
  assert.match(migration, /BEFORE INSERT OR UPDATE OF status[\s\S]*?ON public\.project_owner_withdrawals/);
  assert.match(migration, /NEW\.status = 'processing'[\s\S]*?OLD\.status IS DISTINCT FROM 'processing'/);
});

check('Settlement and payment-recovery paths are not patched or blocked', () => {
  assert.doesNotMatch(migration, /CREATE OR REPLACE FUNCTION public\.(mark_testnet_outflow_fee_paid|complete_testnet_withdrawal_and_ledger|complete_testnet_project_owner_withdrawal)/i);
  assert.match(migration, /already-processing rows \(A2U IDs, TXIDs, completion\/settlement\) are[\s\S]*?not blocked/i);
  assert.match(migration, /Pausing is always permitted[\s\S]*?reconciliation[\s\S]*?settlement remain available/i);
});

check('Global withdrawals control checks Treasury, Pi API, payout wallet and fee rails before enabling', () => {
  assert.match(migration, /v_policy\.active IS DISTINCT FROM true/);
  assert.match(migration, /p_pi_api_configured IS DISTINCT FROM true/);
  assert.match(migration, /p_payout_wallet_configured IS DISTINCT FROM true/);
  assert.match(migration, /GLOBAL_TREASURY_WALLET_MISMATCH/);
  assert.match(migration, /testnet_outflow_fee_assessments/);
  assert.match(migration, /testnet_platform_fee_ledger/);
});

check('No Mainnet policy/table/function is altered', () => {
  assert.doesNotMatch(migration, /ALTER TABLE public\.mainnet_/i);
  assert.doesNotMatch(migration, /UPDATE public\.mainnet_/i);
  assert.doesNotMatch(migration, /CREATE OR REPLACE FUNCTION public\.mainnet_/i);
});

check('Postflight script contains only read-only SELECT statements', () => {
  assert.match(postflight, /^SELECT/m);
  assert.doesNotMatch(postflight, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i);
});

console.log(JSON.stringify({
  suite: 'testnet-global-withdrawal-control-source-smoke',
  result: 'PASS',
  assertions: checks.length,
  checks,
  network_calls: false,
  database_writes: false
}, null, 2));
