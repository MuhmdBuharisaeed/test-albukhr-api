'use strict';

// Run from test-albukhr-api repository root:
// node tests/testnet-stake-intent-recovery-smoke.js
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('testnet-staking-router.js', 'utf8');

const startToken = 'router.post("/pending", async (req, res) => {';
const endToken = 'router.post("/intent", async (req, res) => {';
const start = source.indexOf(startToken);
assert.ok(start >= 0, 'pending recovery route exists');
const end = source.indexOf(endToken, start + startToken.length);
assert.ok(end > start, 'pending recovery route ends before intent creation route');
const route = source.slice(start, end);

assert.match(route, /getTestnetSession\(req\)/, 'requires validated Testnet session');
assert.match(route, /session\s*&&\s*session\.pi_uid/, 'uses session-bound Pi UID');
assert.match(route, /\.eq\("network", NETWORK\)/, 'filters Testnet network');
assert.match(route, /\.eq\("pi_uid", piUid\)/, 'filters authenticated owner');
assert.match(route, /\.eq\("project_id", projectId\)/, 'filters project ID');
assert.match(route, /\.eq\("project_code", projectCode\)/, 'filters project code');
assert.match(route, /\.eq\("status", "pending_payment"\)/, 'returns only pending intents');
assert.match(route, /\.limit\(2\)/, 'detects ambiguous duplicate pending intents');
assert.match(route, /STAKE_INTENT_RECOVERY_CONFLICT/, 'fails closed on ambiguous results');
assert.match(route, /payment_armed:\s*metadata\.payment_started\s*===\s*true/, 'returns only armed boolean');
assert.doesNotMatch(route, /\.update\(|\.insert\(|\.delete\(/, 'endpoint is read-only');
assert.doesNotMatch(route, /metadata:\s*row\.metadata/, 'does not expose raw metadata');
assert.doesNotMatch(route, /pi_uid:\s*row\.pi_uid/, 'does not expose Pi UID');

console.log(JSON.stringify({
  result: 'PASS',
  recovery_route: true,
  testnet_isolation: true,
  session_owner_filter: true,
  database_writes: false,
  payment_launched: false
}, null, 2));
