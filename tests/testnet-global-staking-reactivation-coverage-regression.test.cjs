'use strict';

// Static contract test for the additive Testnet global staking reactivation
// migration. Run from the test-albukhr-api repository root:
// node tests/testnet-global-staking-reactivation-coverage-regression.test.cjs

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const migrationPath = path.join(
  __dirname,
  '..',
  'supabase',
  'migrations',
  '20261111130000_testnet_global_staking_activation_coverage_alignment_v1.sql'
);
const sql = fs.readFileSync(migrationPath, 'utf8');

const required = [
  'BEGIN;',
  'COMMIT;',
  'public.set_testnet_global_transaction_control(uuid,text,boolean,text,text,boolean,boolean)',
  'pg_get_functiondef(p.oid)',
  'cv.owner_liquidity_available >= v_policy.minimum_project_liquidity',
  'coalesce(cv.verified_liquidity_contributed, 0) >= t.required_liquidity',
  'cv.liquidity_buffer >= v_policy.minimum_project_liquidity',
  'cv.total_tracked_assets >= cv.total_liability',
  'cv.reward_reserve_balance >=',
  "p.status = ''approved''",
  'c.staking_enabled IS TRUE',
  "c.approval_status = ''approved''",
  'c.capital_reserve_percent = 50',
  'c.maximum_deployment_percent = 25',
  'c.max_active_principal = 100',
  'o.duration_days = ANY(v_policy.allowed_duration_days)',
  'v_before_treasury_active',
  'v_before_staking_active',
  'v_after_treasury_active',
  'v_after_staking_active',
  "has_function_privilege('anon'",
  "has_function_privilege('authenticated'",
  "has_function_privilege('service_role'",
  'SECURITY DEFINER',
  'search_path=""'
];

for (const fragment of required) {
  assert.ok(sql.includes(fragment), `Missing migration safeguard: ${fragment}`);
}

assert.match(
  sql,
  /v_patched_definition\s*:=\s*replace\(v_definition,\s*v_old_line,\s*''\)/,
  'Migration must replace only the exact owner-liquidity line'
);

assert.match(
  sql,
  /length\(v_definition\)\s*-\s*length\(replace\(v_definition,\s*v_old_line,\s*''\)\)\s*<>\s*length\(v_old_line\)/,
  'Migration must fail closed unless the exact target line occurs once'
);

assert.match(
  sql,
  /EXECUTE\s+v_patched_definition/,
  'Migration must execute the patched live function definition'
);

assert.doesNotMatch(
  sql,
  /UPDATE\s+public\.testnet_global_treasury_policy/i,
  'Migration must not update global activation policy rows'
);

assert.doesNotMatch(
  sql,
  /INSERT\s+INTO\s+public\.testnet_global_transaction_control_audit/i,
  'Migration must not create an activation audit event'
);

assert.doesNotMatch(
  sql,
  /UPDATE\s+public\.(projects|project_treasury|stakes|testnet_stake_intents)\b/i,
  'Migration must not mutate project, treasury, stake, or intent records'
);

console.log(JSON.stringify({
  result: 'PASS',
  checks: required.length + 6,
  migration: path.basename(migrationPath),
  scope: 'Testnet global staking activation predicate only',
  global_flags_changed: false,
  project_or_stake_rows_changed: false,
  payment_submitted: false
}, null, 2));
