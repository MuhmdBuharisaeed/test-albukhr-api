'use strict';

// Run from test-albukhr-app repository root:
// node tests/testnet-staking-recovery-client-smoke.js
const fs = require('node:fs');
const assert = require('node:assert/strict');
const client = fs.readFileSync('js/testnet-staking-payment-client.js', 'utf8');
const ui = fs.readFileSync('js/testnet-staking.js', 'utf8');

assert.match(client, /async function restorePendingStake\(project\)/,
  'client defines project-scoped recovery');
assert.match(client, /request\("pending"/,
  'client calls pending-intent endpoint');
assert.match(client, /paymentLaunched:\s*paymentArmed\s*\|\|\s*Boolean\(paymentId\)/,
  'restored armed intent is conservatively considered possibly launched');
assert.match(client, /if \(pendingIntent\.paymentLaunched\)/,
  'client rejects duplicate payment launch');
assert.match(client, /restorePendingStake:\s*restorePendingStake/,
  'client exports recovery method');
assert.match(client, /await authenticate\(\);[\s\S]*?request\("cancel"/,
  'recovered unarmed intent re-authenticates before cancellation');
assert.doesNotMatch(client, /\blocalStorage\b|\bsessionStorage\b/,
  'does not add browser storage');

assert.match(ui, /"restorePendingStake"/,
  'UI checks recovery method contract');
assert.match(ui, /intentRecoveryOnly/,
  'recovered armed modal can be dismissed without cancellation');
assert.match(ui, /Reservation expired/ ,
  'expired unarmed recovery is not offered a new payment');
assert.match(ui, /Admin reconciliation required/,
  'ambiguous armed intent is not shown as safe to pay again');

console.log(JSON.stringify({
  result: 'PASS',
  recovery_client: true,
  duplicate_payment_guard: true,
  recovered_unarmed_cancel_auth: true,
  armed_reserve_auto_release: false,
  local_storage_added: false
}, null, 2));
