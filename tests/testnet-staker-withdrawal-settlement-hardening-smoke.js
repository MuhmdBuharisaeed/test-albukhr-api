"use strict";

// Testnet staker settlement hardening regression.
// Uses mocked Supabase and Horizon dependencies.
// No network requests, wallet secrets, signing, payouts or DB writes.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "server.js"),
  "utf8"
);

function extractAsyncFunction(name) {
  const pattern = new RegExp(
    "async function " + name + "\\([\\s\\S]*?\\n\\}"
  );

  const match = source.match(pattern);

  assert.ok(
    match,
    name.toUpperCase() + "_NOT_FOUND_IN_SERVER"
  );

  return match[0];
}

const getWithdrawalSource =
  extractAsyncFunction("getWithdrawal");

const settlementSource =
  extractAsyncFunction("markWithdrawalCompleted");

const REQUEST_ID = "00000000-0000-4000-8000-000000000071";
const SOURCE = "GTESTNETPAYOUTSOURCE";
const DESTINATION = "GTESTNETDESTINATION";
const MEMO = "ALB-0123456789abcdef01234567";
const TXID = "a".repeat(64);
const OTHER_TXID = "b".repeat(64);

function createHarness(options = {}) {
  const row = {
    id: REQUEST_ID,
    network: "testnet",
    status: "processing",
    wallet_address: DESTINATION,
    requested_amount: 1.50,
    net_amount: 1.25,
    txid: null,
    ...(options.row || {}),
  };

  const state = {
    table: null,
    selected: null,
    filters: {},
    horizonCalls: 0,
    horizonArguments: null,
    rpcCalls: 0,
    rpcArguments: null,
    events: [],
  };

  const supabase = {
    from(table) {
      state.table = table;

      const query = {
        select(columns) {
          state.selected = columns;
          return this;
        },

        eq(column, value) {
          state.filters[column] = value;
          return this;
        },

        async maybeSingle() {
          state.events.push("read");

          if (options.readError) {
            return {
              data: null,
              error: options.readError,
            };
          }

          const matches =
            state.filters.id === row.id &&
            state.filters.network === "testnet" &&
            row.network === "testnet";

          return {
            data: matches ? { ...row } : null,
            error: null,
          };
        },
      };

      return query;
    },

    async rpc(name, args) {
      state.events.push("rpc");
      state.rpcCalls += 1;
      state.rpcArguments = { name, args };

      if (options.rpcError) {
        return {
          data: null,
          error: options.rpcError,
        };
      }

      return {
        data: {
          ...row,
          status: "completed",
          txid: args.p_txid,
        },
        error: null,
      };
    },
  };

  const sandbox = {
    supabase,

    clean(value) {
      return String(value == null ? "" : value).trim();
    },

    numeric(value) {
      const number = Number(value);

      return Number.isFinite(number)
        ? number
        : null;
    },

    payoutWalletKeypair() {
      return {
        publicKey() {
          return SOURCE;
        },
      };
    },

    withdrawalMemo(requestId) {
      assert.equal(requestId, REQUEST_ID);
      return MEMO;
    },

    async findTestnetPayoutByMemo(
      sourcePublicKey,
      memoText,
      expectedPayout
    ) {
      state.events.push("horizon");
      state.horizonCalls += 1;

      state.horizonArguments = {
        sourcePublicKey,
        memoText,
        expectedPayout,
      };

      if (options.horizonError) {
        throw options.horizonError;
      }

      return options.horizonResult === undefined
        ? { hash: TXID }
        : options.horizonResult;
    },
  };

  const getWithdrawal = vm.runInNewContext(
    "(" + getWithdrawalSource + ")",
    sandbox
  );

  sandbox.getWithdrawal = getWithdrawal;

  const markWithdrawalCompleted = vm.runInNewContext(
    "(" + settlementSource + ")",
    sandbox
  );

  return {
    markWithdrawalCompleted,
    state,
  };
}

async function expectCode(promise, expectedCode) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.message, expectedCode);
    return true;
  });
}

(async () => {
  // 1. Missing request ID or TXID must fail before database access.
  {
    const harness = createHarness();

    await expectCode(
      harness.markWithdrawalCompleted("", TXID),
      "PAYOUT_RECORDED_FAILED:Missing request ID or transaction ID."
    );

    await expectCode(
      harness.markWithdrawalCompleted(REQUEST_ID, ""),
      "PAYOUT_RECORDED_FAILED:Missing request ID or transaction ID."
    );

    assert.equal(harness.state.rpcCalls, 0);
    assert.equal(harness.state.horizonCalls, 0);
  }

  // 2. Malformed TXID must never reach settlement.
  {
    const harness = createHarness();

    await expectCode(
      harness.markWithdrawalCompleted(
        REQUEST_ID,
        "INVALID_TXID"
      ),
      "TESTNET_WITHDRAWAL_TXID_INVALID"
    );

    assert.equal(harness.state.rpcCalls, 0);
    assert.equal(harness.state.horizonCalls, 0);
  }

  // 3. A missing Testnet withdrawal must not be settled.
  {
    const harness = createHarness({
      row: {
        id: "another-withdrawal-id",
      },
    });

    await expectCode(
      harness.markWithdrawalCompleted(REQUEST_ID, TXID),
      "WITHDRAWAL_NOT_FOUND"
    );

    assert.equal(harness.state.rpcCalls, 0);
    assert.equal(harness.state.horizonCalls, 0);
  }

  // 4. Invalid wallet or amount must fail before Horizon settlement.
  {
    const harness = createHarness({
      row: {
        wallet_address: "",
      },
    });

    await expectCode(
      harness.markWithdrawalCompleted(REQUEST_ID, TXID),
      "TESTNET_WITHDRAWAL_EXPECTED_DETAILS_INVALID"
    );

    assert.equal(harness.state.rpcCalls, 0);
  }

  // 5. No matching Horizon payment must block settlement.
  {
    const harness = createHarness({
      horizonResult: null,
    });

    await expectCode(
      harness.markWithdrawalCompleted(REQUEST_ID, TXID),
      "TESTNET_WITHDRAWAL_PAYOUT_NOT_VERIFIED_ON_TESTNET"
    );

    assert.equal(harness.state.rpcCalls, 0);
    assert.equal(harness.state.horizonCalls, 1);
  }

  // 6. A different Horizon TXID must block settlement.
  {
    const harness = createHarness({
      horizonResult: {
        hash: OTHER_TXID,
      },
    });

    await expectCode(
      harness.markWithdrawalCompleted(REQUEST_ID, TXID),
      "TESTNET_WITHDRAWAL_TXID_MISMATCH"
    );

    assert.equal(harness.state.rpcCalls, 0);
  }

  // 7. Horizon lookup errors must fail closed.
  {
    const harness = createHarness({
      horizonError: new Error(
        "TESTNET_PAYOUT_OPERATION_LOOKUP_FAILED"
      ),
    });

    await expectCode(
      harness.markWithdrawalCompleted(REQUEST_ID, TXID),
      "TESTNET_PAYOUT_OPERATION_LOOKUP_FAILED"
    );

    assert.equal(harness.state.rpcCalls, 0);
  }

  // 8. Existing completed request cannot accept a different TXID.
  {
    const harness = createHarness({
      row: {
        status: "completed",
        txid: OTHER_TXID,
      },
    });

    await expectCode(
      harness.markWithdrawalCompleted(REQUEST_ID, TXID),
      "TESTNET_WITHDRAWAL_ALREADY_COMPLETED_TXID_MISMATCH"
    );

    assert.equal(harness.state.rpcCalls, 0);
  }

  // 9. Exact Horizon verification must precede the settlement RPC.
  {
    const harness = createHarness();

    const result = await harness.markWithdrawalCompleted(
      REQUEST_ID,
      TXID.toUpperCase()
    );

    assert.equal(result.status, "completed");
    assert.equal(result.txid, TXID);

    assert.equal(harness.state.table, "withdrawal_requests");
    assert.equal(harness.state.filters.id, REQUEST_ID);
    assert.equal(harness.state.filters.network, "testnet");

    assert.equal(harness.state.horizonCalls, 1);
    assert.equal(harness.state.rpcCalls, 1);

    assert.equal(
      harness.state.horizonArguments.sourcePublicKey,
      SOURCE
    );

    assert.equal(
      harness.state.horizonArguments.memoText,
      MEMO
    );

    assert.equal(
      harness.state.horizonArguments.expectedPayout.wallet_address,
      DESTINATION
    );

    assert.equal(
      harness.state.horizonArguments.expectedPayout.amount,
      1.25
    );

    assert.deepEqual(
      harness.state.events,
      ["read", "horizon", "rpc"]
    );

    assert.equal(
      harness.state.rpcArguments.name,
      "complete_testnet_withdrawal_and_ledger"
    );

    assert.equal(
      harness.state.rpcArguments.args.p_request_id,
      REQUEST_ID
    );

    assert.equal(
      harness.state.rpcArguments.args.p_txid,
      TXID
    );
  }

  // 10. Database settlement errors must still be reported.
  {
    const harness = createHarness({
      rpcError: {
        message: "SIMULATED_SETTLEMENT_FAILURE",
      },
    });

    await expectCode(
      harness.markWithdrawalCompleted(REQUEST_ID, TXID),
      "PAYOUT_RECORDED_FAILED:SIMULATED_SETTLEMENT_FAILURE"
    );

    assert.equal(harness.state.horizonCalls, 1);
    assert.equal(harness.state.rpcCalls, 1);
    assert.deepEqual(
      harness.state.events,
      ["read", "horizon", "rpc"]
    );
  }

  console.log(JSON.stringify({
    suite: "testnet-staker-withdrawal-settlement-hardening-smoke",
    result: "PASS",
    testnet_database_read_required: true,
    exact_wallet_and_amount_verified: true,
    horizon_payment_required: true,
    txid_must_match_horizon: true,
    completed_txid_mismatch_rejected: true,
    settlement_rpc_runs_after_verification_only: true,
    real_horizon_requests: false,
    database_writes: false,
    wallet_secrets_used: false,
    payments_submitted: false,
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
