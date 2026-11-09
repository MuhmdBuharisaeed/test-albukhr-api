"use strict";

// Read-only Testnet staking dual-identity source-contract regression.
// Run from test-albukhr-api repository root:
// node tests/testnet-staking-dual-identity-smoke.js

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const source = fs.readFileSync(
  path.join(__dirname, "..", "testnet-staking-router.js"),
  "utf8"
);

let checks = 0;

function match(label, text, pattern) {
  assert.match(text, pattern, label);
  checks += 1;
}
function noMatch(label, text, pattern) {
  assert.doesNotMatch(text, pattern, label);
  checks += 1;
}
function extract(startToken, endToken, label) {
  const start = source.indexOf(startToken);
  assert.ok(start >= 0, label + " start exists");
  const end = source.indexOf(endToken, start + startToken.length);
  assert.ok(end > start, label + " end exists");
  checks += 2;
  return source.slice(start, end);
}

const sessionReader = extract(
  "async function getTestnetSession(req) {",
  "async function getTestnetAdminSession(req) {",
  "Testnet session reader"
);
match("session selects canonical and Sandbox UIDs", sessionReader,
  /\.select\([\s\S]{0,120}pi_uid,testnet_pi_uid[\s\S]{0,120}expires_at/);

const identity = extract(
  "async function validateSessionAndPiIdentity(req) {",
  "function piKeyHeaders(extra = {}) {",
  "dual identity validator"
);
match("Pi identity is obtained from verified /me", identity, /getPiUser\(bearer\(req\)\)/);
match("canonical UID comes from Testnet session", identity, /canonicalPiUid\s*=\s*clean\(session\s*&&\s*session\.pi_uid\)/);
match("Sandbox UID comes from verified Pi user", identity, /sandboxPiUid\s*=\s*clean\(piUser\s*&&\s*piUser\.uid\)/);
match("mapping is read from public users", identity, /\.from\("users"\)/);
match("mapping lookup uses canonical UID", identity, /\.eq\("pi_uid",\s*canonicalPiUid\)/);
match("mapping is isolated to Testnet", identity, /\.eq\("network",\s*NETWORK\)/);
match("mapping validates Sandbox UID", identity, /ownerIdentity\.testnet_pi_uid\)\s*!==\s*sandboxPiUid/);
match("newer session Sandbox binding is cross-checked", identity, /sessionSandboxPiUid\s*!==\s*sandboxPiUid/);
match("mapping read errors fail closed", identity, /OWNER_IDENTITY_LOOKUP_FAILED/);
match("missing or mismatched mapping fails closed", identity, /OWNER_SANDBOX_IDENTITY_NOT_LINKED/);
noMatch("canonical and Sandbox UIDs are not directly equated", identity, /canonicalPiUid\s*!==\s*sandboxPiUid/);

const paymentContext = extract(
  "async function validatePaymentContext(payment, session, piUser, expectedIntentId) {",
  "async function approvePiPayment(id) {",
  "payment context"
);
match("Pi payment DTO validation is retained", paymentContext, /validatePaymentUser\(payment,\s*piUser\)/);
match("intent owner check uses canonical session UID", paymentContext,
  /clean\(intent\.pi_uid\)\s*!==\s*clean\(session\s*&&\s*session\.pi_uid\)/);
noMatch("no direct canonical-to-Sandbox comparison remains", paymentContext, /session\.pi_uid[\s\S]{0,100}piUser\.uid/);

const writer = extract(
  "async function writeVerifiedPayment(payment, context, piUser, txid) {",
  "// ============================================================\n  // TESTNET ADMIN — GLOBAL STAKING PROJECT STAGES",
  "verified payment writer"
);
match("payer_pi_uid is canonical intent UID", writer, /payer_pi_uid:\s*clean\(context\.intent\.pi_uid\)/);
match("Sandbox UID is retained in payment metadata", writer, /testnet_pi_uid:\s*clean\(piUser\.uid\)/);
noMatch("payer_pi_uid is not set to Sandbox UID", writer, /payer_pi_uid:\s*clean\(piUser\.uid\)/);

const pending = extract(
  'router.post("/pending", async (req, res) => {',
  'router.post("/intent", async (req, res) => {',
  "pending recovery route"
);
match("pending recovery uses session canonical UID", pending, /session\s*&&\s*session\.pi_uid/);
match("pending query uses canonical pi_uid", pending, /\.eq\("pi_uid",\s*piUid\)/);
noMatch("pending recovery does not query Sandbox UID", pending, /testnet_pi_uid/);

const intent = extract(
  'router.post("/intent", async (req, res) => {',
  'router.post("/arm", async (req, res) => {',
  "intent route"
);
match("intent RPC uses canonical UID", intent, /p_pi_uid:\s*clean\(session\.pi_uid\)/);
noMatch("intent route has no stale direct equality check", intent, /session\.pi_uid[\s\S]{0,80}piUser\.uid/);

const arm = extract(
  'router.post("/arm", async (req, res) => {',
  'router.post("/approve", async (req, res) => {',
  "arm route"
);
match("arm RPC uses canonical UID", arm, /p_pi_uid:\s*clean\(session\.pi_uid\)/);
noMatch("arm route has no stale direct equality check", arm, /session\.pi_uid[\s\S]{0,80}piUser\.uid/);

const approve = extract(
  'router.post("/approve", async (req, res) => {',
  'router.post("/complete", async (req, res) => {',
  "approve route"
);
match("approve RPC uses canonical UID", approve, /p_pi_uid:\s*clean\(session\.pi_uid\)/);

const complete = extract(
  'router.post("/complete", async (req, res) => {',
  'router.post("/reconcile", async (req, res) => {',
  "complete route"
);
assert.equal((complete.match(/p_pi_uid:\s*clean\(session\.pi_uid\)/g) || []).length, 2,
  "complete bind and finalizer must both use canonical UID");
checks += 1;
match("completion retains Sandbox user for payment audit", complete,
  /writeVerifiedPayment\(completedPayment,\s*context,\s*piUser,\s*txid\)/);

const reconcile = extract(
  'router.post("/reconcile", async (req, res) => {',
  'router.post("/cancel", async (req, res) => {',
  "reconcile route"
);
match("reconcile matches intent to canonical UID", reconcile,
  /intent\.pi_uid\s*!==\s*clean\(session\.pi_uid\)/);
assert.equal((reconcile.match(/p_pi_uid:\s*clean\(session\.pi_uid\)/g) || []).length, 3,
  "reconcile cancel, bind, and finalizer must use canonical UID");
checks += 1;
match("reconcile verifies payment DTO against Pi Sandbox user", reconcile,
  /validatePaymentUser\(payment,\s*piUser\)/);

const cancel = extract(
  'router.post("/cancel", async (req, res) => {',
  "return router;",
  "cancel route"
);
match("cancel retains session and Pi user", cancel,
  /const \{ session,\s*piUser \}\s*=\s*await validateSessionAndPiIdentity\(req\)/);
match("cancel checks intent owner with canonical UID", cancel,
  /intent\.pi_uid\s*!==\s*clean\(session\.pi_uid\)/);
match("cancel RPC uses canonical UID", cancel,
  /p_pi_uid:\s*clean\(session\.pi_uid\)/);
match("cancel payment DTO remains Sandbox verified", cancel,
  /validatePaymentUser\(payment,\s*piUser\)/);

noMatch("no RPC passes Pi Sandbox UID as canonical p_pi_uid", source,
  /p_pi_uid:\s*clean\(piUser\.uid\)/);
noMatch("no intent ownership check compares to Pi Sandbox UID", source,
  /intent\.pi_uid\s*!==\s*clean\(piUser\.uid\)/);
noMatch("no session-to-Pi direct UID equality remains", source,
  /clean\(session\.pi_uid\)\s*!==\s*clean\(piUser\.uid\)/);
noMatch("no malformed if intent condition remains", source, /if intent\.pi_uid/);
noMatch("no malformed p_pi_uid condition remains", source, /if\s*\(\s*p_pi_uid\s*:/);

const rpcCount = (source.match(/p_pi_uid:\s*clean\(session\.pi_uid\)/g) || []).length;
assert.equal(rpcCount, 10, "all ten staking/owner RPC UID arguments must be canonical");
checks += 1;

console.log(JSON.stringify({
  result: "PASS",
  checks,
  canonical_identity: "session.pi_uid / intent.pi_uid / RPC p_pi_uid / payment payer_pi_uid",
  sandbox_identity: "Pi /me UID / payment.user_uid / payment metadata testnet_pi_uid",
  pending_recovery_identity: "canonical pi_uid",
  network_calls: false,
  database_writes: false,
  Pi_payments_submitted: false
}, null, 2));
