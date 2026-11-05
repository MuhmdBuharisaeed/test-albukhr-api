'use strict';

// Static, local-only source contract test. No network calls and no DB writes.
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
const adminHtml = read(path.join(appRoot, 'admin-dashboard.html'));
const ownerHtml = read(path.join(appRoot, 'project-owner.html'));

function section(source, start, end, label) {
  const a = source.indexOf(start);
  assert.notEqual(a, -1, label + ': start marker missing');
  const b = source.indexOf(end, a + start.length);
  assert.notEqual(b, -1, label + ': end marker missing');
  return source.slice(a, b);
}

// Owner offers use the universal global profile; project lifecycle stage is not an eligibility input.
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

// Project lookup helpers must not select the lifecycle stage for owner staking.
assert.doesNotMatch(api, /select\("id,project_code,name,network,status,owner_user_id,staking_stage"\)/);

// Legacy stage administration remains available for backwards compatibility.
assert.match(api, /router\.post\("\/admin\/project-stages"/);
assert.match(api, /router\.post\("\/admin\/project-stages\/set"/);

// Provisioning maps universal risk errors; it no longer translates them as missing stage.
const provision = section(
  api,
  'router.post("/admin/policy/provision", async (req, res) => {',
  'router.post("/admin/policy/review", async (req, res) => {',
  'Admin provision route'
);
assert.match(provision, /GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED/);
assert.match(provision, /GLOBAL_UNIVERSAL_RISK_POLICY_INVALID/);
assert.match(provision, /GLOBAL_UNIVERSAL_RISK_POLICY_MUST_MATCH_APPROVED_LIMITS/);
assert.doesNotMatch(provision, /PROJECT_STAKING_STAGE_REQUIRED/);

// Owner offer update maps the complete universal-risk validation error set.
const ownerOfferUpdate = section(
  api,
  'router.post("/owner/offer-settings", async (req, res) => {',
  'router.post("/intent", async (req, res) => {',
  'Owner offer update route'
);
assert.match(ownerOfferUpdate, /GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED/);
assert.match(ownerOfferUpdate, /GLOBAL_UNIVERSAL_RISK_POLICY_INVALID/);
assert.match(ownerOfferUpdate, /GLOBAL_UNIVERSAL_RISK_POLICY_MUST_MATCH_APPROVED_LIMITS/);
assert.doesNotMatch(ownerOfferUpdate, /PROJECT_STAKING_STAGE_REQUIRED/);

// Risk Admin provisioning has no stage gate and remains pending/review-only.
const canProvision = section(riskAdmin, 'function canProvision(', 'function renderCard(', 'Risk Admin canProvision');
assert.doesNotMatch(canProvision, /staking_stage/);
assert.match(riskAdmin, /universal Testnet risk profile/i);
assert.match(riskAdmin, /does not enable staking/i);
assert.doesNotMatch(riskAdmin, /Assign the correct business lifecycle stage/);

// Owner UI no longer asks for a lifecycle stage.
assert.doesNotMatch(owner, /Current staking stage/);
assert.doesNotMatch(owner, /must assign a staking stage/);
assert.match(owner, /universal Testnet risk controls/);

// Browser cache-busters must change with the patched scripts.
assert.match(adminHtml, /testnet-project-staking-risk-admin\.js\?v=20261104-universal-risk-v1/);
assert.match(ownerHtml, /testnet-owner-staking\.js\?v=20261104-universal-risk-v1/);

// The source patch must not turn on global or project staking.
assert.doesNotMatch(api, /staking_policy_active\s*=\s*true/);
assert.match(api, /router\.post\("\/admin\/policy\/enablement"/);

console.log(JSON.stringify({
  result: 'PASS',
  checks: 29,
  network_calls: false,
  database_writes: false,
  legacy_stage_admin_preserved: true,
  stage_is_not_staking_eligibility: true,
  universal_policy_error_mapping: true,
  cache_busting_updated: true,
  global_staking_activation_unchanged_by_source_patch: true
}, null, 2));
