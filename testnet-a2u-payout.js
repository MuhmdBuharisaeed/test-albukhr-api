"use strict";

/*
 * ALBUKHR TESTNET A2U PAYOUT — Pi Platform SDK adapter
 *
 * Payment IDs are persisted before submitPayment. Retries resume the same
 * Pi payment; they never create a second payment when an incomplete one exists.
 * This module is Testnet-only and does not modify Mainnet payout behavior.
 */

function createTestnetA2UPayout(options) {
  options = options || {};

  const apiKey = String(options.apiKey || "").trim();
  const walletPrivateSeed = String(options.walletPrivateSeed || "").trim();
  const appWallet = String(options.appWallet || "").trim().toUpperCase();
  const persistPaymentId = options.persistPaymentId;
  const createPiClient = options.createPiClient;

  if (typeof persistPaymentId !== "function") {
    throw new Error("A2U_PAYMENT_ID_PERSISTENCE_REQUIRED");
  }

  function clean(value) {
    return String(value == null ? "" : value).trim();
  }

  function amount7(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    return Number(number.toFixed(7));
  }

  function equalAmount(a, b) {
    const left = amount7(a);
    const right = amount7(b);
    return left !== null && right !== null && left === right;
  }

  function paymentIdOf(payment) {
    return clean(payment && (payment.identifier || payment.id));
  }

  function paymentTxid(payment) {
    return clean(
      payment && payment.transaction &&
        (payment.transaction.txid || payment.transaction.tx_hash) ||
      payment && payment.txid
    );
  }

  function isDeveloperCompleted(payment) {
    const status = payment && payment.status || {};
    return status.developer_completed === true ||
      status.developerCompleted === true;
  }

  function isTransactionVerified(payment) {
    const status = payment && payment.status || {};
    return status.transaction_verified === true ||
      status.transactionVerified === true ||
      Boolean(payment && payment.transaction &&
        payment.transaction.verified === true);
  }

  function metadataMatches(payment, expected) {
    const metadata = payment && payment.metadata &&
      typeof payment.metadata === "object" ? payment.metadata : {};
    return clean(metadata.albukhr_app) === "ALBUKHR" &&
      clean(metadata.network) === "testnet" &&
      clean(metadata.withdrawal_id) === expected.withdrawalId &&
      clean(metadata.source_type) === expected.sourceType;
  }

  function verifyPayment(payment, expected) {
    if (!payment || typeof payment !== "object") {
      throw new Error("PI_A2U_PAYMENT_NOT_FOUND");
    }
    if (clean(payment.network) !== "Pi Testnet") {
      throw new Error("PI_A2U_NETWORK_MISMATCH");
    }
    if (clean(payment.direction) !== "app_to_user") {
      throw new Error("PI_A2U_DIRECTION_MISMATCH");
    }
    if (clean(payment.user_uid) !== expected.piUid) {
      throw new Error("PI_A2U_USER_MISMATCH");
    }
    if (clean(payment.from_address).toUpperCase() !== appWallet) {
      throw new Error("PI_A2U_SENDER_WALLET_MISMATCH");
    }
    if (clean(payment.to_address).toUpperCase() !== expected.walletAddress) {
      throw new Error("PI_A2U_RECIPIENT_WALLET_MISMATCH");
    }
    if (!equalAmount(payment.amount, expected.amount)) {
      throw new Error("PI_A2U_AMOUNT_MISMATCH");
    }
    if (!metadataMatches(payment, expected)) {
      throw new Error("PI_A2U_METADATA_MISMATCH");
    }
    const status = payment.status || {};
    if (status.cancelled === true || status.user_cancelled === true) {
      throw new Error("PI_A2U_PAYMENT_CANCELLED");
    }
    if (status.developer_approved !== true &&
        status.developerApproved !== true) {
      throw new Error("PI_A2U_PAYMENT_NOT_APPROVED");
    }
    return payment;
  }

  async function getClient() {
    if (!apiKey) throw new Error("PI_API_KEY_REQUIRED");
    if (!walletPrivateSeed) throw new Error("TESTNET_PAYOUT_WALLET_NOT_CONFIGURED");
    if (!/^G[A-Z2-7]{55}$/.test(appWallet)) {
      throw new Error("PI_TESTNET_APP_WALLET_INVALID");
    }
    // The official SDK stores currentPayment on the client instance. Use a
    // fresh instance per payout to avoid cross-request state races.
    if (typeof createPiClient === "function") return createPiClient();
    const module = await import("pi-backend");
    const PiNetwork = module.default || module.PiNetwork;
    if (typeof PiNetwork !== "function") {
      throw new Error("PI_BACKEND_SDK_UNAVAILABLE");
    }
    return new PiNetwork(apiKey, walletPrivateSeed);
  }

  async function persistId(requestRow, sourceType, paymentId) {
    await persistPaymentId({
      requestRow: requestRow,
      sourceType: sourceType,
      paymentId: paymentId
    });
  }

  async function submit(requestRow, piUid, sourceType) {
    if (!requestRow || !clean(requestRow.id)) {
      throw new Error("A2U_WITHDRAWAL_ID_REQUIRED");
    }
    if (clean(requestRow.network) !== "testnet") {
      throw new Error("A2U_TESTNET_ONLY");
    }
    if (!["staker_withdrawal", "project_owner_withdrawal"].includes(sourceType)) {
      throw new Error("A2U_WITHDRAWAL_SOURCE_INVALID");
    }

    const uid = clean(piUid);
    const walletAddress = clean(requestRow.wallet_address).toUpperCase();
    const amount = amount7(
      sourceType === "project_owner_withdrawal"
        ? requestRow.requested_amount
        : (requestRow.net_amount == null
          ? requestRow.requested_amount
          : requestRow.net_amount)
    );

    if (!uid) throw new Error("PI_A2U_USER_UID_REQUIRED");
    if (!/^G[A-Z2-7]{55}$/.test(walletAddress)) {
      throw new Error("PI_A2U_RECIPIENT_WALLET_INVALID");
    }
    if (amount === null) throw new Error("PI_A2U_AMOUNT_INVALID");

    const expected = {
      withdrawalId: clean(requestRow.id),
      sourceType: sourceType,
      piUid: uid,
      walletAddress: walletAddress,
      amount: amount
    };
    const metadata = {
      albukhr_app: "ALBUKHR",
      network: "testnet",
      withdrawal_id: expected.withdrawalId,
      source_type: sourceType
    };

    const client = await getClient();
    let paymentId = clean(requestRow.a2u_payment_id);
    let payment = null;
    let recovered = false;

    if (paymentId) {
      payment = await client.getPayment(paymentId);
    } else {
      let incomplete;
      try {
        incomplete = await client.getIncompleteServerPayments();
      } catch (_) {
        throw new Error("PI_A2U_INCOMPLETE_PAYMENT_LOOKUP_FAILED");
      }
      incomplete = Array.isArray(incomplete) ? incomplete : [];
      if (incomplete.length > 0) {
        const matching = incomplete.find((candidate) =>
          metadataMatches(candidate, expected)
        );
        if (!matching) throw new Error("PI_A2U_OTHER_INCOMPLETE_PAYMENT");
        payment = matching;
        paymentId = paymentIdOf(payment);
        if (!paymentId) throw new Error("PI_A2U_INCOMPLETE_PAYMENT_ID_MISSING");
        recovered = true;
      } else {
        try {
          paymentId = clean(await client.createPayment({
            amount: amount,
            memo: "ALBUKHR Testnet withdrawal",
            metadata: metadata,
            uid: uid
          }));
        } catch (error) {
          // Pi can report an ongoing payment if the create response was lost.
          // Re-read the incomplete payment and resume only our matching request.
          let latest = [];
          try { latest = await client.getIncompleteServerPayments(); } catch (_) {}
          const matching = (Array.isArray(latest) ? latest : []).find((candidate) =>
            metadataMatches(candidate, expected)
          );
          if (!matching) {
            const code = clean(error && (error.code || error.message));
            throw new Error(code === "ongoing_payment_found"
              ? "PI_A2U_OTHER_INCOMPLETE_PAYMENT"
              : "PI_A2U_PAYMENT_CREATE_FAILED");
          }
          payment = matching;
          paymentId = paymentIdOf(payment);
          recovered = true;
        }
      }

      if (!paymentId) throw new Error("PI_A2U_PAYMENT_ID_MISSING");

      // Persist the Pi identifier before any blockchain submission.
      await persistId(requestRow, sourceType, paymentId);
      if (!payment) payment = await client.getPayment(paymentId);
    }

    verifyPayment(payment, expected);

    let txid = paymentTxid(payment);
    if (!txid) {
      txid = clean(await client.submitPayment(paymentId));
      if (!txid) throw new Error("PI_A2U_TRANSACTION_ID_MISSING");
    }

    // If a previous submit succeeded but its response was lost, this read
    // exposes the existing txid and prevents a second submission.
    payment = await client.getPayment(paymentId);
    verifyPayment(payment, expected);

    const recordedTxid = paymentTxid(payment);
    if (recordedTxid && recordedTxid !== txid) {
      throw new Error("PI_A2U_TRANSACTION_ID_MISMATCH");
    }

    if (!isDeveloperCompleted(payment)) {
      try {
        payment = await client.completePayment(paymentId, txid);
      } catch (_) {
        // Completion may have succeeded upstream while its response was lost.
        payment = await client.getPayment(paymentId).catch(() => null);
        if (!isDeveloperCompleted(payment)) {
          throw new Error("PI_A2U_COMPLETION_PENDING");
        }
      }
    } else {
      payment = await client.getPayment(paymentId);
    }

    verifyPayment(payment, expected);
    if (!isDeveloperCompleted(payment) ||
        !isTransactionVerified(payment) ||
        paymentTxid(payment) !== txid) {
      throw new Error("PI_A2U_PAYMENT_NOT_FULLY_VERIFIED");
    }

    return {
      txid: txid,
      paymentId: paymentId,
      memo: paymentId,
      reconciled: recovered || Boolean(requestRow.a2u_payment_id)
    };
  }

  return Object.freeze({ submit: submit });
}

module.exports = createTestnetA2UPayout;
