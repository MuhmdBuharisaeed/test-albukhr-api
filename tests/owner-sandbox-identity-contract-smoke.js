'use strict';

// Read-only source-contract smoke test. Run from test-albukhr-api after patching.
// It does not instantiate Pi SDK, call Pi API, connect to Supabase, or submit payment.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const routerPath = path.join(__dirname, '..', 'testnet-liquidity-payment-router.js');
const source = fs.readFileSync(routerPath, 'utf8');

function has(label, pattern) {
  assert.match(source, pattern, `Missing Testnet Owner identity guard: ${label}`);
}

has('Testnet session includes optional Sandbox UID', /select\([\s\S]{0,120}testnet_pi_uid[\s\S]{0,100}expires_at/);
has('Pi Sandbox UID is still obtained from the verified Pi identity', /const piUser = await getPiUser\(bearer\(req\)\)/);
has(
  'canonical UID is derived from the Testnet session',
  /const\s+(?:canonicalPiUid|gatewayPiUid)\s*=\s*clean\(session\.pi_uid\)/
);
has(
  'canonical user row is resolved by the session-derived UID',
  /\.from\("users"\)[\s\S]{0,220}\.eq\("pi_uid",\s*(?:canonicalPiUid|gatewayPiUid)\)/
);
has('Sandbox UID must be linked before payment', /OWNER_SANDBOX_IDENTITY_NOT_LINKED/);
has(
  'verified Sandbox UID must match the user mapping',
  /clean\((?:identity|ownerIdentity)\.testnet_pi_uid\)\s*!==\s*sandboxPiUid/
);
has('canonical Owner-session comparison is preserved', /function assertSessionIsProjectOwner\(session, owner\)[\s\S]{0,250}sessionPiUid !== ownerPiUid/);
has('payment DTO is compared against the Owner Sandbox mapping', /function assertPaymentIsProjectOwnerPayment\(payment, owner\)[\s\S]{0,320}owner\?\.testnet_pi_uid/);
has('Pi payment DTO user UID remains independently verified', /function validatePaymentUser\(payment, piUser\)[\s\S]{0,240}paymentUid !== verifiedUid/);
has('verified Owner profile remains a separate payment gate', /assertOwnerIdentityVerified\(project\)/);
has('global Treasury recipient check remains', /assertPaymentRecipientIsGlobalTreasury\(/);

console.log(JSON.stringify({
  structural_checks: 11,
  canonical_owner_identity_preserved: true,
  sandbox_identity_verified_separately: true,
  payment_dto_uid_binding_present: true,
  owner_profile_gate_present: true,
  treasury_recipient_gate_present: true,
  network_calls_made: false,
  payments_submitted: false,
  result: 'PASS'
}, null, 2));
