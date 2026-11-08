'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const originalLoad = Module._load;
const routes = new Map();
const expressStub = { Router() { return { post(path, handler) { routes.set(`POST ${path}`, handler); }, get(path, handler) { routes.set(`GET ${path}`, handler); } }; } };
Module._load = function(request, parent, isMain) {
  if (request === 'express') return expressStub;
  return originalLoad.call(this, request, parent, isMain);
};
const routerPath = path.join(__dirname, '..', 'testnet-staking-router.js');
const createRouter = require(routerPath);
Module._load = originalLoad;

const calls = [];
const session = {
  id: 'session-1', pi_uid: 'canonical-albukhr-uid', testnet_pi_uid: 'sandbox-pi-uid',
  username: 'tester', wallet_address: 'wallet', network: 'testnet',
  expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: null
};
const owner = { id: 'user-1', pi_uid: 'canonical-albukhr-uid', testnet_pi_uid: 'sandbox-pi-uid', network: 'testnet' };
function queryResult(table) {
  const q = {
    select() { return q; }, eq() { return q; }, order() { return q; }, limit() { return q; },
    maybeSingle: async () => ({ data: table === 'testnet_sessions' ? session : table === 'users' ? owner : { id: 'intent-1', pi_uid: 'canonical-albukhr-uid', project_id: 'project-1', project_code: 'P1', duration_days: 30, amount: 10, status: 'created', metadata: { payment_started: false } }, error: null })
  };
  return q;
}
const supabase = {
  from(table) { return queryResult(table); },
  async rpc(name, args) {
    calls.push({ name, args });
    if (name === 'create_testnet_stake_intent') return { data: {
      id: 'intent-1', project_id: 'project-1', project_code: 'P1', amount: 10,
      duration_days: 30, reward_rate: 0.01, reward_amount: 0.1,
      expires_at: new Date(Date.now() + 60_000).toISOString(), status: 'created'
    }, error: null };
    if (name === 'arm_testnet_stake_intent_payment') return { data: { id: 'intent-1', status: 'pending_payment' }, error: null };
    return { data: null, error: null };
  }
};
const axios = {
  async get(url) {
    if (url.endsWith('/me')) return { data: { uid: 'sandbox-pi-uid', username: 'tester' } };
    if (url.includes('/payments/')) return { data: { identifier: 'payment-1', amount: 10, network: 'Pi Testnet', direction: 'user_to_app', user_uid: 'sandbox-pi-uid', metadata: { network: 'testnet', action: 'stake', stake_intent_id: 'intent-1', project_id: 'project-1', project_code: 'P1', duration_days: 30 }, status: { developer_approved: false } } };
    throw new Error(`Unexpected GET ${url}`);
  }
};
createRouter({ supabase, axios, piApiKey: 'test-key' });
assert(routes.has('POST /intent'), 'intent route registered');
assert(routes.has('POST /arm'), 'arm route registered');
assert(routes.has('POST /approve'), 'approve route registered');
assert(routes.has('POST /complete'), 'complete route registered');
assert(routes.has('POST /reconcile'), 'reconcile route registered');
assert(routes.has('POST /cancel'), 'cancel route registered');

function makeReq(body = {}) {
  return {
    body,
    get(name) {
      const h = {
        'x-testnet-session': 'opaque-session-token',
        authorization: 'Bearer sandbox-access-token'
      };
      return h[String(name).toLowerCase()] || '';
    }
  };
}
function makeRes() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}
(async () => {
  let res = makeRes();
  await routes.get('POST /intent')(makeReq({ projectId: 'project-1', projectCode: 'P1', amount: 10, durationDays: 30 }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  const createCall = calls.find(c => c.name === 'create_testnet_stake_intent');
  assert(createCall, 'intent creation RPC called');
  assert.equal(createCall.args.p_pi_uid, 'canonical-albukhr-uid', 'intent RPC uses canonical UID, not Sandbox UID');

  res = makeRes();
  await routes.get('POST /arm')(makeReq({ intentId: 'intent-1' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.payment_armed, true);
  const armCall = calls.find(c => c.name === 'arm_testnet_stake_intent_payment');
  assert.equal(armCall.args.p_pi_uid, 'canonical-albukhr-uid', 'arm RPC uses canonical UID');

  res = makeRes();
  await routes.get('POST /approve')(makeReq({ paymentId: 'payment-1', intentId: 'intent-1' }), res);
  assert.equal(res.statusCode, 409, 'unarmed created intent is rejected before Pi approval');
  assert.equal(res.body.error, 'STAKE_INTENT_PAYMENT_NOT_ARMED');

  const source = require('node:fs').readFileSync(routerPath, 'utf8');
  assert(!/if\s+intent\.pi_uid/.test(source), 'malformed if syntax removed');
  assert(!/if\s*\(p_pi_uid:/.test(source), 'malformed ownership condition removed');
  assert(!/p_pi_uid:\s*clean\(piUser\.uid\)/.test(source), 'Sandbox UID is not passed as canonical RPC identity');
  assert(source.includes('testnet_pi_uid: clean(piUser.uid) || null'), 'Sandbox UID retained separately in payment metadata');
  assert(source.includes('if (intent.status === "created") {\n      throw new Error("STAKE_INTENT_PAYMENT_NOT_ARMED");'), 'unarmed intents are rejected');
  console.log(`SMOKE_OK routes=${routes.size} rpc_calls=${calls.length} canonical_sandbox_identity_separation=PASS`);
})().catch(error => { console.error(error); process.exitCode = 1; });
