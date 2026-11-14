
"use strict";

// ALBUKHR Testnet Owner Withdrawal Reconciliation Route Regression.
//
// Executes the actual /owner/reconcile route handler from
// testnet-outflow-fee-router.js with mocked Supabase/Horizon dependencies.
//
// No real DB/network access, wallet secrets, signing, or Pi payouts.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const createTestnetOutflowFeeRouter = require(
  "../testnet-outflow-fee-router"
);

const SESSION_TOKEN = "ALBUKHR-OWNER-RECONCILE-TEST-SESSION";
const PI_UID = "PI-OWNER-TEST-UID";
const OWNER_ID = "00000000-0000-4000-8000-000000000101";
const WITHDRAWAL_ID = "00000000-0000-4000-8000-000000000201";
const TXID = "b".repeat(64);
const NETWORK = "testnet";

const SESSION_HASH = crypto
  .createHash("sha256")
  .update(SESSION_TOKEN, "utf8")
  .digest("hex");

function createHarness(options = {}) {
  const state = {
    events: [],
    reads: [],
    rpcCalls: [],
    lookupCalls: [],
    settlementCalls: [],
    payoutSubmitCalls: 0,
  };

  const rows = {
    testnet_sessions: {
      id: "session-test-id",
      session_hash: SESSION_HASH,
      pi_uid: PI_UID,
      username: "owner-test",
      wallet_address: "GTESTNETOWNERWALLET",
      network: NETWORK,
      expires_at: "2099-01-01T00:00:00.000Z",
      revoked_at: null,
    },

    users: {
      id: OWNER_ID,
      pi_uid: PI_UID,
      network: NETWORK,
    },

    project_owner_withdrawals: {
      id: WITHDRAWAL_ID,
      project_id: "00000000-0000-4000-8000-000000000301",
      owner_user_id: OWNER_ID,
      network: NETWORK,
      requested_amount: 1.25,
      fee_rate: 0.0001,
      fee_amount: 0.01,
      net_amount: 1.25,
      wallet_address: "GTESTNETOWNERWALLET",
      status: options.status || "processing",
      txid: options.existingTxid || null,
      reviewed_by: "TESTNET-ADMIN",
      reviewed_at: "2026-11-14T10:00:00.000Z",
      created_at: "2026-11-14T09:00:00.000Z",
      updated_at: "2026-11-14T10:00:00.000Z",
    },
  };

  const supabase = {
    from(table) {
      const filters = [];

      const query = {
        select(columns) {
          state.reads.push({
            table,
            columns,
            filters,
          });

          return query;
        },

        eq(column, value) {
          filters.push([column, value]);
          return query;
        },

        async maybeSingle() {
          state.events.push(`read:${table}`);

          const row = rows[table] || null;

          if (!row) {
            return {
              data: null,
              error: null,
            };
          }

          const matches = filters.every(([column, expected]) => {
            return String(
              row[column] == null ? "" : row[column]
            ) === String(
              expected == null ? "" : expected
            );
          });

          return {
            data: matches ? { ...row } : null,
            error: null,
          };
        },
      };

      return query;
    },

    async rpc(name, args) {
      state.events.push(`rpc:${name}`);
      state.rpcCalls.push({
        name,
        args,
      });

      if (options.feeRpcError) {
        return {
          data: null,
          error: options.feeRpcError,
        };
      }

      return {
        data: options.feeAssessment || {
          fee_amount: 0.01,
          fee_status: "paid",
        },
        error: null,
      };
    },
  };

  const findTestnetWithdrawalPayoutByMemo = async (requestId) => {
    state.events.push("payout_lookup");
    state.lookupCalls.push(requestId);

    if (options.lookupError) {
      throw options.lookupError;
    }

    if (options.payoutFound === false) {
      return null;
    }

    return {
      txid: TXID,
      memo: "ALB-TEST-OWNER-WITHDRAWAL",
      reconciled: true,
    };
  };

  const markOwnerWithdrawalCompleted = async (
    requestId,
    txid
  ) => {
    state.events.push("settlement");

    state.settlementCalls.push({
      requestId,
      txid,
    });

    if (options.settlementError) {
      throw options.settlementError;
    }

    return {
      ...rows.project_owner_withdrawals,
      status: "completed",
      txid,
    };
  };

  const submitTestnetWithdrawalPayout = async () => {
    state.payoutSubmitCalls += 1;
    state.events.push("payout_submit");

    throw new Error(
      "PAYOUT_SUBMISSION_MUST_NOT_RUN_DURING_RECONCILIATION"
    );
  };

  const router = createTestnetOutflowFeeRouter({
    supabase,
    axios: {},
    piApiKey: "MOCK-PI-API-KEY",
    piTestnetAppWallet: "GTESTNETAPPWALLET",

    submitTestnetWithdrawalPayout,

    markWithdrawalCompleted: async () => {
      throw new Error(
        "STAKER_SETTLEMENT_MUST_NOT_RUN"
      );
    },

    findTestnetWithdrawalPayoutByMemo,
    markOwnerWithdrawalCompleted,
  });

  const layer = router.stack.find(
    (item) =>
      item.route &&
      item.route.path === "/owner/reconcile"
  );

  assert.ok(
    layer,
    "OWNER_RECONCILE_ROUTE_NOT_REGISTERED"
  );

  const handler = layer.route.stack[0].handle;

  async function invoke() {
    const req = {
      body: {
        withdrawalId: WITHDRAWAL_ID,
      },

      get(header) {
        return header.toLowerCase() === "x-testnet-session"
          ? SESSION_TOKEN
          : "";
      },
    };

    const res = {
      statusCode: 200,
      body: null,

      status(code) {
        this.statusCode = code;
        return this;
      },

      json(payload) {
        this.body = payload;
        return this;
      },
    };

    await handler(req, res);

    return res;
  }

  return {
    invoke,
    state,
  };
}

(async () => {
  // 1. A processing request with no verified payout
  // must remain processing.

  {
    const harness = createHarness({
      payoutFound: false,
    });

    const response = await harness.invoke();

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.reconciled, false);
    assert.equal(response.body.payoutFound, false);
    assert.equal(response.body.status, "processing");

    assert.deepEqual(
      harness.state.lookupCalls,
      [WITHDRAWAL_ID]
    );

    assert.equal(harness.state.rpcCalls.length, 0);
    assert.equal(harness.state.settlementCalls.length, 0);
    assert.equal(harness.state.payoutSubmitCalls, 0);
  }

  // 2. A verified payout must pass the fee guard
  // before settlement.

  {
    const harness = createHarness();

    const response = await harness.invoke();

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.reconciled, true);
    assert.equal(response.body.payoutFound, true);
    assert.equal(response.body.txid, TXID);

    const lookupIndex =
      harness.state.events.indexOf("payout_lookup");

    const feeIndex =
      harness.state.events.indexOf(
        "rpc:assert_testnet_outflow_fee_ready"
      );

    const settlementIndex =
      harness.state.events.indexOf("settlement");

    assert.ok(
      lookupIndex >= 0,
      "VERIFIED_PAYOUT_LOOKUP_REQUIRED"
    );

    assert.ok(
      feeIndex > lookupIndex,
      "FEE_GUARD_MUST_FOLLOW_PAYOUT_LOOKUP"
    );

    assert.ok(
      settlementIndex > feeIndex,
      "SETTLEMENT_MUST_FOLLOW_FEE_GUARD"
    );

    assert.deepEqual(
      harness.state.settlementCalls,
      [{
        requestId: WITHDRAWAL_ID,
        txid: TXID,
      }]
    );

    assert.equal(
      harness.state.payoutSubmitCalls,
      0
    );

    assert.deepEqual(
      harness.state.rpcCalls[0],
      {
        name: "assert_testnet_outflow_fee_ready",
        args: {
          p_source_type: "project_owner_withdrawal",
          p_source_id: WITHDRAWAL_ID,
        },
      }
    );

    const sessionRead = harness.state.reads.find(
      (item) => item.table === "testnet_sessions"
    );

    const userRead = harness.state.reads.find(
      (item) => item.table === "users"
    );

    const withdrawalRead = harness.state.reads.find(
      (item) =>
        item.table === "project_owner_withdrawals"
    );

    const hasFilter = (
      read,
      column,
      expected
    ) =>
      read &&
      read.filters.some(
        ([name, value]) =>
          name === column && value === expected
      );

    assert.ok(
      hasFilter(sessionRead, "network", NETWORK)
    );

    assert.ok(
      hasFilter(userRead, "pi_uid", PI_UID)
    );

    assert.ok(
      hasFilter(userRead, "network", NETWORK)
    );

    assert.ok(
      hasFilter(withdrawalRead, "id", WITHDRAWAL_ID)
    );

    assert.ok(
      hasFilter(withdrawalRead, "owner_user_id", OWNER_ID)
    );

    assert.ok(
      hasFilter(withdrawalRead, "network", NETWORK)
    );
  }

  // 3. An unpaid fee must block settlement
  // after a payout is found.

  {
    const harness = createHarness({
      feeAssessment: {
        fee_amount: 0.01,
        fee_status: "pending",
      },
    });

    const response = await harness.invoke();

    assert.equal(response.statusCode, 409);

    assert.equal(
      response.body.error,
      "OUTFLOW_FEE_PAYMENT_REQUIRED"
    );

    assert.equal(harness.state.lookupCalls.length, 1);
    assert.equal(harness.state.rpcCalls.length, 1);
    assert.equal(harness.state.settlementCalls.length, 0);
    assert.equal(harness.state.payoutSubmitCalls, 0);
  }

  // 4. A failed payout lookup must fail closed
  // before fee assessment or settlement.

  {
    const lookupError = new Error(
      "SIMULATED_HORIZON_LOOKUP_FAILURE"
    );

    lookupError.status = 503;

    const harness = createHarness({
      lookupError,
    });

    const response = await harness.invoke();

    assert.equal(response.statusCode, 503);
    assert.equal(response.body.success, false);

    assert.equal(harness.state.rpcCalls.length, 0);
    assert.equal(harness.state.settlementCalls.length, 0);
    assert.equal(harness.state.payoutSubmitCalls, 0);
  }

  // 5. Settlement failure must be reported.
  // Reconciliation must never resubmit the payout.

  {
    const harness = createHarness({
      settlementError: new Error(
        "SIMULATED_SETTLEMENT_FAILURE"
      ),
    });

    const response = await harness.invoke();

    assert.equal(response.statusCode, 502);

    assert.equal(
      response.body.error,
      "PAYOUT_RECORDED_FAILED"
    );

    assert.equal(response.body.txid, TXID);

    assert.equal(harness.state.lookupCalls.length, 1);
    assert.equal(harness.state.rpcCalls.length, 1);
    assert.equal(harness.state.settlementCalls.length, 1);
    assert.equal(harness.state.payoutSubmitCalls, 0);
  }

  // 6. A non-processing withdrawal cannot enter reconciliation.

  {
    const harness = createHarness({
      status: "approved",
    });

    const response = await harness.invoke();

    assert.equal(response.statusCode, 409);

    assert.equal(
      response.body.error,
      "OWNER_WITHDRAWAL_NOT_RECONCILABLE"
    );

    assert.equal(harness.state.lookupCalls.length, 0);
    assert.equal(harness.state.rpcCalls.length, 0);
    assert.equal(harness.state.settlementCalls.length, 0);
    assert.equal(harness.state.payoutSubmitCalls, 0);
  }

  // 7. A completed withdrawal must be idempotent.
  // No new lookup, fee check, settlement or payout.

  {
    const harness = createHarness({
      status: "completed",
      existingTxid: TXID,
    });

    const response = await harness.invoke();

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.reconciled, true);
    assert.equal(response.body.payoutFound, true);
    assert.equal(response.body.txid, TXID);

    assert.equal(harness.state.lookupCalls.length, 0);
    assert.equal(harness.state.rpcCalls.length, 0);
    assert.equal(harness.state.settlementCalls.length, 0);
    assert.equal(harness.state.payoutSubmitCalls, 0);
  }

  console.log(JSON.stringify({
    suite: "owner-withdrawal-reconciliation-route-smoke",
    result: "PASS",

    actual_owner_reconcile_route_executed: true,

    testnet_session_required: true,
    owner_identity_and_network_scope_checked: true,

    missing_payout_keeps_request_processing: true,

    fee_guard_follows_verified_payout: true,
    settlement_follows_fee_guard: true,

    unpaid_fee_blocks_settlement: true,
    lookup_failure_fails_closed: true,

    settlement_failure_never_resubmits_payout: true,

    non_processing_state_rejected: true,
    completed_request_is_idempotent: true,

    real_network_requests: false,
    real_database_access: false,
    mocked_supabase_reads_only: true,
    database_writes: false,

    wallet_secrets_used: false,
    transactions_signed: false,
    payments_submitted: false,
  }, null, 2));

})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
