
"use strict";

// ALBUKHR Testnet Horizon pagination regression.
// Uses mocked Horizon pages only.
// No network requests, signing, wallet secrets, payments or DB writes.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "server.js"),
  "utf8"
);

function extractFunction(name) {
  const pattern = new RegExp(
    "async function " + name + "\\([\\s\\S]*?\\n\\}"
  );

  const match = source.match(pattern);

  assert.ok(
    match,
    name.toUpperCase() + "_NOT_FOUND"
  );

  return match[0];
}

const functionSource = extractFunction(
  "findTestnetPayoutByMemo"
);

const SOURCE = "GTESTNETAPPWALLET";
const DESTINATION = "GTESTNETDESTINATION";
const MEMO = "ALB-0123456789abcdef01234567";
const TXID = "a".repeat(64);
const AMOUNT = 1.25;

function transaction(hash = TXID) {
  return {
    hash,
    memo: MEMO,
    memo_type: "text",
    successful: true,
    source_account: SOURCE,
  };
}

function paymentOperation() {
  return {
    type: "payment",
    transaction_successful: true,
    asset_type: "native",
    from: SOURCE,
    to: DESTINATION,
    amount: AMOUNT.toFixed(7),
  };
}

function makePage(records, nextPage) {
  return {
    records,
    async next() {
      if (nextPage instanceof Error) {
        throw nextPage;
      }

      return nextPage || makePage([], null);
    },
  };
}


function harness(options = {}) {
  const state = {
    transactionPageCalls: 0,
    operationPageCalls: 0,
    operationTxids: [],
    transactionLimits: [],
    operationLimits: [],
  };

  function connectPages(pages, onNext) {
    const connected = [];

    for (let index = 0; index < pages.length; index += 1) {
      const originalPage = pages[index];

      connected.push({
        records: originalPage.records || [],

        async next() {
          onNext();

          if (index + 1 < pages.length) {
            return connected[index + 1];
          }

          return originalPage.next();
        },
      });
    }

    return connected;
  }

  const transactionPages = connectPages(
    options.transactionPages || [],
    () => {
      state.transactionPageCalls += 1;
    }
  );

  const operationPages = connectPages(
    options.operationPages || [],
    () => {
      state.operationPageCalls += 1;
    }
  );

  const fakeServer = {
    transactions() {
      return {
        forAccount(account) {
          assert.equal(account, SOURCE);

          return {
            order(direction) {
              assert.equal(direction, "desc");

              return {
                limit(limit) {
                  state.transactionLimits.push(limit);

                  return {
                    async call() {
                      state.transactionPageCalls += 1;

                      if (options.transactionError) {
                        throw options.transactionError;
                      }

                      return transactionPages[
                        state.transactionPageCalls - 1
                      ] || makePage([], null);
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
          state.operationTxids.push(hash);

          return {
            limit(limit) {
              state.operationLimits.push(limit);

              return {
                async call() {
                  state.operationPageCalls += 1;

                  if (options.operationError) {
                    throw options.operationError;
                  }

                  return operationPages[
                    state.operationPageCalls - 1
                  ] || makePage([], null);
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
  };

  const find = vm.runInNewContext(
    "(" + functionSource + ")",
    sandbox
  );

  return { find, state };
}

async function expectCode(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.message, code);

    if (status !== undefined) {
      assert.equal(error.status, status);
    }

    return true;
  });
}

(async () => {
  const expected = {
    wallet_address: DESTINATION,
    amount: AMOUNT,
  };

  // 1. A valid payment on the first page is accepted.
  {
    const h = harness({
      transactionPages: [
        makePage([transaction()], null),
      ],
      operationPages: [
        makePage([paymentOperation()], null),
      ],
    });

    const result = await h.find(
      SOURCE,
      MEMO,
      expected
    );

    assert.equal(result.hash, TXID);
    assert.equal(h.state.transactionPageCalls, 1);
    assert.equal(h.state.operationPageCalls, 1);
    assert.deepEqual(h.state.transactionLimits, [100]);
    assert.deepEqual(h.state.operationLimits, [200]);
  }

  // 2. A valid payout on the second transaction page is found.
  {
    const h = harness({
      transactionPages: [
        makePage([{ hash: "older-unrelated" }]),
        makePage([transaction()], null),
      ],
      operationPages: [
        makePage([paymentOperation()], null),
      ],
    });

    const result = await h.find(
      SOURCE,
      MEMO,
      expected
    );

    assert.equal(result.hash, TXID);
    assert.equal(h.state.transactionPageCalls, 2);
  }

  // 3. A valid operation on the second operation page is found.
  {
    const h = harness({
      transactionPages: [
        makePage([transaction()], null),
      ],
      operationPages: [
        makePage([{ type: "create_account" }]),
        makePage([paymentOperation()], null),
      ],
    });

    const result = await h.find(
      SOURCE,
      MEMO,
      expected
    );

    assert.equal(result.hash, TXID);
    assert.equal(h.state.operationPageCalls, 2);
  }

  // 4. No payout after a complete transaction scan returns null.
  {
    const h = harness({
      transactionPages: [
        makePage([{ hash: "unrelated-one" }]),
        makePage([{ hash: "unrelated-two" }]),
        makePage([], null),
      ],
      operationPages: [],
    });

    const result = await h.find(
      SOURCE,
      MEMO,
      expected
    );

    assert.equal(result, null);
    assert.equal(h.state.transactionPageCalls, 3);
  }

  // 5. More transaction pages than the bound must fail closed.
  {
    const pages = [
      makePage([{ hash: "page-1" }]),
      makePage([{ hash: "page-2" }]),
      makePage([{ hash: "page-3" }]),
      makePage([{ hash: "page-4" }]),
      makePage([{ hash: "page-5" }]),
      makePage([{ hash: "page-6" }]),
    ];

    const h = harness({
      transactionPages: pages,
      operationPages: [],
    });

    await expectCode(
      h.find(SOURCE, MEMO, expected),
      "TESTNET_PAYOUT_RECONCILE_SCAN_INCOMPLETE",
      503
    );

    assert.equal(h.state.transactionPageCalls, 6);
  }

  // 6. More operation pages than the bound must fail closed.
  {
    const pages = [
      makePage([{ type: "create_account" }]),
      makePage([{ type: "create_account" }]),
      makePage([{ type: "create_account" }]),
      makePage([{ type: "create_account" }]),
      makePage([{ type: "create_account" }]),
      makePage([{ type: "create_account" }]),
    ];

    const h = harness({
      transactionPages: [
        makePage([transaction()], null),
      ],
      operationPages: pages,
    });

    await expectCode(
      h.find(SOURCE, MEMO, expected),
      "TESTNET_PAYOUT_RECONCILE_SCAN_INCOMPLETE",
      503
    );

    assert.equal(h.state.operationPageCalls, 6);
  }

  // 7. Transaction Horizon errors fail closed.
  {
    const h = harness({
      transactionError: new Error("simulated transaction error"),
    });

    await expectCode(
      h.find(SOURCE, MEMO, expected),
      "TESTNET_PAYOUT_TRANSACTION_LOOKUP_FAILED",
      503
    );
  }

  // 8. Operation Horizon errors fail closed.
  {
    const h = harness({
      transactionPages: [
        makePage([transaction()], null),
      ],
      operationError: new Error("simulated operation error"),
    });

    await expectCode(
      h.find(SOURCE, MEMO, expected),
      "TESTNET_PAYOUT_OPERATION_LOOKUP_FAILED",
      503
    );
  }

  // 9. An invalid payment must never be accepted.
  {
    const invalid = {
      ...paymentOperation(),
      to: "GWRONGDESTINATION",
    };

    const h = harness({
      transactionPages: [
        makePage([transaction()], null),
      ],
      operationPages: [
        makePage([invalid], null),
      ],
    });

    await expectCode(
      h.find(SOURCE, MEMO, expected),
      "TESTNET_PAYOUT_MEMO_MATCH_INVALID"
    );
  }

  console.log(JSON.stringify({
    suite: "testnet-payout-reconciliation-pagination-smoke",
    result: "PASS",
    transaction_pagination: true,
    operation_pagination: true,
    bounded_scan: true,
    incomplete_scan_fails_closed: true,
    horizon_errors_fail_closed: true,
    exact_wallet_and_amount_required: true,
    real_network_requests: false,
    wallet_secrets_used: false,
    payments_submitted: false,
    database_writes: false,
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
