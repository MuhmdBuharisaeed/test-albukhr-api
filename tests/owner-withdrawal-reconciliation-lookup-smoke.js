
"use strict";

// ALBUKHR Testnet Owner Withdrawal Reconciliation Lookup Regression.
//
// Executes the actual findTestnetWithdrawalPayoutByMemo() and
// findTestnetPayoutByMemo() helpers extracted from server.js.
//
// Uses mocked Supabase and Horizon dependencies only.
// No real network requests, database writes, wallet secrets,
// transaction signing, or Pi payments are performed.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "server.js"),
  "utf8"
);

const routerSource = fs.readFileSync(
  path.join(__dirname, "..", "testnet-outflow-fee-router.js"),
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

const memoLookupSource = extractAsyncFunction(
  "findTestnetPayoutByMemo"
);

const ownerLookupSource = extractAsyncFunction(
  "findTestnetWithdrawalPayoutByMemo"
);

const REQUEST_ID =
  "00000000-0000-4000-8000-000000000091";

const OTHER_REQUEST_ID =
  "00000000-0000-4000-8000-000000000092";

const SOURCE = "GTESTNETOWNERPAYOUTSOURCE";
const DESTINATION = "GTESTNETOWNERDESTINATION";
const WRONG_DESTINATION = "GTESTNETWRONGDESTINATION";

const MEMO = "ALB-0123456789abcdef01234567";

const TXID = "a".repeat(64);
const AMOUNT = 1.2345678;

function validTransaction(overrides = {}) {
  return {
    hash: TXID,
    memo: MEMO,
    memo_type: "text",
    successful: true,
    source_account: SOURCE,
    ...overrides,
  };
}

function validOperation(overrides = {}) {
  return {
    type: "payment",
    transaction_successful: true,
    asset_type: "native",
    from: SOURCE,
    to: DESTINATION,
    amount: AMOUNT.toFixed(7),
    ...overrides,
  };
}

function makePage(records) {
  return {
    records,

    async next() {
      return {
        records: [],

        async next() {
          return {
            records: [],
            async next() {
              return { records: [] };
            },
          };
        },
      };
    },
  };
}

function createHarness(options = {}) {
  const row = {
    id: REQUEST_ID,
    network: "testnet",
    wallet_address: DESTINATION,
    requested_amount: AMOUNT,
    ...(options.row || {}),
  };

  const state = {
    databaseReads: 0,
    transactionLookups: 0,
    operationLookups: 0,

    table: null,
    selected: null,
    filters: {},

    transactionSource: null,
    transactionOrder: null,
    transactionLimit: null,

    operationTxid: null,
    operationLimit: null,

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
          state.databaseReads += 1;
          state.events.push("database_read");

          if (options.databaseError) {
            return {
              data: null,
              error: options.databaseError,
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
  };

  const server = {
    transactions() {
      return {
        forAccount(account) {
          state.transactionSource = account;

          return {
            order(direction) {
              state.transactionOrder = direction;

              return {
                limit(count) {
                  state.transactionLimit = count;

                  return {
                    async call() {
                      state.transactionLookups += 1;
                      state.events.push("transaction_lookup");

                      if (options.transactionError) {
                        throw options.transactionError;
                      }

                      return makePage(
                        options.transactions === undefined
                          ? [validTransaction()]
                          : options.transactions
                      );
                    },
                  };
                },
              };
            },
          };
        },
      };
    },

    operations() {
      return {
        forTransaction(hash) {
          state.operationTxid = hash;

          return {
            limit(count) {
              state.operationLimit = count;

              return {
                async call() {
                  state.operationLookups += 1;
                  state.events.push("operation_lookup");

                  if (options.operationError) {
                    throw options.operationError;
                  }

                  return makePage(
                    options.operations === undefined
                      ? [validOperation()]
                      : options.operations
                  );
                },
              };
            },
          };
        },
      };
    },
  };

  const sandbox = {
    supabase,
    server,

    TESTNET_WITHDRAWAL_RECONCILE_LIMIT: 100,

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
  };

  const findTestnetPayoutByMemo =
    vm.runInNewContext(
      "(" + memoLookupSource + ")",
      sandbox
    );

  sandbox.findTestnetPayoutByMemo =
    findTestnetPayoutByMemo;

  const findTestnetWithdrawalPayoutByMemo =
    vm.runInNewContext(
      "(" + ownerLookupSource + ")",
      sandbox
    );

  return {
    findTestnetWithdrawalPayoutByMemo,
    state,
  };
}

async function expectCode(
  promise,
  expectedCode,
  expectedStatus
) {
  await assert.rejects(
    promise,
    (error) => {
      assert.equal(
        error.message,
        expectedCode
      );

      if (expectedStatus !== undefined) {
        assert.equal(
          error.status,
          expectedStatus
        );
      }

      return true;
    }
  );
}

(async () => {
  // 1. Exact verified owner payout is returned for reconciliation.
  {
    const harness = createHarness();

    const result =
      await harness.findTestnetWithdrawalPayoutByMemo(
        REQUEST_ID
      );

        assert.ok(
      result && typeof result === "object",
      "VERIFIED_OWNER_PAYOUT_RESULT_REQUIRED"
    );

    assert.equal(
      result.txid,
      TXID,
      "VERIFIED_PAYOUT_TXID_MISMATCH"
    );

    assert.equal(
      result.memo,
      MEMO,
      "VERIFIED_PAYOUT_MEMO_MISMATCH"
    );

    assert.equal(
      result.reconciled,
      true,
      "OWNER_PAYOUT_MUST_BE_MARKED_RECONCILED"
    );

    assert.deepEqual(
      Object.keys(result).sort(),
      ["memo", "reconciled", "txid"]
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
      harness.state.transactionSource,
      SOURCE
    );

    assert.equal(
      harness.state.transactionOrder,
      "desc"
    );

    assert.equal(
      harness.state.transactionLimit,
      100
    );

    assert.equal(
      harness.state.operationTxid,
      TXID
    );

    assert.equal(
      harness.state.operationLimit,
      200
    );

    assert.deepEqual(
      harness.state.events,
      [
        "database_read",
        "transaction_lookup",
        "operation_lookup",
      ]
    );
  }

  // 2. Empty request ID must fail before database access.
  {
    const harness = createHarness();

    await expectCode(
      harness.findTestnetWithdrawalPayoutByMemo(""),
      "REQUEST_ID_REQUIRED"
    );

    assert.equal(
      harness.state.databaseReads,
      0
    );

    assert.equal(
      harness.state.transactionLookups,
      0
    );
  }

  // 3. Database read errors must fail closed.
  {
    const harness = createHarness({
      databaseError: {
        message: "SIMULATED_OWNER_READ_ERROR",
      },
    });

    await expectCode(
      harness.findTestnetWithdrawalPayoutByMemo(
        REQUEST_ID
      ),
      "OWNER_WITHDRAWAL_READ_FAILED"
    );

    assert.equal(
      harness.state.databaseReads,
      1
    );

    assert.equal(
      harness.state.transactionLookups,
      0
    );
  }

  // 4. Missing owner request must not reach Horizon.
  {
    const harness = createHarness({
      row: {
        id: OTHER_REQUEST_ID,
      },
    });

    await expectCode(
      harness.findTestnetWithdrawalPayoutByMemo(
        REQUEST_ID
      ),
      "OWNER_WITHDRAWAL_NOT_FOUND"
    );

    assert.equal(
      harness.state.filters.network,
      "testnet"
    );

    assert.equal(
      harness.state.transactionLookups,
      0
    );
  }

  // 5. Mainnet records must not be used for Testnet reconciliation.
  {
    const harness = createHarness({
      row: {
        network: "mainnet",
      },
    });

    await expectCode(
      harness.findTestnetWithdrawalPayoutByMemo(
        REQUEST_ID
      ),
      "OWNER_WITHDRAWAL_NOT_FOUND"
    );

    assert.equal(
      harness.state.filters.network,
      "testnet"
    );

    assert.equal(
      harness.state.transactionLookups,
      0
    );
  }

  // 6. No matching transaction must return null without payout.
  {
    const harness = createHarness({
      transactions: [
        validTransaction({
          memo: "ALB-UNRELATED-MEMO",
        }),
      ],
    });

    const result =
      await harness.findTestnetWithdrawalPayoutByMemo(
        REQUEST_ID
      );

    assert.equal(result, null);

    assert.equal(
      harness.state.transactionLookups,
      1
    );

    assert.equal(
      harness.state.operationLookups,
      0
    );
  }

  // 7. Wrong transaction source must never be accepted.
  {
    const harness = createHarness({
      transactions: [
        validTransaction({
          source_account: "GWRONGSOURCE",
        }),
      ],
    });

    await expectCode(
      harness.findTestnetWithdrawalPayoutByMemo(
        REQUEST_ID
      ),
      "TESTNET_PAYOUT_MEMO_MATCH_INVALID"
    );

    assert.equal(
      harness.state.operationLookups,
      0
    );
  }

  // 8. Wrong destination must fail closed.
  {
    const harness = createHarness({
      operations: [
        validOperation({
          to: WRONG_DESTINATION,
        }),
      ],
    });

    await expectCode(
      harness.findTestnetWithdrawalPayoutByMemo(
        REQUEST_ID
      ),
      "TESTNET_PAYOUT_MEMO_MATCH_INVALID"
    );

    assert.equal(
      harness.state.operationLookups,
      1
    );
  }

  // 9. Wrong amount must fail closed.
  {
    const harness = createHarness({
      operations: [
        validOperation({
          amount: "9.0000000",
        }),
      ],
    });

    await expectCode(
      harness.findTestnetWithdrawalPayoutByMemo(
        REQUEST_ID
      ),
      "TESTNET_PAYOUT_MEMO_MATCH_INVALID"
    );

    assert.equal(
      harness.state.operationLookups,
      1
    );
  }

  // 10. Non-native asset must never be accepted.
  {
    const harness = createHarness({
      operations: [
        validOperation({
          asset_type: "credit_alphanum4",
        }),
      ],
    });

    await expectCode(
      harness.findTestnetWithdrawalPayoutByMemo(
        REQUEST_ID
      ),
      "TESTNET_PAYOUT_MEMO_MATCH_INVALID"
    );

    assert.equal(
      harness.state.operationLookups,
      1
    );
  }

  // 11. Transaction Horizon errors must fail closed.
  {
    const harness = createHarness({
      transactionError: new Error(
        "SIMULATED_TRANSACTION_LOOKUP_ERROR"
      ),
    });

    await expectCode(
      harness.findTestnetWithdrawalPayoutByMemo(
        REQUEST_ID
      ),
      "TESTNET_PAYOUT_TRANSACTION_LOOKUP_FAILED",
      503
    );

    assert.equal(
      harness.state.operationLookups,
      0
    );
  }

  // 12. Operation Horizon errors must fail closed.
  {
    const harness = createHarness({
      operationError: new Error(
        "SIMULATED_OPERATION_LOOKUP_ERROR"
      ),
    });

    await expectCode(
      harness.findTestnetWithdrawalPayoutByMemo(
        REQUEST_ID
      ),
      "TESTNET_PAYOUT_OPERATION_LOOKUP_FAILED",
      503
    );

    assert.equal(
      harness.state.transactionLookups,
      1
    );

    assert.equal(
      harness.state.operationLookups,
      1
    );
  }

  // 13. Invalid owner wallet must not result in a verified payout.
  {
    const harness = createHarness({
      row: {
        wallet_address: "",
      },
    });

    await expectCode(
      harness.findTestnetWithdrawalPayoutByMemo(
        REQUEST_ID
      ),
      "TESTNET_PAYOUT_EXPECTED_DETAILS_REQUIRED"
    );

    assert.equal(
      harness.state.transactionLookups,
      0
    );
  }

  // 14. Invalid owner amount must not result in a verified payout.
  {
    const harness = createHarness({
      row: {
        requested_amount: 0,
      },
    });

    await expectCode(
      harness.findTestnetWithdrawalPayoutByMemo(
        REQUEST_ID
      ),
      "TESTNET_PAYOUT_EXPECTED_DETAILS_REQUIRED"
    );

    assert.equal(
      harness.state.transactionLookups,
      0
    );
  }

  // 15. Confirm the actual owner reconciliation route is lookup-only.
  const routeStart = routerSource.indexOf(
    'router.post("/owner/reconcile"'
  );

  const routeEnd = routerSource.indexOf(
    "  return router;",
    routeStart
  );

  assert.ok(
    routeStart >= 0 && routeEnd > routeStart,
    "OWNER_RECONCILE_ROUTE_NOT_FOUND"
  );

  const ownerReconcileRoute = routerSource.slice(
    routeStart,
    routeEnd
  );

  const lookupIndex =
    ownerReconcileRoute.indexOf(
      "findTestnetWithdrawalPayoutByMemo("
    );

  const feeGuardIndex =
    ownerReconcileRoute.indexOf(
      "assertOwnerOutflowFeeReady("
    );

  const settlementIndex =
    ownerReconcileRoute.indexOf(
      "markOwnerWithdrawalCompleted("
    );

  assert.ok(
    lookupIndex >= 0,
    "OWNER_RECONCILE_LOOKUP_HELPER_REQUIRED"
  );

  assert.ok(
    feeGuardIndex > lookupIndex,
    "OWNER_FEE_GUARD_MUST_FOLLOW_VERIFIED_LOOKUP"
  );

  assert.ok(
    settlementIndex > feeGuardIndex,
    "OWNER_SETTLEMENT_MUST_FOLLOW_FEE_GUARD"
  );

  assert.match(
    ownerReconcileRoute,
    /withdrawal\.status !== "processing"/,
    "OWNER_RECONCILE_MUST_REQUIRE_PROCESSING_STATE"
  );

  assert.match(
    ownerReconcileRoute,
    /payoutFound:\s*false/,
    "MISSING_PAYOUT_MUST_RETURN_NOT_FOUND"
  );

  assert.doesNotMatch(
    ownerReconcileRoute,
    /submitTestnetWithdrawalPayout\(/,
    "OWNER_RECONCILIATION_MUST_NEVER_SUBMIT_A_NEW_PAYOUT"
  );

  console.log(JSON.stringify({
    suite: "owner-withdrawal-reconciliation-lookup-smoke",
    result: "PASS",

    actual_owner_lookup_helper_executed: true,
    actual_horizon_lookup_helper_executed: true,

    testnet_network_isolation: true,
    owner_request_id_required: true,
    owner_request_read_required: true,

    exact_memo_required: true,
    exact_source_wallet_required: true,
    exact_destination_required: true,
    exact_amount_required: true,
    native_asset_required: true,

    transaction_lookup_errors_fail_closed: true,
    operation_lookup_errors_fail_closed: true,

    invalid_owner_wallet_rejected: true,
    invalid_owner_amount_rejected: true,

    missing_payout_returns_null: true,
    reconciliation_route_is_lookup_only: true,
    fee_guard_precedes_settlement: true,

    structural_route_checks: 6,

    real_network_requests: false,
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
