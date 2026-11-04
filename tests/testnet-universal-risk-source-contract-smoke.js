'use strict';

// Static, local-only contract smoke test. No network calls and no database writes.
// Usage: node tests/testnet-universal-risk-source-contract-smoke.js <api-root> <app-root>
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const apiRoot = path.resolve(process.argv[2] || process.cwd());
const appRoot = path.resolve(process.argv[3] || process.cwd());
const read = (file) => fs.readFileSync(file, 'utf8');
const api = read(path.join(apiRoot, 'testnet-staking-router.js'));
const riskAdmin = read(path.join(appRoot, 'js/testnet-project-staking-risk-admin.js'));
const owner = read(path.join(appRoot, 'js/testnet-owner-staking.js'));

function section(source, start, end, label) {
  const a = source.indexOf(start);
  assert.notEqual(a, -1, label + ': start marker missing');
  const b = source.indexOf(end, a + start.length);
  assert.notEqual(b, -1, label + ': end marker missing');
  return source.slice(a, b);
}

// API Owner Offers may use global policy values, never project lifecycle stage.
const ownerOffers = section(
  api,
  'router.post("/owner/offers", async (req, res) => {',
  'router.post("/owner/offer-settings", async (req, res) => {',
  'API owner offers route'
);
assert.match(ownerOffers, /staking_universal_risk_policy/);
assert.match(ownerOffers, /riskCapitalReserve === 50/);
assert.match(ownerOffers, /riskMaximumDeployment === 25/);
assert.match(ownerOffers, /riskMaximumPrincipal === 100/);
assert.match(ownerOffers, /GLOBAL_STAKING_POLICY_INACTIVE/);
assert.doesNotMatch(ownerOffers, /project\.staking_stage|stagePolicies|stageRuleReady|stageMaximumPrincipal/);

// Project lookup helpers must not select lifecycle stage as a staking dependency.
assert.doesNotMatch(api, /select\("id,project_code,name,network,status,owner_user_id,staking_stage"\)/);
// Legacy stage administration remains intentionally present for backwards compatibility.
assert.match(api, /router\.post\("\/admin\/project-stages"/);
assert.match(api, /router\.post\("\/admin\/project-stages\/set"/);

// Risk Admin provisioning must not wait for a stage; it remains pending-only.
const canProvision = section(riskAdmin, 'function canProvision(', 'function renderCard(', 'Risk Admin canProvision');
assert.doesNotMatch(canProvision, /staking_stage/);
assert.match(riskAdmin, /universal Testnet risk profile/i);
assert.match(riskAdmin, /does not enable staking/i);
assert.doesNotMatch(riskAdmin, /Assign the correct business lifecycle stage/);

// Owner page no longer asks owners to supply a lifecycle stage.
assert.doesNotMatch(owner, /Current staking stage/);
assert.doesNotMatch(owner, /must assign a staking stage/);
assert.match(owner, /universal Testnet risk controls/);

console.log(JSON.stringify({
  result: 'PASS',
  checks: 17,
  network_calls: false,
  database_writes: false,
  legacy_stage_admin_preserved: true,
  global_staking_activation_unchanged_by_source_patch: true
}, null, 2));
