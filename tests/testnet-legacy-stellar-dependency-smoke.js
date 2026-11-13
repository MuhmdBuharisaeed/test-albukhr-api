"use strict";

// Confirms that the retained legacy Testnet payout engine uses the direct,
// locked Stellar SDK dependency and has no runtime A2U SDK dependency.
// Static/local checks only: no database, Horizon, wallet secret, signing,
// network requests, or Pi payments are used.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

assert.equal(
  Object.prototype.hasOwnProperty.call(manifest.dependencies || {}, "pi-backend"),
  false,
  "PI_BACKEND_MUST_NOT_BE_A_PRODUCTION_DEPENDENCY_WHILE_A2U_IS_DEFERRED"
);

const lockedRootDependencies = lock.packages && lock.packages[""] && lock.packages[""].dependencies;
assert.ok(lockedRootDependencies, "PACKAGE_LOCK_ROOT_DEPENDENCIES_MISSING");
assert.deepEqual(
  lockedRootDependencies,
  manifest.dependencies,
  "PACKAGE_JSON_AND_PACKAGE_LOCK_ROOT_DEPENDENCIES_MUST_MATCH"
);

const packagePaths = Object.keys(lock.packages || {});
assert.equal(
  packagePaths.some((entry) => entry === "node_modules/pi-backend" || entry.includes("/node_modules/pi-backend")),
  false,
  "PI_BACKEND_MUST_NOT_REMAIN_IN_COMMITTED_LOCKFILE"
);

const stellarPackages = Object.entries(lock.packages || {})
  .filter(([entry]) => entry === "node_modules/stellar-sdk" || entry.endsWith("/node_modules/stellar-sdk"));
assert.equal(stellarPackages.length, 1, "UNEXPECTED_MULTIPLE_STELLAR_SDK_COPIES");
assert.equal(stellarPackages[0][1].version, "13.3.0", "LEGACY_PAYOUT_MUST_USE_LOCKED_STELLAR_SDK_13_3_0");

assert.match(server, /const StellarSdk\s*=\s*require\(["']stellar-sdk["']\)/);
assert.match(server, /function payoutWalletKeypair\(\)/);
assert.match(server, /async function submitTestnetWithdrawalPayout\(/);
assert.match(server, /new StellarSdk\.TransactionBuilder\(/);
assert.match(server, /StellarSdk\.Operation\.payment\(/);
assert.match(server, /StellarSdk\.Asset\.native\(\)/);
assert.match(server, /StellarSdk\.Memo\.text\(/);
assert.match(server, /server\.submitTransaction\(/);

// The A2U service is deliberately detached from the running legacy API.
assert.doesNotMatch(server, /createTestnetA2UService|testnetA2UService/);

console.log(JSON.stringify({
  suite: "testnet-legacy-stellar-dependency-smoke",
  result: "PASS",
  pi_backend_removed_from_production_dependencies: true,
  committed_lockfile_matches_package_json: true,
  no_pi_backend_lock_entries: true,
  one_locked_stellar_sdk_copy: stellarPackages[0][1].version,
  legacy_stellar_payout_implementation_preserved: true,
  a2u_service_detached_from_running_server: true,
  network_requests: false,
  transaction_signed: false,
  payment_submitted: false
}, null, 2));
