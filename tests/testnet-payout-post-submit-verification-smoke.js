
"use strict";

// Exercises actual Horizon lookup and post-submit verification functions
// extracted from server.js using a mocked Horizon server.
// No network, wallet secret, signing, Supabase write, or Pi payment is used.

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

const findFunctionSource =
  extractAsyncFunction("findTestnetPayoutByMemo");

const verifyFunctionSource =
  extractAsyncFunction("verifySubmittedTestnetPayout");

const submitFunctionSource =
  extractAsyncFunction("submitTestnetWithdrawalPayout");

const SOURCE = "GTESTNETAPPWALLET";
const DESTINATION = "GTESTNETDESTINATION";
const MEMO = "ALB-0123456789abcdef01234567";
const TXID = "a".repeat(64);
const OTHER_TXID = "b".repeat(64);
const AMOUNT = 1.2345678;

function validTransaction(hash = TXID) {
  return {
    hash,
    memo: MEMO,
    memo_type: "text",
    successful: true,
    source_account: SOURCE,
  };
}

function validOperation() {
  return {
    type: "payment",
    transaction_successful: true,
    asset_type: "native",
    from: SOURCE,
    to: DESTINATION,
    amount: AMOUNT.toFixed(7),
  };
}

function makeHarness(options = {}) {
  const state = {
    transactionLookups: 0,
    operationLookups: 0,
    delays: [],
    sourceAccount: null,
    order: null,
    limit: null,
    operationTxid: null,
    operationLimit: null,
  };

  const fakeServer = {
    transactions() {
      return {
        forAccount(account) {
          state.sourceAccount = account;

          return {
            order(direction) {
              state.order = direction;

              return {
                limit(count) {
                  state.limit = count;

                  return {
                    async call() {
                      state.transactionLookups += 1;

                      if (options.transactionError) {
                        throw options.transactionError;
                      }

                      if (typeof options.pageProvider === "function") {
                        return options.pageProvider(state);
                      }

                      return options.page || { records: [] };
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

                  if (options.operationError) {
                    throw options.operationError;
                  }

                  if (typeof options.operationProvider === "function") {
                    return options.operationProvider(hash, state);
                  }

                  return options.operations || { records: [] };
                },
              };
            },
          };
        },
      };
    },
  };

  const sandbox = {
    server: fakeServer,

    TESTNET_WITHDRAWAL_RECONCILE_LIMIT: 100,

    clean(value) {
      return String(value == null ? "" : value).trim();
    },

    numeric(value) {
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    },

    setTimeout(callback, milliseconds) {
      state.delays.push(milliseconds);
      callback();
      return 1;
    },
  };

  const find = vm.runInNewContext(
    "(" + findFunctionSource + ")",
    sandbox
  );

  sandbox.findTestnetPayoutByMemo = find;

  const verify = vm.runInNewContext(
    "(" + verifyFunctionSource + ")",
    sandbox
  );

  return { find, verify, state };
}

async function expectCode(
  promise,
  expectedCode,
  expectedStatus
) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.message, expectedCode);

    if (expectedStatus !== undefined) {
      assert.equal(error.status, expectedStatus);
    }

    return true;
  });
}

(async () => {
  const expected = {
    wallet_address: DESTINATION,
    amount: AMOUNT,
  };

  // 1. Exact successful native payment is accepted.
  {
    const harness = makeHarness({
      page: { records: [validTransaction()] },
      operations: { records: [validOperation()] },
    });

    const result = await harness.verify(
      SOURCE,
      MEMO,
      expected,
      TXID
    );

    assert.equal(result.hash, TXID);
    assert.equal(harness.state.transactionLookups, 1);
    assert.equal(harness.state.operationLookups, 1);
    assert.equal(harness.state.delays.length, 0);
    assert.equal(harness.state.sourceAccount, SOURCE);
    assert.equal(harness.state.order, "desc");
    assert.equal(harness.state.limit, 100);
    assert.equal(harness.state.operationTxid, TXID);
    assert.equal(harness.state.operationLimit, 200);
  }

  // 2. Horizon indexing delay is retried.
  {
    const harness = makeHarness({
      pageProvider(state) {
        return state.transactionLookups < 3
          ? { records: [] }
          : { records: [validTransaction()] };
      },

      operations: { records: [validOperation()] },
    });

    const result = await harness.verify(
      SOURCE,
      MEMO,
      expected,
      TXID
    );

    assert.equal(result.hash, TXID);
    assert.equal(harness.state.transactionLookups, 3);
    assert.deepEqual(harness.state.delays, [250, 500]);
    assert.equal(harness.state.operationLimit, 200);
  }

  // 3. Missing or malformed submitted TXID is rejected before Horizon lookup.
  {
    const harness = makeHarness({
      page: { records: [] },
    });

    await expectCode(
      harness.verify(SOURCE, MEMO, expected, ""),
      "TESTNET_PAYOUT_SUBMITTED_TXID_INVALID"
    );

    assert.equal(harness.state.transactionLookups, 0);
    assert.equal(harness.state.operationLookups, 0);
  }

  // 4. A different TXID returned by Horizon is rejected.
  {
    const harness = makeHarness({
      page: { records: [validTransaction(OTHER_TXID)] },
      operations: { records: [validOperation()] },
    });

    await expectCode(
      harness.verify(SOURCE, MEMO, expected, TXID),
      "TESTNET_PAYOUT_TXID_MISMATCH"
    );

    assert.equal(harness.state.transactionLookups, 1);
  }

  // 5. Wrong recipient is rejected even when the memo matches.
  {
    const badOperation = {
      ...validOperation(),
      to: "GWRONGDESTINATION",
    };

    const harness = makeHarness({
      page: { records: [validTransaction()] },
      operations: { records: [badOperation] },
    });

    await expectCode(
      harness.verify(SOURCE, MEMO, expected, TXID),
      "TESTNET_PAYOUT_MEMO_MATCH_INVALID"
    );

    assert.equal(harness.state.transactionLookups, 1);
  }

  // 6. Non-native asset is rejected.
  {
    const badOperation = {
      ...validOperation(),
      asset_type: "credit_alphanum4",
    };

    const harness = makeHarness({
      page: { records: [validTransaction()] },
      operations: { records: [badOperation] },
    });

    await expectCode(
      harness.verify(SOURCE, MEMO, expected, TXID),
      "TESTNET_PAYOUT_MEMO_MATCH_INVALID"
    );
  }

  // 7. Failed Horizon transaction is never accepted.
  {
    const failed = {
      ...validTransaction(),
      successful: false,
    };

    const harness = makeHarness({
      page: { records: [failed] },
    });

    await expectCode(
      harness.verify(SOURCE, MEMO, expected, TXID),
      "TESTNET_PAYOUT_NOT_VERIFIED_AFTER_SUBMISSION",
      503
    );

    assert.equal(harness.state.transactionLookups, 6);

    assert.deepEqual(
      harness.state.delays,
      [250, 500, 1000, 2000, 3000]
    );
  }

  // 8. Horizon operation lookup errors fail closed.
  {
    const harness = makeHarness({
      page: { records: [validTransaction()] },
      operationError: new Error("simulated Horizon error"),
    });

    await expectCode(
      harness.verify(SOURCE, MEMO, expected, TXID),
      "TESTNET_PAYOUT_OPERATION_LOOKUP_FAILED",
      503
    );

    assert.equal(harness.state.transactionLookups, 1);
    assert.equal(harness.state.operationLookups, 1);
    assert.equal(harness.state.operationLimit, 200);
  }

  // 9. The payout function must verify after submit and before returning.
  const submitAt = submitFunctionSource.indexOf(
    "await server.submitTransaction("
  );

  const verifyAt = submitFunctionSource.indexOf(
    "await verifySubmittedTestnetPayout("
  );

  const returnAt = submitFunctionSource.indexOf(
    "return {",
    verifyAt
  );

  const existingAt = submitFunctionSource.indexOf(
    "if (existing)"
  );

  assert.ok(
    existingAt >= 0 && existingAt < submitAt,
    "EXISTING_MEMO_CHECK_MUST_REMAIN_BEFORE_NEW_SUBMISSION"
  );

  assert.ok(
    submitAt >= 0 && verifyAt > submitAt && returnAt > verifyAt,
    "HORIZON_VERIFICATION_MUST_RUN_AFTER_SUBMIT_AND_BEFORE_RETURN"
  );

  assert.match(
    submitFunctionSource,
    /txid:\s*clean\(verifiedPayout\.hash\)\.toLowerCase\(\)/
  );

  assert.doesNotMatch(
    submitFunctionSource,
    /markWithdrawalCompleted\(/
  );

  // 10. Confirm the actual Horizon lookup retains all identity checks.
  const requiredChecks = [
    ["exact text memo", /tx\.memo_type !== "text"/],
    ["successful transaction", /tx\.successful !== true/],
    ["source account", /tx\.source_account/],
    ["payment operation", /operation\.type === "payment"/],
    ["successful operation", /operation\.transaction_successful === true/],
    ["native Pi asset", /operation\.asset_type === "native"/],
    ["operation sender", /operation\.from/],
    ["operation recipient", /operation\.to/],
    [
  "exact seven-decimal amount",
  /operationAmount\.toFixed\(7\)\s*===\s*expectedAmount\.toFixed\(7\)/,
],
  ];

  for (const [label, pattern] of requiredChecks) {
    assert.match(
      findFunctionSource,
      pattern,
      "HORIZON_CHECK_MISSING:" + label
    );
  }

  console.log(JSON.stringify({
    suite: "testnet-payout-post-submit-verification-smoke",
    result: "PASS",
    exact_horizon_payout_verified: true,
    submitted_txid_must_equal_horizon_txid: true,
    bounded_indexing_retry: true,
    incorrect_destination_rejected: true,
    non_native_asset_rejected: true,
    failed_transaction_rejected: true,
    horizon_lookup_error_fails_closed: true,
    operation_lookup_limit_verified: 200,
    settlement_remains_outside_payout_helper: true,
    real_network_requests: false,
    wallet_secrets_used: false,
    transactions_signed: false,
    payments_submitted: false,
    database_writes: false,
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
