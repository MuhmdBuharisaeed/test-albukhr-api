"use strict";

const TABLE_BY_SOURCE = Object.freeze({
  staker_withdrawal: "withdrawal_requests",
  project_owner_withdrawal: "project_owner_withdrawals",
});

function clean(value) {
  return String(value == null ? "" : value).trim();
}

function assertTestnetRow(requestRow, sourceType) {
  if (!requestRow || !clean(requestRow.id)) {
    throw new Error("A2U_WITHDRAWAL_ID_REQUIRED");
  }
  if (clean(requestRow.network).toLowerCase() !== "testnet") {
    throw new Error("A2U_TESTNET_ONLY");
  }
  if (!TABLE_BY_SOURCE[sourceType]) {
    throw new Error("A2U_WITHDRAWAL_SOURCE_INVALID");
  }
  if (clean(requestRow.status).toLowerCase() !== "processing") {
    throw new Error("A2U_WITHDRAWAL_NOT_PROCESSING");
  }
}

function createTestnetA2UService(options) {
  options = options || {};
  const supabase = options.supabase;
  if (!supabase || typeof supabase.from !== "function") {
    throw new Error("A2U_SUPABASE_CLIENT_REQUIRED");
  }

  async function readCurrent(sourceType, requestId) {
    const table = TABLE_BY_SOURCE[sourceType];
    const result = await supabase
      .from(table)
      .select("id,network,status,a2u_payment_id,txid")
      .eq("id", requestId)
      .eq("network", "testnet")
      .maybeSingle();

    if (result.error) {
      throw new Error("A2U_PERSISTENCE_READ_FAILED");
    }
    if (!result.data) {
      throw new Error("A2U_WITHDRAWAL_NOT_FOUND");
    }
    return result.data;
  }

  async function persistPaymentId({ requestRow, sourceType, paymentId }) {
    assertTestnetRow(requestRow, sourceType);
    const id = clean(paymentId);
    if (!id) throw new Error("A2U_PAYMENT_ID_REQUIRED");

    const table = TABLE_BY_SOURCE[sourceType];
    const result = await supabase
      .from(table)
      .update({
        a2u_payment_id: id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestRow.id)
      .eq("network", "testnet")
      .eq("status", "processing")
      .is("a2u_payment_id", null)
      .select("id,network,status,a2u_payment_id,txid")
      .maybeSingle();

    if (result.error) {
      throw new Error("A2U_PAYMENT_ID_PERSIST_FAILED");
    }
    if (result.data && clean(result.data.a2u_payment_id) === id) {
      return result.data;
    }

    // Idempotent retry is permitted only when this exact Pi payment ID is
    // already attached to this exact Testnet withdrawal.
    const current = await readCurrent(sourceType, requestRow.id);
    if (clean(current.a2u_payment_id) === id) return current;
    throw new Error("A2U_PAYMENT_ID_PERSIST_CONFLICT");
  }

  async function persistTxid({ requestRow, sourceType, paymentId, txid }) {
    assertTestnetRow(requestRow, sourceType);
    const expectedPaymentId = clean(paymentId);
    const transactionId = clean(txid);
    if (!expectedPaymentId) throw new Error("A2U_PAYMENT_ID_REQUIRED");
    if (!transactionId) throw new Error("A2U_TXID_REQUIRED");

    const table = TABLE_BY_SOURCE[sourceType];
    const result = await supabase
      .from(table)
      .update({
        txid: transactionId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestRow.id)
      .eq("network", "testnet")
      .eq("status", "processing")
      .eq("a2u_payment_id", expectedPaymentId)
      .is("txid", null)
      .select("id,network,status,a2u_payment_id,txid")
      .maybeSingle();

    if (result.error) {
      throw new Error("A2U_TXID_PERSIST_FAILED");
    }
    if (result.data && clean(result.data.txid) === transactionId) {
      return result.data;
    }

    // Repeated writes are safe only when both identifiers match exactly.
    const current = await readCurrent(sourceType, requestRow.id);
    if (
      clean(current.a2u_payment_id) === expectedPaymentId &&
      clean(current.txid) === transactionId
    ) return current;

    if (clean(current.a2u_payment_id) !== expectedPaymentId) {
      throw new Error("A2U_TXID_PAYMENT_ID_MISMATCH");
    }
    throw new Error("A2U_TXID_PERSIST_CONFLICT");
  }

  const payoutFactory = options.createPayoutAdapter || require("./testnet-a2u-payout");
  const payout = payoutFactory({
    apiKey: options.apiKey,
    walletPrivateSeed: options.walletPrivateSeed,
    appWallet: options.appWallet,
    createPiClient: options.createPiClient,
    persistPaymentId,
    persistTxid,
  });

  return Object.freeze({
    submitStaker(requestRow) {
      assertTestnetRow(requestRow, "staker_withdrawal");
      return payout.submit(
        requestRow,
        clean(requestRow.pi_uid),
        "staker_withdrawal"
      );
    },
    reconcileStaker(requestRow) {
      assertTestnetRow(requestRow, "staker_withdrawal");
      return payout.reconcile(
        requestRow,
        clean(requestRow.pi_uid),
        "staker_withdrawal"
      );
    },
    submitOwner(requestRow, ownerPiUid) {
      assertTestnetRow(requestRow, "project_owner_withdrawal");
      return payout.submit(
        requestRow,
        clean(ownerPiUid),
        "project_owner_withdrawal"
      );
    },
    reconcileOwner(requestRow, ownerPiUid) {
      assertTestnetRow(requestRow, "project_owner_withdrawal");
      return payout.reconcile(
        requestRow,
        clean(ownerPiUid),
        "project_owner_withdrawal"
      );
    },
  });
}

module.exports = createTestnetA2UService;
