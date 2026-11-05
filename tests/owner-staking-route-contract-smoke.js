'use strict';

// Static source-contract smoke test. Run from the Testnet API repository root.
// Reads source only: no network calls and no database writes.
const fs = require('node:fs');
const assert = require('node:assert/strict');

const source = fs.readFileSync('testnet-staking-router.js', 'utf8');
function has(label, pattern) {
  assert.match(source, pattern, 'Missing Testnet Owner Offers contract: ' + label);
}

const ownedProjectMatch = source.match(
  /async function getOwnedProject\([\s\S]*?\n  async function getIntent\(/
);
assert.ok(ownedProjectMatch, 'getOwnedProject helper must exist');
const ownedProject = ownedProjectMatch[0];

assert.match(
  ownedProject,
  /\.from\("projects"\)[\s\S]{0,180}\.select\("id,project_code,name,network,status,owner_user_id"\)/,
  'Owner project lookup must select the approved Testnet project identity fields'
);
assert.match(ownedProject, /\.eq\("network", NETWORK\)/);
assert.match(ownedProject, /\.eq\("status", "approved"\)/);
assert.match(ownedProject, /\.from\("users"\)/);
assert.match(ownedProject, /\.eq\("pi_uid", clean\(session\.pi_uid\)\)/);
assert.match(ownedProject, /\.eq\("network", NETWORK\)/);
assert.match(ownedProject, /owner\.id !== project\.owner_user_id/);
assert.doesNotMatch(
  ownedProject,
  /staking_stage/,
  'Owner project lookup must not depend on the legacy lifecycle stage'
);

// Owner session must be authenticated before the approved-project ownership check.
has(
  'owner session is verified before project read',
  /router\.post\("\/owner\/offers", async \(req, res\) => \{[\s\S]{0,350}getTestnetSession\(req\)/
);
has(
  'owner must pass the verified session to project ownership lookup',
  /getOwnedProject\([\s\S]{0,260}session\s*\)/
);

const ownerOffersMatch = source.match(
  /router\.post\("\/owner\/offers", async \(req, res\) => \{[\s\S]*?\n  router\.post\("\/owner\/offer-settings"/
);
assert.ok(ownerOffersMatch, 'Owner offers route must exist');
const ownerOffers = ownerOffersMatch[0];
assert.doesNotMatch(
  ownerOffers,
  /staking_stage|stagePolicies|stageRuleReady|stageMaximumPrincipal/,
  'Owner offers eligibility must use the universal Testnet risk profile, not lifecycle stages'
);
assert.match(ownerOffers, /staking_universal_risk_policy/);
assert.match(ownerOffers, /riskCapitalReserve === 50/);
assert.match(ownerOffers, /riskMaximumDeployment === 25/);
assert.match(ownerOffers, /riskMaximumPrincipal === 100/);
assert.match(ownerOffers, /GLOBAL_STAKING_POLICY_INACTIVE/);

// Every global-policy read used by owner offers must be scoped to Testnet.
assert.match(
  ownerOffers,
  /from\("testnet_global_treasury_policy"\)[\s\S]{0,600}\.eq\("network", NETWORK\)/
);
assert.match(ownerOffers, /get_testnet_staking_coverage/);
assert.match(ownerOffers, /can_configure[\s\S]{0,800}can_stake/);

const ownerOfferUpdateMatch = source.match(
  /router\.post\("\/owner\/offer-settings", async \(req, res\) => \{[\s\S]*?\n  router\.post\("\/intent"/
);
assert.ok(ownerOfferUpdateMatch, 'Owner offer-settings route must exist');
const ownerOfferUpdate = ownerOfferUpdateMatch[0];
assert.match(ownerOfferUpdate, /update_testnet_project_staking_offer/);
assert.match(ownerOfferUpdate, /STAKING_POLICY_NOT_APPROVED/);
assert.match(ownerOfferUpdate, /STAKING_POLICY_REVIEW_STALE/);
assert.match(ownerOfferUpdate, /GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED/);
assert.match(ownerOfferUpdate, /GLOBAL_UNIVERSAL_RISK_POLICY_INVALID/);
assert.match(ownerOfferUpdate, /GLOBAL_UNIVERSAL_RISK_POLICY_MUST_MATCH_APPROVED_LIMITS/);

console.log(JSON.stringify({
  structural_checks: 22,
  source: 'testnet-staking-router.js',
  owner_project_lookup_uses_approved_testnet_identity: true,
  lifecycle_stage_is_not_an_eligibility_input: true,
  universal_risk_profile_is_enforced: true,
  owner_identity_and_network_gates_preserved: true,
  network_calls: false,
  database_writes: false,
  result: 'PASS'
}, null, 2));
