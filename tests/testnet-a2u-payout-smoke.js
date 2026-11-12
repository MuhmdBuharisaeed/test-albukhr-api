"use strict";

const assert = require("node:assert/strict");
const createA2U = require("../testnet-a2u-payout");

const wallet = "G" + "A".repeat(55);
const appWallet = "G" + "B".repeat(55);
const requestId = "00000000-0000-4000-8000-000000000011";
const baseRow = {
  id: requestId,
  network: "testnet",
  pi_uid: "pi-user-1",
  wallet_address: wallet,
  requested_amount: 1.25,
  net_amount: 1.25,
  status: "processing",
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function makePayment(overrides) {
  const value = {
    identifier: "pi-payment-1",
    user_uid: "pi-user-1",
    amount: 1.25,
    memo: "ALBUKHR Testnet withdrawal",
    metadata: {
      albukhr_app: "ALBUKHR",
      network: "testnet",
      withdrawal_id: requestId,
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
  };
  return Object.assign(value, overrides || {});
}

function setup(initialPayment, incomplete) {
  const state = { payment: initialPayment ? clone(initialPayment) : null };
  const order = [];
  const counts = { submit: 0, complete: 0, create: 0, persistedId: 0, persistedTxid: 0 };
  const client = {
    async getIncompleteServerPayments() { return incomplete || []; },
    async createPayment(args) {
      counts.create += 1;
      assert.equal(args.uid, "pi-user-1");
      assert.equal(args.amount, 1.25);
      state.payment = makePayment({ metadata: args.metadata, amount: args.amount });
      return state.payment.identifier;
    },
    async getPayment(id) {
      assert.equal(id, "pi-payment-1");
      if (!state.payment) throw new Error("not found");
      return clone(state.payment);
    },
    async submitPayment(id) {
      assert.equal(id, "pi-payment-1");
      assert.equal(counts.persistedId, 1, "payment ID must be persisted before submit");
      counts.submit += 1;
      order.push("submit");
      state.payment.transaction = { txid: "PI_TESTNET_TXID_1", verified: false };
      return "PI_TESTNET_TXID_1";
    },
    async completePayment(id, txid) {
      counts.complete += 1;
      order.push("complete");
      assert.equal(txid, "PI_TESTNET_TXID_1");
      assert.equal(counts.persistedTxid, 1, "txid must be persisted before complete");
      state.payment.status.transaction_verified = true;
      state.payment.status.developer_completed = true;
      state.payment.transaction = { txid, verified: true };
      return clone(state.payment);
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
      assert.equal(requestRow.id, requestId);
      counts.persistedId += 1;
      order.push("persist-id");
    },
    persistTxid: async ({ txid, paymentId, sourceType, requestRow }) => {
      assert.equal(paymentId, "pi-payment-1");
      assert.equal(txid, "PI_TESTNET_TXID_1");
      assert.equal(sourceType, "staker_withdrawal");
      assert.equal(requestRow.id, requestId);
      counts.persistedTxid += 1;
      order.push("persist-txid");
    },
  });
  return { service, client, state, order, counts };
}

(async () => {
  // First payout: paymentId and txid must both be stored before their next step.
  const first = setup(null, []);
  const result = await first.service.submit(baseRow, "pi-user-1", "staker_withdrawal");
  assert.equal(result.paymentId, "pi-payment-1");
  assert.equal(result.txid, "PI_TESTNET_TXID_1");
  assert.deepEqual(first.order, ["persist-id", "submit", "persist-txid", "complete"]);

  // Retry after submit: Pi already reports txid; do not submit again.
  const submitted = makePayment({ transaction: { txid: "PI_TESTNET_TXID_1", verified: false } });
  const second = setup(submitted, []);
  const retry = await second.service.submit(
    { ...baseRow, a2u_payment_id: "pi-payment-1" },
    "pi-user-1",
    "staker_withdrawal"
  );
  assert.equal(retry.reconciled, true);
  assert.equal(second.counts.submit, 0);
  assert.equal(second.counts.complete, 1);

  // Stored paymentId but no Pi txid is ambiguous: fail closed, never resubmit.
  const uncertain = setup(makePayment(), []);
  await assert.rejects(
    () => uncertain.service.submit(
      { ...baseRow, a2u_payment_id: "pi-payment-1" },
      "pi-user-1",
      "staker_withdrawal"
    ),
    /PI_A2U_SUBMISSION_OUTCOME_UNCERTAIN/
  );
  assert.equal(uncertain.counts.submit, 0);

  // Recover a matching incomplete payment whose create response was lost.
  const recoveredPayment = makePayment();
  const recoveredSetup = setup(recoveredPayment, [recoveredPayment]);
  const recovered = await recoveredSetup.service.submit(baseRow, "pi-user-1", "staker_withdrawal");
  assert.equal(recovered.reconciled, true);
  assert.equal(recoveredSetup.counts.create, 0);
  assert.equal(recoveredSetup.counts.submit, 1);

  // Reconciliation is lookup/complete-only: it must never submit a payout.
  const completedPayment = makePayment({
    transaction: { txid: "PI_TESTNET_TXID_1", verified: true },
    status: {
      developer_approved: true,
      transaction_verified: true,
      developer_completed: true,
      cancelled: false,
      user_cancelled: false,
    },
  });
  const reconcileSetup = setup(completedPayment, []);
  const reconciled = await reconcileSetup.service.reconcile(
    { ...baseRow, a2u_payment_id: "pi-payment-1" },
    "pi-user-1",
    "staker_withdrawal"
  );
  assert.equal(reconciled.payoutFound, true);
  assert.equal(reconcileSetup.counts.submit, 0);

  // Invalid recipient and unrelated pending Pi payment are rejected.
  const badRecipient = setup(makePayment({ to_address: appWallet }), []);
  await assert.rejects(
    () => badRecipient.service.submit(
      { ...baseRow, a2u_payment_id: "pi-payment-1" },
      "pi-user-1",
      "staker_withdrawal"
    ),
    /PI_A2U_RECIPIENT_WALLET_MISMATCH/
  );
  assert.equal(badRecipient.counts.submit, 0);

  const unrelated = makePayment({
    metadata: { albukhr_app: "OTHER", network: "testnet", withdrawal_id: "other", source_type: "staker_withdrawal" },
  });
  const blocked = setup(null, [unrelated]);
  await assert.rejects(
    () => blocked.service.submit(baseRow, "pi-user-1", "staker_withdrawal"),
    /PI_A2U_OTHER_INCOMPLETE_PAYMENT/
  );
  assert.equal(blocked.counts.create, 0);

  // Owner requests must pay requested_amount (not a stale/different net_amount)
  // and must bind the payment metadata and UID to the owner workflow.
  const ownerRow = {
    ...baseRow,
    requested_amount: 2.5,
    net_amount: 1.1,
    owner_user_id: "owner-user-row-1",
  };
  const ownerPayment = makePayment({
    identifier: "pi-owner-payment-1",
    user_uid: "pi-owner-uid-1",
    amount: 2.5,
    metadata: {
      albukhr_app: "ALBUKHR",
      network: "testnet",
      withdrawal_id: requestId,
      source_type: "project_owner_withdrawal",
    },
  });
  const ownerState = { payment: null };
  const ownerCounts = { create: 0, submit: 0, complete: 0, persistedId: 0, persistedTxid: 0 };
  const ownerClient = {
    async getIncompleteServerPayments() { return []; },
    async createPayment(args) {
      ownerCounts.create += 1;
      assert.equal(args.uid, "pi-owner-uid-1");
      assert.equal(args.amount, 2.5);
      assert.equal(args.metadata.source_type, "project_owner_withdrawal");
      ownerState.payment = clone(ownerPayment);
      return ownerState.payment.identifier;
    },
    async getPayment(id) {
      assert.equal(id, "pi-owner-payment-1");
      return clone(ownerState.payment);
    },
    async submitPayment(id) {
      assert.equal(id, "pi-owner-payment-1");
      assert.equal(ownerCounts.persistedId, 1);
      ownerCounts.submit += 1;
      ownerState.payment.transaction = { txid: "PI_OWNER_TESTNET_TXID", verified: false };
      return "PI_OWNER_TESTNET_TXID";
    },
    async completePayment(id, txid) {
      assert.equal(id, "pi-owner-payment-1");
      assert.equal(txid, "PI_OWNER_TESTNET_TXID");
      assert.equal(ownerCounts.persistedTxid, 1);
      ownerCounts.complete += 1;
      ownerState.payment.status.transaction_verified = true;
      ownerState.payment.status.developer_completed = true;
      ownerState.payment.transaction = { txid, verified: true };
      return clone(ownerState.payment);
    },
  };
  const ownerService = createA2U({
    apiKey: "test-key",
    walletPrivateSeed: "S" + "A".repeat(55),
    appWallet,
    createPiClient: () => ownerClient,
    persistPaymentId: async ({ paymentId, sourceType }) => {
      assert.equal(paymentId, "pi-owner-payment-1");
      assert.equal(sourceType, "project_owner_withdrawal");
      ownerCounts.persistedId += 1;
    },
    persistTxid: async ({ paymentId, txid, sourceType }) => {
      assert.equal(paymentId, "pi-owner-payment-1");
      assert.equal(txid, "PI_OWNER_TESTNET_TXID");
      assert.equal(sourceType, "project_owner_withdrawal");
      ownerCounts.persistedTxid += 1;
    },
  });
  const ownerResult = await ownerService.submit(
    ownerRow,
    "pi-owner-uid-1",
    "project_owner_withdrawal"
  );
  assert.equal(ownerResult.txid, "PI_OWNER_TESTNET_TXID");
  assert.equal(ownerCounts.create, 1);
  assert.equal(ownerCounts.submit, 1);
  assert.equal(ownerCounts.complete, 1);

  console.log(JSON.stringify({
    a2u_success: true,
    payment_id_persisted_before_submit: true,
    txid_persisted_before_complete: true,
    retry_does_not_double_submit: true,
    uncertain_stored_payment_fails_closed: true,
    incomplete_payment_recovery: true,
    reconciliation_never_submits: true,
    recipient_mismatch_rejected: true,
    unrelated_incomplete_payment_preserved: true,
    owner_uid_and_requested_amount_verified: true,
    real_pi_payment_or_payout: false,
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
