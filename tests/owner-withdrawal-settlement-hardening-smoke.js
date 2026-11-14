
"use strict";

// ALBUKHR Testnet Owner Withdrawal Settlement Hardening Regression.
//
// Executes the actual markOwnerWithdrawalCompleted() function extracted
// from server.js using mocked Supabase and Horizon dependencies.
//
// No real network requests, wallet secrets, transaction signing,
// Pi payments, or database writes are performed.

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

const settlementSource = extractAsyncFunction(
  "markOwnerWithdrawalCompleted"
);

const REQUEST_ID =
  "00000000-0000-4000-8000-000000000081";

const OTHER_REQUEST_ID =
  "00000000-0000-4000-8000-000000000082";

const SOURCE = "GTESTNETOWNERPAYOUTSOURCE";
const DESTINATION = "GTESTNETOWNERDESTINATION";

const MEMO = "ALB-0123456789abcdef01234567";

const TXID = "a".repeat(64);
const OTHER_TXID = "b".repeat(64);

const AMOUNT = 1.5;

function createHarness(options = {}) {
  const row = {
    id: REQUEST_ID,
    network: "testnet",
    wallet_address: DESTINATION,
    requested_amount: AMOUNT,
    status: "processing",
    txid: null,
    ...(options.row || {}),
  };

  const state = {
    table: null,
    selected: null,
    filters: {},

    databaseReadCalls: 0,
    horizonCalls: 0,
    rpcCalls: 0,

    horizonArguments: null,
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
          state.databaseReadCalls += 1;
          state.events.push("read");

          if (options.readError) {
            return {
              data: null,
              error: options.readError,
            };
          }

          const matches = Object.entries(
            state.filters
          ).every(([key, expected]) => {
            return String(
              row[key] == null ? "" : row[key]
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
      state.events.push("rpc");
      state.rpcCalls += 1;

      state.rpcArguments = {
        name,
        args,
      };

      if (options.rpcError) {
        return {
          data: null,
          error: options.rpcError,
        };
      }

      if (
        Object.prototype.hasOwnProperty.call(
          options,
          "rpcResult"
        )
      ) {
        return options.rpcResult;
      }

      // Mock-only return value.
      // This does not modify any real database row.
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
      return String(
        value == null ? "" : value
      ).trim();
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
      assert.equal(
        requestId,
        REQUEST_ID
      );

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

  const markOwnerWithdrawalCompleted =
    vm.runInNewContext(
      "(" + settlementSource + ")",
      sandbox
    );

  return {
    markOwnerWithdrawalCompleted,
    state,
  };
}

async function expectCode(
  promise,
  expectedCode
) {
  await assert.rejects(
    promise,
    (error) => {
      assert.equal(
        error.message,
        expectedCode
      );

      return true;
    }
  );
}

(async () => {
  // 1. Missing request ID or TXID must fail before database access.
  {
    const harness = createHarness();

    await expectCode(
      harness.markOwnerWithdrawalCompleted(
        "",
        TXID
      ),
      "OWNER_PAYOUT_RECORDED_FAILED:Missing request ID or transaction ID."
    );

    await expectCode(
      harness.markOwnerWithdrawalCompleted(
        REQUEST_ID,
        ""
      ),
      "OWNER_PAYOUT_RECORDED_FAILED:Missing request ID or transaction ID."
    );

    assert.equal(
      harness.state.databaseReadCalls,
      0
    );

    assert.equal(
      harness.state.horizonCalls,
      0
    );

    assert.equal(
      harness.state.rpcCalls,
      0
    );
  }

  // 2. Supabase read errors must fail closed.
  {
    const harness = createHarness({
      readError: {
        message: "SIMULATED_OWNER_READ_ERROR",
      },
    });

    await expectCode(
      harness.markOwnerWithdrawalCompleted(
        REQUEST_ID,
        TXID
      ),
      "OWNER_WITHDRAWAL_READ_FAILED"
    );

    assert.equal(
      harness.state.databaseReadCalls,
      1
    );

    assert.equal(
      harness.state.horizonCalls,
      0
    );

    assert.equal(
      harness.state.rpcCalls,
      0
    );
  }

  // 3. A missing owner withdrawal must not reach Horizon or settlement.
  {
    const harness = createHarness({
      row: {
        id: OTHER_REQUEST_ID,
      },
    });

    await expectCode(
      harness.markOwnerWithdrawalCompleted(
        REQUEST_ID,
        TXID
      ),
      "OWNER_WITHDRAWAL_NOT_FOUND"
    );

    assert.equal(
      harness.state.table,
      "project_owner_withdrawals"
    );

    assert.equal(
      harness.state.horizonCalls,
      0
    );

    assert.equal(
      harness.state.rpcCalls,
      0
    );
  }

  // 4. Mainnet records must never be read as Testnet owner withdrawals.
  {
    const harness = createHarness({
      row: {
        network: "mainnet",
      },
    });

    await expectCode(
      harness.markOwnerWithdrawalCompleted(
        REQUEST_ID,
        TXID
      ),
      "OWNER_WITHDRAWAL_NOT_FOUND"
    );

    assert.equal(
      harness.state.filters.network,
      "testnet"
    );

    assert.equal(
      harness.state.horizonCalls,
      0
    );

    assert.equal(
      harness.state.rpcCalls,
      0
    );
  }

  // 5. Only processing or completed withdrawals may be settled.
  {
    const harness = createHarness({
      row: {
        status: "approved",
      },
    });

    await expectCode(
      harness.markOwnerWithdrawalCompleted(
        REQUEST_ID,
        TXID
      ),
      "OWNER_WITHDRAWAL_NOT_PROCESSING"
    );

    assert.equal(
      harness.state.horizonCalls,
      0
    );

    assert.equal(
      harness.state.rpcCalls,
      0
    );
  }

  // 6. Missing destination wallet must fail before Horizon verification.
  {
    const harness = createHarness({
      row: {
        wallet_address: "",
      },
    });

    await expectCode(
      harness.markOwnerWithdrawalCompleted(
        REQUEST_ID,
        TXID
      ),
      "OWNER_PAYOUT_EXPECTED_DETAILS_INVALID"
    );

    assert.equal(
      harness.state.horizonCalls,
      0
    );

    assert.equal(
      harness.state.rpcCalls,
      0
    );
  }

  // 7. Invalid, zero or negative requested amount must fail closed.
  {
    for (const invalidAmount of [
      null,
      0,
      -1,
      "invalid",
    ]) {
      const harness = createHarness({
        row: {
          requested_amount: invalidAmount,
        },
      });

      await expectCode(
        harness.markOwnerWithdrawalCompleted(
          REQUEST_ID,
          TXID
        ),
        "OWNER_PAYOUT_EXPECTED_DETAILS_INVALID"
      );

      assert.equal(
        harness.state.horizonCalls,
        0
      );

      assert.equal(
        harness.state.rpcCalls,
        0
      );
    }
  }

  // 8. A missing verified Horizon payout must block owner settlement.
  {
    const harness = createHarness({
      horizonResult: null,
    });

    await expectCode(
      harness.markOwnerWithdrawalCompleted(
        REQUEST_ID,
        TXID
      ),
      "OWNER_PAYOUT_NOT_VERIFIED_ON_TESTNET"
    );

    assert.equal(
      harness.state.horizonCalls,
      1
    );

    assert.equal(
      harness.state.rpcCalls,
      0
    );

    assert.deepEqual(
      harness.state.events,
      ["read", "horizon"]
    );
  }

  // 9. A different Horizon TXID must never be settled.
  {
    const harness = createHarness({
      horizonResult: {
        hash: OTHER_TXID,
      },
    });

    await expectCode(
      harness.markOwnerWithdrawalCompleted(
        REQUEST_ID,
        TXID
      ),
      "OWNER_PAYOUT_TXID_MISMATCH"
    );

    assert.equal(
      harness.state.horizonCalls,
      1
    );

    assert.equal(
      harness.state.rpcCalls,
      0
    );
  }

  // 10. Horizon lookup errors must fail closed.
  {
    const harness = createHarness({
      horizonError: new Error(
        "TESTNET_PAYOUT_OPERATION_LOOKUP_FAILED"
      ),
    });

    await expectCode(
      harness.markOwnerWithdrawalCompleted(
        REQUEST_ID,
        TXID
      ),
      "TESTNET_PAYOUT_OPERATION_LOOKUP_FAILED"
    );

    assert.equal(
      harness.state.horizonCalls,
      1
    );

    assert.equal(
      harness.state.rpcCalls,
      0
    );

    assert.deepEqual(
      harness.state.events,
      ["read", "horizon"]
    );
  }

  // 11. Exact Testnet payout verification must precede settlement RPC.
  {
    const harness = createHarness();

    const result =
      await harness.markOwnerWithdrawalCompleted(
        REQUEST_ID,
        TXID
      );

    assert.equal(
      result.status,
      "completed"
    );

    assert.equal(
      result.txid,
      TXID
    );

    assert.equal(
      harness.state.table,
      "project_owner_withdrawals"
    );

    assert.equal(
      harness.state.filters.id,
      REQUEST_ID
    );

    assert.equal(
      harness.state.filters.network,
      "testnet"
    );

    assert.equal(
      harness.state.horizonCalls,
      1
    );

    assert.equal(
      harness.state.rpcCalls,
      1
    );

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
      AMOUNT
    );

    assert.deepEqual(
      harness.state.events,
      [
        "read",
        "horizon",
        "rpc",
      ]
    );

    assert.equal(
      harness.state.rpcArguments.name,
      "complete_testnet_project_owner_withdrawal"
    );

    assert.equal(
      harness.state.rpcArguments.args.p_withdrawal_id,
      REQUEST_ID
    );

    assert.equal(
      harness.state.rpcArguments.args.p_txid,
      TXID
    );

    assert.equal(
      harness.state.rpcArguments.args.p_reviewed_by,
      null
    );
  }

  // 12. A completed request with the same verified TXID is idempotent.
  {
    const harness = createHarness({
      row: {
        status: "completed",
        txid: TXID,
      },
    });

    const result =
      await harness.markOwnerWithdrawalCompleted(
        REQUEST_ID,
        TXID
      );

    assert.equal(
      result.status,
      "completed"
    );

    assert.equal(
      result.txid,
      TXID
    );

    assert.equal(
      harness.state.horizonCalls,
      1
    );

    assert.equal(
      harness.state.rpcCalls,
      0
    );

    assert.deepEqual(
      harness.state.events,
      [
        "read",
        "horizon",
      ]
    );
  }

  // 13. A completed request cannot accept a different stored TXID.
  {
    const harness = createHarness({
      row: {
        status: "completed",
        txid: OTHER_TXID,
      },
    });

    await expectCode(
      harness.markOwnerWithdrawalCompleted(
        REQUEST_ID,
        TXID
      ),
      "OWNER_WITHDRAWAL_ALREADY_COMPLETED_TXID_MISMATCH"
    );

    // Horizon must first confirm the supplied TXID.
    assert.equal(
      harness.state.horizonCalls,
      1
    );

    // A mismatched completed record must never call the settlement RPC.
    assert.equal(
      harness.state.rpcCalls,
      0
    );

    assert.deepEqual(
      harness.state.events,
      [
        "read",
        "horizon",
      ]
    );
  }

  // 14. Database settlement errors must be propagated.
  {
    const harness = createHarness({
      rpcError: {
        message: "SIMULATED_OWNER_SETTLEMENT_FAILURE",
      },
    });

    await expectCode(
      harness.markOwnerWithdrawalCompleted(
        REQUEST_ID,
        TXID
      ),
      "OWNER_PAYOUT_RECORDED_FAILED:SIMULATED_OWNER_SETTLEMENT_FAILURE"
    );

    assert.equal(
      harness.state.horizonCalls,
      1
    );

    assert.equal(
      harness.state.rpcCalls,
      1
    );

    assert.deepEqual(
      harness.state.events,
      [
        "read",
        "horizon",
        "rpc",
      ]
    );
  }

  // 15. An empty settlement response must not be treated as success.
  {
    const harness = createHarness({
      rpcResult: {
        data: null,
        error: null,
      },
    });

    await expectCode(
      harness.markOwnerWithdrawalCompleted(
        REQUEST_ID,
        TXID
      ),
      "OWNER_PAYOUT_RECORDED_FAILED:Database settlement returned no result."
    );

    assert.equal(
      harness.state.horizonCalls,
      1
    );

    assert.equal(
      harness.state.rpcCalls,
      1
    );
  }

  // 16. The actual source must retain the critical safety checks.
  const requiredChecks = [
    [
      "Testnet network isolation",
      /\.eq\("network", "testnet"\)/,
    ],
    [
      "owner withdrawal table",
      /\.from\("project_owner_withdrawals"\)/,
    ],
    [
      "processing/completed state gate",
      /!\["processing", "completed"\]\.includes\(/,
    ],
    [
      "expected destination wallet",
      /wallet_address:\s*withdrawal\.wallet_address/,
    ],
    [
      "exact requested amount",
      /amount:\s*expectedAmount/,
    ],
    [
      "Horizon payout verification",
      /findTestnetPayoutByMemo\(/,
    ],
    [
      "missing payout fails closed",
      /OWNER_PAYOUT_NOT_VERIFIED_ON_TESTNET/,
    ],
    [
      "Horizon TXID equality",
      /OWNER_PAYOUT_TXID_MISMATCH/,
    ],
    [
      "completed TXID consistency",
      /OWNER_WITHDRAWAL_ALREADY_COMPLETED_TXID_MISMATCH/,
    ],
    [
      "owner settlement RPC",
      /complete_testnet_project_owner_withdrawal/,
    ],
  ];

  for (const [label, pattern] of requiredChecks) {
    assert.match(
      settlementSource,
      pattern,
      "OWNER_SETTLEMENT_CHECK_MISSING:" + label
    );
  }

  const verificationIndex =
    settlementSource.indexOf(
      "const verifiedPayout = await findTestnetPayoutByMemo("
    );

  const settlementIndex =
    settlementSource.indexOf(
      "const settlement = await supabase.rpc("
    );

  assert.ok(
    verificationIndex >= 0 &&
    settlementIndex > verificationIndex,
    "OWNER_SETTLEMENT_RPC_MUST_RUN_AFTER_HORIZON_VERIFICATION"
  );

  assert.doesNotMatch(
    settlementSource,
    /return await supabase\.rpc\(/,
    "UNGUARDED_OWNER_SETTLEMENT_RPC_RETURN_FOUND"
  );

  console.log(JSON.stringify({
    suite: "owner-withdrawal-settlement-hardening-smoke",
    result: "PASS",

    actual_server_helper_executed: true,

    testnet_network_isolation: true,
    owner_record_read_required: true,
    invalid_state_rejected: true,
    invalid_wallet_rejected: true,
    invalid_amount_rejected: true,

    horizon_payout_required: true,
    exact_recipient_and_amount_passed_to_horizon: true,
    txid_must_match_horizon: true,
    horizon_errors_fail_closed: true,

    completed_request_is_idempotent: true,
    completed_txid_mismatch_rejected: true,

    settlement_rpc_runs_after_horizon_verification_only: true,
    settlement_rpc_error_propagated: true,
    empty_settlement_result_rejected: true,

    structural_checks: requiredChecks.length,

    real_horizon_requests: false,
    real_database_reads: false,
    database_writes: false,
    wallet_secrets_used: false,
    transactions_signed: false,
    payments_submitted: false,
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
