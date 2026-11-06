'use strict';

// Source-contract checks only. This test makes no network calls and no database writes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'api/testnet-global-transaction-control-router.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'frontend/testnet-global-transaction-control-admin.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261106070000_testnet_global_transaction_controls_v1.sql'), 'utf8');
const serverPatch = fs.readFileSync(path.join(root, 'patches/server-js-integration.patch'), 'utf8');
const stakingRouterPatch = fs.readFileSync(path.join(root, 'patches/testnet-staking-router.js.patch'), 'utf8');
const dashboardPatch = fs.readFileSync(path.join(root, 'patches/admin-dashboard.html.patch'), 'utf8');

const checks = [];
function check(label, fn) {
  fn();
  checks.push(label);
}

check('API routes are Testnet-scoped', () => {
  assert.match(api, /const NETWORK = "testnet"/);
  assert.match(api, /\.eq\("network", NETWORK\)/);
});
check('Admin session is network-scoped and checks revocation/expiry', () => {
  assert.match(api, /\.eq\("session_hash", hashToken\(token\)\)/);
  assert.match(api, /\.eq\("network", NETWORK\)/);
  assert.match(api, /data\.revoked_at/);
  assert.match(api, /data\.expires_at/);
});
check('Only Super Admin can access global controls', () => {
  assert.match(api, /roles\.includes\("super_admin"\)/);
  assert.match(api, /GLOBAL_TRANSACTION_CONTROL_SUPER_ADMIN_REQUIRED/);
});
check('Treasury activation requires a validated Testnet payout keypair', () => {
  assert.match(api, /PAYOUT_WALLET_CONFIGURED/);
  assert.match(api, /payoutWalletConfigured = false/);
  assert.match(api, /const PAYOUT_WALLET_CONFIGURED = payoutWalletConfigured === true/);
  assert.match(migration, /GLOBAL_TREASURY_PAYOUT_WALLET_NOT_READY/);
  assert.match(serverPatch, /StellarSdk\.Keypair\.fromSecret/);
  assert.match(serverPatch, /payoutKeypair\.publicKey\(\) === CONFIGURED_TESTNET_APP_WALLET/);
});
check('Browser routes are read and write allowlisted', () => {
  assert.match(ui, /"\/admin\/global-controls"/);
  assert.match(ui, /"\/admin\/global-controls\/enablement"/);
});
check('Browser sends no Supabase direct writes', () => {
  assert.doesNotMatch(ui, /supabase\.from|supabase\.rpc/);
  assert.match(ui, /x-testnet-admin-session/);
});
check('Global Treasury and Global Staking are independent controls', () => {
  assert.match(api, /control === "treasury"/);
  assert.match(api, /control === "staking"/);
  assert.match(ui, /Global Treasury/);
  assert.match(ui, /Global Staking Policy/);
});
check('Treasury cannot be disabled while global staking remains active', () => {
  assert.match(api, /GLOBAL_STAKING_MUST_BE_PAUSED_BEFORE_TREASURY/);
  assert.match(migration, /GLOBAL_STAKING_MUST_BE_PAUSED_BEFORE_TREASURY/);
});
check('Treasury cannot be disabled while Testnet liabilities or withdrawals remain outstanding', () => {
  assert.match(migration, /GLOBAL_TREASURY_OUTSTANDING_OBLIGATIONS/);
  assert.match(migration, /outstanding_principal/);
  assert.match(migration, /public\.withdrawal_requests/);
  assert.match(migration, /public\.project_owner_withdrawals/);
});
check('Staking activation requires active Treasury', () => {
  assert.match(migration, /v_policy\.active IS DISTINCT FROM true/);
  assert.match(migration, /GLOBAL_TREASURY_NOT_READY/);
});
check('Database RPC requires service_role and a live Super Admin session', () => {
  assert.match(migration, /auth\.role\(\).*service_role/s);
  assert.match(migration, /'super_admin' = ANY\(roles\)/);
  assert.match(migration, /revoked_at IS NULL/);
  assert.match(migration, /expires_at > now\(\)/);
});
check('Database activation validates approved Universal Risk profile', () => {
  assert.match(migration, /capital_reserve_percent/);
  assert.match(migration, /maximum_deployment_percent/);
  assert.match(migration, /max_active_principal/);
  assert.match(migration, /v_expected_rates/);
  assert.match(migration, /v_expected_durations/);
});
check('Database activation validates a ready approved project and offers', () => {
  assert.match(migration, /p\.status = 'approved'/);
  assert.match(migration, /c\.staking_enabled IS TRUE/);
  assert.match(migration, /c\.approval_status = 'approved'/);
  assert.match(migration, /o\.active IS TRUE/);
  assert.match(migration, /o\.reward_rate <=/);
});
check('Database activation validates liquidity coverage and pending intents', () => {
  assert.match(migration, /get_testnet_staking_coverage/);
  assert.match(migration, /cv\.total_tracked_assets >= cv\.total_liability/);
  assert.match(migration, /cv\.reward_reserve_balance >=/);
  assert.match(migration, /GLOBAL_STAKING_PENDING_INTENTS_EXIST/);
});
check('Database enforces the 25% maximum-deployment limit for each stake intent', () => {
  assert.match(migration, /guard_testnet_stake_intent_universal_deployment/);
  assert.match(migration, /v_existing_principal \+ v_new_amount > v_deployment_limit/);
  assert.match(migration, /TESTNET_STAKING_MAX_DEPLOYMENT_EXCEEDED/);
  assert.match(api, /testnet_global_transaction_control_guard_status/);
  assert.match(api, /deploymentGuardReady/);
  assert.match(stakingRouterPatch, /TESTNET_STAKING_MAX_DEPLOYMENT_EXCEEDED/);
});
check('Global state changes write an audit record', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.testnet_global_transaction_control_audit/);
  assert.match(migration, /INSERT INTO public\.testnet_global_transaction_control_audit/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});
check('Global activation RPC is not executable by public browser roles', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.set_testnet_global_transaction_control/);
  assert.match(migration, /TO service_role/);
  assert.match(migration, /p_payout_wallet_configured/);
  assert.match(api, /p_payout_wallet_configured: PAYOUT_WALLET_CONFIGURED/);
});
check('UI confirms actions and requires an audit reason', () => {
  assert.match(ui, /window\.confirm/);
  assert.match(ui, /window\.prompt/);
  assert.match(ui, /reason\.length < 10/);
});
check('UI enforces the official Testnet hostname', () => {
  assert.match(ui, /test\.albukhr\.com/);
  assert.match(ui, /env\.isTestnet\(\)/);
});
check('Server integration mounts additive router under /staking', () => {
  assert.match(serverPatch, /createTestnetGlobalTransactionControlRouter/);
  assert.match(serverPatch, /"\/staking"/);
});
check('Dashboard loads new control panel script after existing risk admin', () => {
  assert.match(dashboardPatch, /testnet-project-staking-risk-admin\.js/);
  assert.match(dashboardPatch, /testnet-global-transaction-control-admin\.js/);
});

console.log(JSON.stringify({
  suite: 'testnet-global-transaction-controls-smoke',
  assertions: checks.length,
  checks,
  network_calls: false,
  database_writes: false,
  result: 'PASS'
}, null, 2));
