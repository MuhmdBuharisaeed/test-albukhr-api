"use strict";

const assert = require("node:assert/strict");
const createA2U = require("../testnet-a2u-payout");

const wallet = "G" + "A".repeat(55);
const appWallet = "G" + "B".repeat(55);
const baseRow = {
  id: "00000000-0000-4000-8000-000000000011",
  network: "testnet",
  pi_uid: "pi-user-1",
  wallet_address: wallet,
  requested_amount: 1.25,
  net_amount: 1.25,
  status: "processing",
};

function payment(overrides) {
  return Object.assign({
    identifier: "pi-payment-1",
    user_uid: "pi-user-1",
    amount: 1.25,
    memo: "ALBUKHR Testnet withdrawal",
    metadata: {
      albukhr_app: "ALBUKHR",
      network: "testnet",
      withdrawal_id: baseRow.id,
      source_type: "staker_withdrawal",
    },
    from_address: appWallet,
    to_address: wallet,
    direction: "app_to_user",
    network: "Pi Testnet",
    status: {
      developer_approved: true,
      transaction_verified: false,
      developer_completed: false,
      cancelled: false,
      user_cancelled: false,
    },
    transaction: null,
  }, overrides || {});
}

function setup(initialPayment, incomplete) {
  let persisted = false;
  let submitCalls = 0;
  let completeCalls = 0;
  let createCalls = 0;
  let state = initialPayment ? structuredClone(initialPayment) : null;
  const client = {
    async getIncompleteServerPayments() { return incomplete || []; },
    async createPayment(args) {
      createCalls += 1;
      assert.equal(args.uid, "pi-user-1");
      assert.equal(args.amount, 1.25);
      state = payment({ metadata: args.metadata, amount: args.amount });
      return state.identifier;
    },
    async getPayment(id) {
      assert.equal(id, "pi-payment-1");
      return structuredClone(state);
    },
    async submitPayment(id) {
      assert.equal(persisted, true, "payment id must be persisted before submit");
      submitCalls += 1;
      state.transaction = { txid: "PI_TESTNET_TXID_1", verified: false };
      return "PI_TESTNET_TXID_1";
    },
    async completePayment(id, txid) {
      completeCalls += 1;
      assert.equal(txid, "PI_TESTNET_TXID_1");
      state.status.transaction_verified = true;
      state.status.developer_completed = true;
      state.transaction = { txid, verified: true };
      return structuredClone(state);
    },
  };
  const service = createA2U({
    apiKey: "test-key",
    walletPrivateSeed: "S" + "A".repeat(55),
    appWallet,
    createPiClient: () => client,
    persistPaymentId: async ({ paymentId, sourceType, requestRow }) => {
      assert.equal(paymentId, "pi-payment-1");
      assert.equal(sourceType, "staker_withdrawal");
      assert.equal(requestRow.id, baseRow.id);
      persisted = true;
    },
  });
  return { service, client, counts: () => ({ persisted, submitCalls, completeCalls, createCalls }) };
}

(async () => {
  // New A2U payment: persist payment id, submit once, complete and verify.
  const first = setup(null, []);
  const result = await first.service.submit(baseRow, "pi-user-1", "staker_withdrawal");
  assert.equal(result.paymentId, "pi-payment-1");
  assert.equal(result.txid, "PI_TESTNET_TXID_1");
  assert.deepEqual(first.counts(), {
    persisted: true, submitCalls: 1, completeCalls: 1, createCalls: 1,
  });

  // Resume an existing Pi payment that already has a txid: never resubmit.
  const existing = payment({
    transaction: { txid: "PI_TESTNET_TXID_1", verified: false },
  });
  const second = setup(existing, []);
  const retry = await second.service.submit(
    { ...baseRow, a2u_payment_id: "pi-payment-1" },
    "pi-user-1",
    "staker_withdrawal"
  );
  assert.equal(retry.reconciled, true);
  assert.equal(second.counts().submitCalls, 0);
  assert.equal(second.counts().createCalls, 0);
  assert.equal(second.counts().completeCalls, 1);

  // Recover a Pi incomplete payment if its id was not persisted before a crash.
  const recoveredPayment = payment();
  const third = setup(recoveredPayment, [recoveredPayment]);
  const recovered = await third.service.submit(baseRow, "pi-user-1", "staker_withdrawal");
  assert.equal(recovered.reconciled, true);
  assert.equal(third.counts().createCalls, 0);
  assert.equal(third.counts().persisted, true);

  // Recipient mismatch must stop before submit or completion.
  const badRecipient = setup(payment({ to_address: appWallet }), []);
  await assert.rejects(
    () => badRecipient.service.submit({ ...baseRow, a2u_payment_id: "pi-payment-1" }, "pi-user-1", "staker_withdrawal"),
    /PI_A2U_RECIPIENT_WALLET_MISMATCH/
  );
  assert.equal(badRecipient.counts().submitCalls, 0);

  // A different incomplete Pi payment blocks creation; it is never overwritten.
  const unrelated = payment({
    metadata: { albukhr_app: "OTHER", network: "testnet", withdrawal_id: "other", source_type: "staker_withdrawal" },
  });
  const fourth = setup(null, [unrelated]);
  await assert.rejects(
    () => fourth.service.submit(baseRow, "pi-user-1", "staker_withdrawal"),
    /PI_A2U_OTHER_INCOMPLETE_PAYMENT/
  );
  assert.equal(fourth.counts().createCalls, 0);

  console.log(JSON.stringify({
    a2u_success: true,
    payment_id_persisted_before_submit: true,
    retries_do_not_double_submit: true,
    incomplete_payment_recovery: true,
    recipient_mismatch_rejected: true,
    unrelated_incomplete_payment_preserved: true,
    real_pi_payment_or_payout: false,
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
