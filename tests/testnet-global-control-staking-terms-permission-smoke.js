'use strict';

// Read-only source-contract regression test. No network or database calls.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const migrationPath = path.join(
  root,
  'supabase/migrations/20261107152538_testnet_global_control_staking_terms_minimal_read_v1.sql'
);
const globalRouterPath = path.join(root, 'testnet-global-transaction-control-router.js');
const stakingRouterPath = path.join(root, 'testnet-staking-router.js');

const migration = fs.readFileSync(migrationPath, 'utf8');
const globalRouter = fs.readFileSync(globalRouterPath, 'utf8');
const stakingRouter = fs.readFileSync(stakingRouterPath, 'utf8');

const checks = [];
function check(label, fn) {
  fn();
  checks.push(label);
}

check('Migration grants only the six backend-required columns to service_role', () => {
  assert.match(
    migration,
    /GRANT SELECT\s*\(\s*project_code,\s*duration_days,\s*min_stake,\s*reward_rate,\s*active,\s*network\s*\)\s*ON TABLE public\.project_staking_terms TO service_role;/s
  );
  assert.doesNotMatch(migration, /GRANT SELECT ON TABLE public\.project_staking_terms TO service_role/i);
});

check('Migration does not grant SELECT to browser/public roles', () => {
  assert.doesNotMatch(migration, /GRANT[^;]*\bTO\s+(PUBLIC|anon|authenticated)\b/i);
  assert.match(migration, /has_column_privilege\('anon'/);
  assert.match(migration, /has_column_privilege\('authenticated'/);
});

check('Migration preserves RLS and validates it before granting', () => {
  assert.match(migration, /relrowsecurity/);
  assert.match(migration, /RLS must remain enabled/);
  assert.doesNotMatch(migration, /ALTER TABLE public\.project_staking_terms\s+(DISABLE|NO FORCE)/i);
  assert.doesNotMatch(migration, /CREATE POLICY|DROP POLICY/i);
});

check('Migration is permission-only and does not activate Global Staking', () => {
  assert.doesNotMatch(migration, /UPDATE\s+public\.testnet_global_treasury_policy/i);
  assert.doesNotMatch(migration, /staking_policy_active\s*=/i);
  assert.doesNotMatch(migration, /INSERT INTO public\.project_staking_terms/i);
  assert.doesNotMatch(migration, /UPDATE\s+public\.project_staking_terms/i);
  assert.doesNotMatch(migration, /DELETE FROM public\.project_staking_terms/i);
});

check('Global Controls API selects only the granted columns and filters Testnet', () => {
  assert.match(globalRouter, /from\("project_staking_terms"\)/);
  assert.match(globalRouter, /select\("project_code,duration_days,min_stake,reward_rate,active,network"\)/);
  assert.match(globalRouter, /\.eq\("network", NETWORK\)/);
  assert.match(globalRouter, /\.eq\("active", true\)/);
});

check('Staking offer API selects only permitted offer columns and filters Testnet', () => {
  assert.match(stakingRouter, /from\("project_staking_terms"\)/);
  assert.match(stakingRouter, /select\("duration_days,min_stake,reward_rate,active"\)/);
  assert.match(stakingRouter, /\.eq\("network", NETWORK\)/);
});

console.log(JSON.stringify({
  suite: 'testnet-global-control-staking-terms-permission-smoke',
  assertions: checks.length,
  checks,
  network_calls: false,
  database_writes: false,
  result: 'PASS'
}, null, 2));
