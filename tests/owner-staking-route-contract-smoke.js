'use strict';

// Static source-contract smoke test. Run from the Testnet API repository root.
// It reads source only; it makes no network calls and performs no database writes.
const fs = require('node:fs');
const assert = require('node:assert/strict');

const source = fs.readFileSync('testnet-staking-router.js', 'utf8');
function has(label, pattern) {
  assert.match(source, pattern, 'Missing Testnet Owner Offers contract: ' + label);
}

has('Owner lookup selects project staking stage', /async function getOwnedProject[\s\S]{0,500}staking_stage/);
has('owner session is verified before project read', /router\.post\("\/owner\/offers", async \(req, res\) => \{[\s\S]{0,350}getTestnetSession\(req\)/);
has('owner must own the approved Testnet project', /getOwnedProject\([\s\S]{0,250}session/);
has('global policy reads are network-scoped', /from\("testnet_global_treasury_policy"\)[\s\S]{0,500}\.eq\("network", NETWORK\)/);
has('coverage is read through the guarded RPC', /get_testnet_staking_coverage/);
has('owner config and investor staking are separate gates', /can_configure[\s\S]{0,800}can_stake/);
has('offer write uses the database RPC', /update_testnet_project_staking_offer/);
has('risk approval errors are preserved', /STAKING_POLICY_NOT_APPROVED/);
has('stale risk-policy errors are preserved', /STAKING_POLICY_REVIEW_STALE/);

console.log(JSON.stringify({
  structural_checks: 9,
  source: 'testnet-staking-router.js',
  network_calls: false,
  database_writes: false,
  result: 'PASS'
}, null, 2));
