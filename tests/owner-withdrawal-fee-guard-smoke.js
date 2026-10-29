const crypto = require("crypto");
const Module = require("module");
const originalLoad = Module._load;
const routes = {};

Module._load = function (request, parent, isMain) {
  if (request === "express") {
    return {
      Router() {
        return {
          post(path, handler) { routes[path] = handler; },
        };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const createRouter = require("../testnet-outflow-fee-router.js");
const sessionToken = "temporary-owner-session-token";
const sessionHash = crypto.createHash("sha256").update(sessionToken, "utf8").digest("hex");
const now = new Date().toISOString();
const tables = {
  testnet_sessions: {
    id: "session-1",
    session_hash: sessionHash,
    pi_uid: "pi-owner-test-1",
    username: "owner-test",
    wallet_address: "GTESTOWNERWALLET",
    network: "testnet",
    expires_at: new Date(Date.now() + 60000).toISOString(),
    revoked_at: null,
  },
  users: {
    id: "owner-user-1",
    pi_uid: "pi-owner-test-1",
    network: "testnet",
  },
  project_owner_withdrawals: [
    {
      id: "00000000-0000-4000-8000-000000000041",
      project_id: "00000000-0000-4000-8000-000000000042",
      owner_user_id: "owner-user-1",
      network: "testnet",
      requested_amount: 1,
      fee_rate: 0,
      fee_amount: 0,
      net_amount: 1,
      wallet_address: "GTESTOWNERWALLET",
      status: "approved",
      txid: null,
      reviewed_by: "00000000-0000-4000-8000-000000000043",
      reviewed_at: now,
      created_at: now,
      updated_at: now,
    },
    {
      id: "00000000-0000-4000-8000-000000000045",
      project_id: "00000000-0000-4000-8000-000000000042",
      owner_user_id: "owner-user-1",
      network: "testnet",
      requested_amount: 2,
      fee_rate: 0,
      fee_amount: 0,
      net_amount: 2,
      wallet_address: "GTESTOWNERWALLET",
      status: "processing",
      txid: null,
      reviewed_by: "00000000-0000-4000-8000-000000000043",
      reviewed_at: now,
      created_at: now,
      updated_at: now,
    },
  ],
};
let feeReady = false;
let payoutCalls = 0;
let ownerSettlementCalls = 0;
let reconciliationMatch = null;
const output = [];
const fakeConsole = {
  log: (...args) => output.push({ level: "log", args }),
  error: (...args) => output.push({ level: "error", args }),
  warn: (...args) => output.push({ level: "warn", args }),
};

function matches(row, filters) {
  return Object.entries(filters).every(([key, expected]) =>
    String(row && row[key] != null ? row[key] : "") === String(expected == null ? "" : expected)
  );
}

const fakeDb = {
  from(table) {
    const state = { filters: {}, patch: null };
    const query = {
      select() { return this; },
      eq(key, value) { state.filters[key] = value; return this; },
      update(patch) { state.patch = patch; return this; },
      async maybeSingle() {
        const collection = tables[table];
        const rows = Array.isArray(collection) ? collection : (collection ? [collection] : []);
        const row = rows.find((item) => matches(item, state.filters)) || null;
        if (!row) return { data: null, error: null };
        if (state.patch) {
          // Only allow the expected atomic approved -> processing claim in this mock.
          if (table !== "project_owner_withdrawals" || row.status !== "approved" || state.patch.status !== "processing") {
            return { data: null, error: null };
          }
          Object.assign(row, state.patch);
        }
        return { data: { ...row }, error: null };
      },
    };
    return query;
  },
  async rpc(name, args) {
    if (name === "assert_testnet_outflow_fee_ready") {
      if (!feeReady) {
        return { data: null, error: { message: "OUTFLOW_FEE_ASSESSMENT_REQUIRED" } };
      }
      return {
        data: {
          id: "00000000-0000-4000-8000-000000000044",
          network: "testnet",
          fee_amount: 0.01,
          fee_status: "paid",
          source_type: "project_owner_withdrawal",
          source_id: args && args.p_source_id,
        },
        error: null,
      };
    }
    throw new Error("UNEXPECTED_RPC:" + name);
  },
};

const fakeAxios = {
  get: async () => { throw new Error("Pi API must not be called by this smoke test"); },
  post: async () => { throw new Error("Pi API must not be called by this smoke test"); },
};

const router = createRouter({
  supabase: fakeDb,
  axios: fakeAxios,
  piApiKey: "test-only-key",
  piTestnetAppWallet: "GTESTTREASURY",
  submitTestnetWithdrawalPayout: async () => {
    payoutCalls += 1;
    return { txid: "MOCK_OWNER_TXID_" + payoutCalls, reconciled: false, memo: "MOCK_MEMO" };
  },
  markWithdrawalCompleted: async () => {
    throw new Error("Staker settlement helper must not be used by the owner route");
  },
  findTestnetWithdrawalPayoutByMemo: async () => reconciliationMatch,
  markOwnerWithdrawalCompleted: async (withdrawalId, txid) => {
    ownerSettlementCalls += 1;
    const row = tables.project_owner_withdrawals.find((item) => item.id === withdrawalId);
    if (!row) throw new Error("WRONG_OWNER_WITHDRAWAL_ID");
    row.status = "completed";
    row.txid = txid;
    row.updated_at = new Date().toISOString();
    return { ...row };
  },
});

const requiredRoutes = [
  "/withdrawal/prepare", "/withdrawal/assess", "/owner/prepare-payment",
  "/approve", "/complete", "/cancel", "/withdrawal/execute",
  "/owner/execute", "/owner/reconcile",
];
for (const path of requiredRoutes) {
  if (!routes[path]) throw new Error("ROUTE_NOT_MOUNTED:" + path);
}

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
function makeRequest(body) {
  return {
    body,
    get(name) {
      return String(name).toLowerCase() === "x-testnet-session" ? sessionToken : "";
    },
  };
}

(async () => {
  // No fee assessment: request must remain approved, and no payout may be attempted.
  const blocked = makeResponse();
  const primaryWithdrawal = tables.project_owner_withdrawals[0];
  const reconciliationWithdrawal = tables.project_owner_withdrawals[1];
  await routes["/owner/execute"](makeRequest({ withdrawalId: primaryWithdrawal.id }), blocked);
  if (blocked.statusCode !== 409 || blocked.body.error !== "FEE_ASSESSMENT_REQUIRED") {
    throw new Error("OWNER_PAYOUT_MUST_FAIL_CLOSED_WITHOUT_FEE:" + JSON.stringify(blocked.body));
  }
  if (payoutCalls !== 0 || ownerSettlementCalls !== 0 || primaryWithdrawal.status !== "approved") {
    throw new Error("BLOCKED_OWNER_PAYOUT_MUST_NOT_CLAIM_OR_PAY");
  }

  // A paid assessment permits exactly one mocked payout and owner settlement.
  feeReady = true;
  const executed = makeResponse();
  await routes["/owner/execute"](makeRequest({ withdrawalId: primaryWithdrawal.id }), executed);
  if (executed.statusCode !== 200 || executed.body.payout !== "completed" || payoutCalls !== 1 || ownerSettlementCalls !== 1) {
    throw new Error("PAID_OWNER_PAYOUT_PATH_FAILED:" + JSON.stringify({ status: executed.statusCode, body: executed.body, payoutCalls, ownerSettlementCalls }));
  }

  // Calling execute again on a completed request must not create a second payout.
  const retry = makeResponse();
  await routes["/owner/execute"](makeRequest({ withdrawalId: primaryWithdrawal.id }), retry);
  if (retry.statusCode !== 200 || retry.body.already_completed !== true || payoutCalls !== 1) {
    throw new Error("COMPLETED_OWNER_WITHDRAWAL_MUST_BE_IDEMPOTENT");
  }

  // Simulate a request stuck in processing with no memo match: reconciliation must not send money.
  reconciliationWithdrawal.status = "processing";
  reconciliationWithdrawal.txid = null;
  reconciliationMatch = null;
  const absent = makeResponse();
  await routes["/owner/reconcile"](makeRequest({ withdrawalId: reconciliationWithdrawal.id }), absent);
  if (absent.statusCode !== 200 || absent.body.payoutFound !== false || payoutCalls !== 1 || ownerSettlementCalls !== 1) {
    throw new Error("OWNER_RECONCILE_WITHOUT_MEMO_MUST_NOT_PAY_OR_SETTLE");
  }

  // If a matching memo is found, reconciliation settles but still never submits a payout.
  reconciliationMatch = { txid: "MOCK_RECONCILED_OWNER_TXID", memo: "MOCK_MEMO", reconciled: true };
  const found = makeResponse();
  await routes["/owner/reconcile"](makeRequest({ withdrawalId: reconciliationWithdrawal.id }), found);
  if (found.statusCode !== 200 || found.body.reconciled !== true || found.body.txid !== "MOCK_RECONCILED_OWNER_TXID" || payoutCalls !== 1) {
    throw new Error("OWNER_RECONCILE_FOUND_MEMO_FAILED:" + JSON.stringify(found.body));
  }

  console.log(JSON.stringify({
    router_constructed: true,
    routes_registered: requiredRoutes.length,
    owner_payout_blocked_without_fee: true,
    owner_payout_successfully_mocked_after_fee: true,
    completed_retry_did_not_double_pay: true,
    reconciliation_never_submitted_payout: true,
    payout_calls: payoutCalls,
    owner_settlement_calls: ownerSettlementCalls,
    real_pi_payment_or_payout: false,
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
