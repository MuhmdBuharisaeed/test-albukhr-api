
"use strict";

// ALBUKHR Testnet payout-wallet guard regression.
// Uses temporary in-memory Stellar keypairs only.
// No environment secrets, network requests, signing or payouts are used.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const StellarSdk = require("stellar-sdk");

const serverPath = path.join(__dirname, "..", "server.js");
const serverSource = fs.readFileSync(serverPath, "utf8");

const functionMatch = serverSource.match(
  /function payoutWalletKeypair\(\)\s*\{[\s\S]*?\n\}/
);

assert.ok(
  functionMatch,
  "PAYOUT_WALLET_KEYPAIR_FUNCTION_NOT_FOUND"
);

function loadGuard(options) {
  const sandbox = {
    WALLET_PRIVATE_SEED: options.seed,
    CONFIGURED_TESTNET_APP_WALLET: options.configuredWallet,
    TESTNET_PAYOUT_WALLET_CONFIGURED: options.ready,
    StellarSdk,
    clean(value) {
      return String(value == null ? "" : value).trim();
    },
    Error,
  };

  return vm.runInNewContext(
    "(" + functionMatch[0] + ")",
    sandbox,
    { timeout: 1000 }
  );
}

function expectFailure(options, expectedCode) {
  const guard = loadGuard(options);

  assert.throws(
    () => guard(),
    (error) => {
      assert.equal(
        error.message,
        expectedCode,
        "Unexpected payout-wallet guard error"
      );
      return true;
    }
  );
}

// Temporary keypairs exist only in this process memory.
const expectedWallet = StellarSdk.Keypair.random();
const differentWallet = StellarSdk.Keypair.random();

const expectedSeed = expectedWallet.secret();
const expectedPublicKey = expectedWallet.publicKey();
const differentPublicKey = differentWallet.publicKey();

// 1. Correct seed, configured address and startup readiness must pass.
const validGuard = loadGuard({
  seed: expectedSeed,
  configuredWallet: expectedPublicKey,
  ready: true,
});

const validResult = validGuard();

assert.equal(
  validResult.publicKey(),
  expectedPublicKey,
  "VALID_TESTNET_PAYOUT_WALLET_MUST_BE_ACCEPTED"
);

// 2. Missing private seed must fail closed.
expectFailure({
  seed: "",
  configuredWallet: expectedPublicKey,
  ready: true,
}, "WALLET_NOT_CONFIGURED");

// 3. Missing configured public wallet must fail closed.
expectFailure({
  seed: expectedSeed,
  configuredWallet: "",
  ready: false,
}, "TESTNET_PAYOUT_WALLET_NOT_CONFIGURED");

// 4. Invalid configured public address must fail closed.
expectFailure({
  seed: expectedSeed,
  configuredWallet: "NOT_A_STELLAR_G_ADDRESS",
  ready: false,
}, "TESTNET_PAYOUT_WALLET_NOT_CONFIGURED");

// 5. Invalid private seed must fail without exposing SDK internals.
expectFailure({
  seed: "INVALID_PRIVATE_SEED",
  configuredWallet: expectedPublicKey,
  ready: false,
}, "WALLET_PRIVATE_SEED_INVALID");

// 6. A different configured public wallet must be rejected.
expectFailure({
  seed: expectedSeed,
  configuredWallet: differentPublicKey,
  ready: true,
}, "TESTNET_PAYOUT_WALLET_MISMATCH");

// 7. A matching key must still be rejected when startup readiness is false.
expectFailure({
  seed: expectedSeed,
  configuredWallet: expectedPublicKey,
  ready: false,
}, "TESTNET_PAYOUT_WALLET_MISMATCH");

console.log(JSON.stringify({
  suite: "testnet-payout-wallet-guard-smoke",
  result: "PASS",
  actual_server_function_tested: true,
  stellar_sdk_used: true,
  valid_wallet_accepted: true,
  missing_seed_rejected: true,
  missing_wallet_rejected: true,
  malformed_wallet_rejected: true,
  invalid_seed_rejected: true,
  mismatched_wallet_rejected: true,
  failed_startup_readiness_rejected: true,
  temporary_test_keys_only: true,
  private_keys_logged: false,
  network_requests: false,
  transaction_signing: false,
  payment_submitted: false,
}, null, 2));
