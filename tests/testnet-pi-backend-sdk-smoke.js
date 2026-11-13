
"use strict";

const assert = require("node:assert/strict");
const { createRequire } = require("node:module");

const sdkModule = require("pi-backend");

const candidates = [
  sdkModule,
  sdkModule && sdkModule.default,
  sdkModule && sdkModule.PiNetwork,
];

const PiNetwork = candidates.find(
  (candidate) => typeof candidate === "function"
);

assert.equal(
  typeof PiNetwork,
  "function",
  "PI_BACKEND_SDK_CONSTRUCTOR_UNAVAILABLE"
);

// Generate a throwaway keypair using the Stellar SDK resolved from
// pi-backend's own dependency location.
const requireFromPiBackend = createRequire(
  require.resolve("pi-backend")
);
const PiStellarSdk = requireFromPiBackend("stellar-sdk");
const testWalletSeed = PiStellarSdk.Keypair.random().secret();

// Constructor-only test. No Pi API call and no blockchain transaction.
const client = new PiNetwork(
  "CI_ONLY_NOT_A_REAL_PI_API_KEY",
  testWalletSeed
);

const requiredMethods = [
  "createPayment",
  "submitPayment",
  "completePayment",
  "getPayment",
  "cancelPayment",
  "getIncompleteServerPayments",
];

for (const method of requiredMethods) {
  assert.equal(
    typeof client[method],
    "function",
    `PI_BACKEND_METHOD_MISSING:${method}`
  );
}

console.log(JSON.stringify({
  result: "PASS",
  sdk_package: "pi-backend",
  sdk_version: "0.1.3",
  module_system: "CommonJS",
  constructor: "PASS",
  required_a2u_methods: "PASS",
  pi_api_requests: false,
  payment_created: false,
  transaction_signed: false,
  payment_submitted: false,
}, null, 2));
