'use strict';

// Testnet dependency compatibility smoke test.
// Run after `npm install --ignore-scripts`:
// node tests/testnet-stellar-sdk-toml-override-smoke.js
// No network request, wallet secret, signing, or payout is used.

const assert = require('node:assert/strict');
const toml = require('toml');
const tomlPackage = require('toml/package.json');
const StellarSdk = require('stellar-sdk');

assert.equal(
  tomlPackage.version,
  '5.0.1',
  'the Stellar SDK dependency tree must resolve toml exactly to 5.0.1'
);

const parsed = toml.parse(
  'NETWORK_PASSPHRASE = "Pi Testnet"\n' +
  'HORIZON_URL = "https://api.testnet.minepi.com"\n'
);
assert.equal(parsed.NETWORK_PASSPHRASE, 'Pi Testnet');
assert.equal(parsed.HORIZON_URL, 'https://api.testnet.minepi.com');

assert.ok(StellarSdk.Keypair, 'Stellar Keypair API must be present');
assert.equal(typeof StellarSdk.Keypair.random, 'function');
assert.equal(typeof StellarSdk.Keypair.fromSecret, 'function');
assert.ok(StellarSdk.Horizon && StellarSdk.Horizon.Server,
  'Stellar Horizon Server constructor must be present');
assert.equal(typeof StellarSdk.TransactionBuilder, 'function');
assert.equal(typeof StellarSdk.Operation.payment, 'function');
assert.equal(typeof StellarSdk.Asset.native, 'function');
assert.equal(typeof StellarSdk.Memo.text, 'function');

// Exercise local SDK primitives only. No key is logged, persisted, or used to
// sign or submit a transaction.
const keypair = StellarSdk.Keypair.random();
const publicKey = keypair.publicKey();
assert.equal(typeof publicKey, 'string');
assert.ok(publicKey.length > 0);
assert.equal(StellarSdk.Asset.native().code, 'XLM');
assert.ok(StellarSdk.Memo.text('ALBUKHR-TESTNET-SMOKE'));

// Constructor validation only; this does not perform a Horizon HTTP request.
const horizon = new StellarSdk.Horizon.Server(
  'https://api.testnet.minepi.com'
);
assert.equal(typeof horizon.loadAccount, 'function');

console.log(JSON.stringify({
  result: 'PASS',
  toml_version: tomlPackage.version,
  toml_parser: 'PASS',
  stellar_sdk_loaded: true,
  keypair_api: 'PASS',
  horizon_constructor: 'PASS',
  transaction_primitives: 'PASS',
  real_network_requests: false,
  transaction_signed: false,
  payment_submitted: false
}, null, 2));
