"use strict";

const fs = require("fs");
const path = require("path");

const routerPath = path.join(__dirname, "..", "testnet-staking-router.js");
function assert(condition, message) {
  if (!condition) {
    console.error("FAIL:", message);
    process.exitCode = 1;
    return;
  }
  console.log("PASS:", message);
}

if (!fs.existsSync(routerPath)) {
  console.error("FAIL: testnet-staking-router.js is missing:", routerPath);
  process.exit(1);
}

const source = fs.readFileSync(routerPath, "utf8");
const start = source.indexOf("async function validatePaymentContext(");
const end = source.indexOf("async function approvePiPayment(", start + 1);
assert(start >= 0 && end > start, "finds the payment-context validation function");

if (start >= 0 && end > start) {
  const block = source.slice(start, end);
  assert(
    /if\s*\(intent\.status\s*!==\s*"pending_payment"\)/.test(block),
    "rejects every intent that is not pending before Pi payment processing"
  );
  assert(
    block.includes("intent.metadata") && block.includes("payment_started !== true"),
    "requires the database-confirmed payment_started flag"
  );
  assert(
    block.includes("STAKE_INTENT_PAYMENT_NOT_ARMED"),
    "returns a stable error when an intent was not armed"
  );
}

if (process.exitCode) process.exit(process.exitCode);
console.log("Testnet stake-intent expiry API guard smoke checks passed.");
