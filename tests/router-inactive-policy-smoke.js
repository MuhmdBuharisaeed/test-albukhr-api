const Module = require('module');
const originalLoad = Module._load;
const routes = {};
Module._load = function (request, parent, isMain) {
  if (request === 'express') return { Router() { return { post(path, handler) { routes[path] = handler; } }; } };
  return originalLoad.call(this, request, parent, isMain);
};
const createRouter = require('../test-albukhr-api/testnet-outflow-fee-router.js');
const session = {
  id: 'test-session', pi_uid: 'pi-user-1', username: 'test',
  wallet_address: 'GTESTWALLET', network: 'testnet',
  expires_at: new Date(Date.now() + 60000).toISOString(), revoked_at: null
};
const tables = {
  testnet_sessions: session,
  testnet_outflow_fee_assessments: {
    id: 'fee-1', network: 'testnet', actor_user_id: 'user-1', actor_pi_uid: 'pi-user-1',
    source_type: 'staker_withdrawal', source_id: 'withdrawal-1', fee_amount: 0.01,
    fee_status: 'payment_pending'
  }
};
const fakeDb = {
  from(table) {
    return {
      select() { return this; },
      eq() { return this; },
      maybeSingle: async () => ({ data: tables[table] || null, error: null })
    };
  },
  rpc: async (name) => {
    if (name === 'create_testnet_withdrawal_idempotent' || name === 'create_testnet_outflow_fee_assessment') {
      return { data: null, error: { message: 'TESTNET_GLOBAL_TREASURY_POLICY_INACTIVE' } };
    }
    if (name === 'cancel_testnet_outflow_fee_payment_attempt') {
      return { data: { id: 'attempt-cancelled-1', status: 'cancelled' }, error: null };
    }
    throw new Error('unexpected RPC ' + name);
  }
};
let piApproveCalls = 0;
const fakeAxios = {
  get: async (url) => {
    if (url.endsWith('/me')) return { data: { uid: 'pi-user-1', username: 'tester' } };
    if (url.endsWith('/payments/bad-payment')) return { data: {
      id: 'bad-payment', identifier: 'bad-payment', network: 'pi testnet', direction: 'user_to_app',
      user_uid: 'pi-user-1', amount: 0.02, to_address: 'GTESTTREASURY', status: {},
      metadata: { network: 'testnet', action: 'outflow_fee', fee_assessment_id: 'fee-1', source_type: 'staker_withdrawal', source_id: 'withdrawal-1' }
    } };
    if (url.endsWith('/payments/cancelled-payment')) return { data: {
      id: 'cancelled-payment', identifier: 'cancelled-payment', network: 'pi testnet', direction: 'user_to_app',
      user_uid: 'pi-user-1', amount: 0.01, to_address: 'GTESTTREASURY',
      status: { cancelled: true },
      metadata: { network: 'testnet', action: 'outflow_fee', fee_assessment_id: 'fee-1', source_type: 'staker_withdrawal', source_id: 'withdrawal-1' }
    } };
    throw new Error('unexpected GET ' + url);
  },
  post: async () => { piApproveCalls += 1; return { data: {} }; }
};
const router = createRouter({
  supabase: fakeDb, axios: fakeAxios, piApiKey: 'test-only-key', piTestnetAppWallet: 'GTESTTREASURY',
  submitTestnetWithdrawalPayout: async () => { throw new Error('payout must not execute in smoke test'); },
  markWithdrawalCompleted: async () => { throw new Error('settlement must not execute in smoke test'); }
});
const requiredRoutes = ['/withdrawal/prepare','/withdrawal/assess','/owner/prepare-payment','/approve','/complete','/cancel','/withdrawal/execute'];
for (const path of requiredRoutes) if (!routes[path]) throw new Error('ROUTE_NOT_MOUNTED:' + path);

function makeResponse() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function makeRequest(body, withPi) {
  return { body, get(name) {
    const key = String(name).toLowerCase();
    if (key === 'x-testnet-session') return 'temporary-session-token';
    if (key === 'authorization' && withPi) return 'Bearer valid-pi-access-token';
    return '';
  } };
}
(async () => {
  const prepareRes = makeResponse();
  await routes['/withdrawal/prepare'](makeRequest({
    stakeId: 'stake-1', withdrawalType: 'reward', requestedAmount: 1,
    walletAddress: 'GTESTWALLET', idempotencyKey: 'safe-test-key-12345'
  }, false), prepareRes);
  if (prepareRes.statusCode !== 423 || prepareRes.body.error !== 'TESTNET_GLOBAL_TREASURY_POLICY_INACTIVE') {
    throw new Error('POLICY_MUST_FAIL_CLOSED:' + JSON.stringify(prepareRes.body));
  }

  const approveRes = makeResponse();
  await routes['/approve'](makeRequest({ paymentId: 'bad-payment', assessmentId: 'fee-1' }, true), approveRes);
  if (approveRes.body.error !== 'PI_PAYMENT_AMOUNT_MISMATCH' || piApproveCalls !== 0) {
    throw new Error('PAYMENT_AMOUNT_MUST_BE_VERIFIED_BEFORE_PI_APPROVAL:' + JSON.stringify({ body: approveRes.body, piApproveCalls }));
  }

  const cancelRes = makeResponse();
  await routes['/cancel'](makeRequest({ paymentId: 'cancelled-payment', assessmentId: 'fee-1' }, true), cancelRes);
  if (cancelRes.body.cancelled !== true || cancelRes.body.attempt_status !== 'cancelled') {
    throw new Error('OFFICIAL_PI_CANCELLATION_MUST_RELEASE_ATTEMPT:' + JSON.stringify(cancelRes.body));
  }

  console.log(JSON.stringify({
    router_constructed: true,
    endpoints: requiredRoutes,
    inactive_policy_fails_closed: prepareRes.statusCode === 423,
    mismatched_fee_payment_rejected: approveRes.body.error === 'PI_PAYMENT_AMOUNT_MISMATCH',
    pi_approval_called_for_mismatch: piApproveCalls > 0,
    officially_cancelled_attempt_released: cancelRes.body.attempt_status === 'cancelled',
    payout_called: false,
    settlement_called: false
  }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
