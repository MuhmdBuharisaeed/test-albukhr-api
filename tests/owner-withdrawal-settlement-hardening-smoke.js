'use strict';

// Structural smoke test: validates that server.js has the fail-closed
// verification guard before it calls the owner-settlement RPC.
// It does not submit Pi payments or connect to Supabase/Horizon.
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function fail(message) {
  console.error('FAIL:', message);
  process.exitCode = 1;
}

const start = source.indexOf('async function markOwnerWithdrawalCompleted(requestId, txid) {');
const end = source.indexOf('\n/* ============================================================\n   SUBMIT TESTNET WITHDRAWAL PAYOUT', start);
if (start < 0 || end < 0) {
  fail('OWNER_SETTLEMENT_FUNCTION_BOUNDARIES_NOT_FOUND');
  process.exit();
}
const fn = source.slice(start, end);
const checks = [
  ['network isolation', '.eq("network", "testnet")'],
  ['processing/completed state gate', '["processing", "completed"].includes(clean(withdrawal.status))'],
  ['expected destination wallet', 'wallet_address: withdrawal.wallet_address'],
  ['exact requested amount', 'amount: expectedAmount'],
  ['Horizon payout verification helper', 'findTestnetPayoutByMemo('],
  ['missing payout fails closed', 'OWNER_PAYOUT_NOT_VERIFIED_ON_TESTNET'],
  ['txid equality check', 'OWNER_PAYOUT_TXID_MISMATCH'],
  ['completed request txid consistency', 'OWNER_WITHDRAWAL_ALREADY_COMPLETED_TXID_MISMATCH'],
  ['settlement RPC called only after verification', 'complete_testnet_project_owner_withdrawal'],
];
for (const [label, marker] of checks) {
  if (!fn.includes(marker)) fail('MISSING_' + label.toUpperCase().replace(/[^A-Z0-9]+/g, '_'));
}
const verify = fn.indexOf('const verifiedPayout = await findTestnetPayoutByMemo(');
const settle = fn.indexOf('const settlement = await supabase.rpc(');
if (verify < 0 || settle < 0 || verify >= settle) fail('SETTLEMENT_RPC_BEFORE_HORIZON_VERIFICATION');
if (fn.includes('return await supabase.rpc(')) fail('UNGUARDED_DIRECT_SETTLEMENT_RETURN_FOUND');
if (!process.exitCode) {
  console.log(JSON.stringify({
    structural_checks: checks.length,
    verification_precedes_settlement: true,
    testnet_only_guard: true,
    network_calls_made: false,
    payments_submitted: false,
    result: 'PASS'
  }, null, 2));
}
