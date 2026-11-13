"use strict";

/*
 * ALBUKHR TESTNET A2U PAYOUT ADAPTER
 *
 * Uses the official Pi Node.js backend SDK (pi-backend).
 * Testnet only. This module never sends a payout on Mainnet.
 *
 * Safety invariants:
 * - Persist paymentId before submitPayment.
 * - Persist txid immediately after submitPayment and before completePayment.
 * - Existing stored payment IDs are resumed by lookup; they are never recreated.
 * - An existing payment ID with no linked txid is treated as uncertain and is
 *   NOT auto-submitted again. Reconciliation never calls submitPayment.
 * - Completion requires the Pi server to report verified transaction and
 *   developer_completed state.
 */

function createTestnetA2UPayout(options) {
  options = options || {};

  const apiKey = String(options.apiKey || "").trim();
  const walletPrivateSeed = String(options.walletPrivateSeed || "").trim();
  const appWallet = String(options.appWallet || "").trim().toUpperCase();
  const persistPaymentId = options.persistPaymentId;
  const persistTxid = options.persistTxid;
  const createPiClient = options.createPiClient;

  if (typeof persistPaymentId !== "function") {
    throw new Error("A2U_PAYMENT_ID_PERSISTENCE_REQUIRED");
  }
  if (typeof persistTxid !== "function") {
    throw new Error("A2U_TXID_PERSISTENCE_REQUIRED");
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
      (payment && payment.transaction &&
        (payment.transaction.txid || payment.transaction.tx_hash)) ||
      (payment && payment.txid)
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
      clean(metadata.network).toLowerCase() === "testnet" &&
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
    if (typeof createPiClient === "function") return createPiClient();

    if (!apiKey) throw new Error("PI_API_KEY_REQUIRED");
    if (!walletPrivateSeed) {
      throw new Error("TESTNET_PAYOUT_WALLET_NOT_CONFIGURED");
    }
    if (!/^G[A-Z2-7]{55}$/.test(appWallet)) {
      throw new Error("PI_TESTNET_APP_WALLET_INVALID");
    }

    /*
     * pi-backend@0.1.3 was published as a CommonJS package.
     * Its TypeScript default export is exposed as require(...).default.
     * Do not use dynamic import here: it wraps the CommonJS exports object
     * and makes module.default an object rather than the constructor.
     */
    let sdkModule;
    try {
      sdkModule = require("pi-backend");
    } catch (_) {
      throw new Error("PI_BACKEND_SDK_LOAD_FAILED");
    }

    const candidates = [
      sdkModule,
      sdkModule && sdkModule.default,
      sdkModule && sdkModule.PiNetwork,
    ];

    const PiNetwork = candidates.find(
      (candidate) => typeof candidate === "function"
    );

    if (typeof PiNetwork !== "function") {
      throw new Error("PI_BACKEND_SDK_CONSTRUCTOR_UNAVAILABLE");
    }

    return new PiNetwork(apiKey, walletPrivateSeed);
  }

  function expectedFor(requestRow, piUid, sourceType) {
    if (!requestRow || !clean(requestRow.id)) {
      throw new Error("A2U_WITHDRAWAL_ID_REQUIRED");
    }
    if (clean(requestRow.network).toLowerCase() !== "testnet") {
      throw new Error("A2U_TESTNET_ONLY");
    }
    if (!["staker_withdrawal", "project_owner_withdrawal"].includes(sourceType)) {
      throw new Error("A2U_WITHDRAWAL_SOURCE_INVALID");
    }

    const uid = clean(piUid || requestRow.pi_uid);
    const walletAddress = clean(requestRow.wallet_address).toUpperCase();
    const rawAmount = sourceType === "project_owner_withdrawal"
      ? requestRow.requested_amount
      : (requestRow.net_amount == null
        ? requestRow.requested_amount
        : requestRow.net_amount);
    const amount = amount7(rawAmount);

    if (!uid) throw new Error("PI_A2U_USER_UID_REQUIRED");
    if (!/^G[A-Z2-7]{55}$/.test(walletAddress)) {
      throw new Error("PI_A2U_RECIPIENT_WALLET_INVALID");
    }
    if (amount === null) throw new Error("PI_A2U_AMOUNT_INVALID");

    return {
      withdrawalId: clean(requestRow.id),
      sourceType,
      piUid: uid,
      walletAddress,
      amount,
    };
  }

  function makeMetadata(expected) {
    return {
      albukhr_app: "ALBUKHR",
      network: "testnet",
      withdrawal_id: expected.withdrawalId,
      source_type: expected.sourceType,
    };
  }

  async function persistId(requestRow, sourceType, paymentId) {
    await persistPaymentId({ requestRow, sourceType, paymentId });
  }

  async function persistTransaction(requestRow, sourceType, paymentId, txid) {
    await persistTxid({ requestRow, sourceType, paymentId, txid });
  }

  async function locateOrCreate(requestRow, expected, client) {
    const storedId = clean(requestRow.a2u_payment_id);
    if (storedId) {
      const payment = await client.getPayment(storedId);
      return {
        paymentId: storedId,
        payment,
        existedBefore: true,
        recovered: false,
      };
    }

    let incomplete;
    try {
      incomplete = await client.getIncompleteServerPayments();
    } catch (_) {
      throw new Error("PI_A2U_INCOMPLETE_PAYMENT_LOOKUP_FAILED");
    }

    incomplete = Array.isArray(incomplete) ? incomplete : [];
    if (incomplete.length > 0) {
      const matches = incomplete.filter(
        (candidate) => metadataMatches(candidate, expected)
      );
      if (matches.length !== 1) {
        throw new Error(matches.length > 1
          ? "PI_A2U_MULTIPLE_MATCHING_INCOMPLETE_PAYMENTS"
          : "PI_A2U_OTHER_INCOMPLETE_PAYMENT");
      }

      const payment = matches[0];
      const paymentId = paymentIdOf(payment);
      if (!paymentId) {
        throw new Error("PI_A2U_INCOMPLETE_PAYMENT_ID_MISSING");
      }

      await persistId(requestRow, expected.sourceType, paymentId);
      return {
        paymentId,
        payment,
        existedBefore: false,
        recovered: true,
      };
    }

    let paymentId;
    try {
      paymentId = clean(await client.createPayment({
        amount: expected.amount,
        memo: "ALBUKHR Testnet withdrawal",
        metadata: makeMetadata(expected),
        uid: expected.piUid,
      }));
    } catch (error) {
      // Recover only this request's payment if the create response was lost.
      let latest = [];
      try {
        latest = await client.getIncompleteServerPayments();
      } catch (_) {}

      const matches = (Array.isArray(latest) ? latest : [])
        .filter((candidate) => metadataMatches(candidate, expected));

      if (matches.length !== 1) {
        const code = clean(error && (error.code || error.message));
        throw new Error(code === "ongoing_payment_found"
          ? "PI_A2U_OTHER_INCOMPLETE_PAYMENT"
          : "PI_A2U_PAYMENT_CREATE_FAILED");
      }

      const payment = matches[0];
      paymentId = paymentIdOf(payment);
      if (!paymentId) {
        throw new Error("PI_A2U_INCOMPLETE_PAYMENT_ID_MISSING");
      }

      await persistId(requestRow, expected.sourceType, paymentId);
      return {
        paymentId,
        payment,
        existedBefore: false,
        recovered: true,
      };
    }

    if (!paymentId) throw new Error("PI_A2U_PAYMENT_ID_MISSING");

    // This write must finish before submitPayment is allowed to run.
    await persistId(requestRow, expected.sourceType, paymentId);

    const payment = await client.getPayment(paymentId);
    return {
      paymentId,
      payment,
      existedBefore: false,
      recovered: false,
    };
  }

  async function completeAndVerify(client, paymentId, txid, expected) {
    let payment = await client.getPayment(paymentId);
    verifyPayment(payment, expected);

    const existingTxid = paymentTxid(payment);
    if (existingTxid && existingTxid !== txid) {
      throw new Error("PI_A2U_TRANSACTION_ID_MISMATCH");
    }
    if (!existingTxid) {
      throw new Error("PI_A2U_TXID_NOT_LINKED_YET");
    }

    if (!isDeveloperCompleted(payment)) {
      try {
        await client.completePayment(paymentId, txid);
      } catch (_) {
        // Complete may have succeeded upstream while its response was lost.
      }
    }

    payment = await client.getPayment(paymentId);
    verifyPayment(payment, expected);

    if (!isDeveloperCompleted(payment) ||
        !isTransactionVerified(payment) ||
        paymentTxid(payment) !== txid) {
      throw new Error("PI_A2U_PAYMENT_NOT_FULLY_VERIFIED");
    }

    return payment;
  }

  async function submit(requestRow, piUid, sourceType) {
    const expected = expectedFor(requestRow, piUid, sourceType);
    const client = await getClient();
    const located = await locateOrCreate(requestRow, expected, client);
    const paymentId = located.paymentId;
    let payment = verifyPayment(located.payment, expected);
    let txid = paymentTxid(payment);

    if (txid) {
      // Payment may have been submitted before a server crash. Persist the
      // Pi-reported txid before attempting completion.
      await persistTransaction(requestRow, sourceType, paymentId, txid);
    } else {
      if (located.existedBefore) {
        // An already-persisted ID with no Pi-linked txid is ambiguous: a prior
        // submit may still be propagating. Never auto-submit it a second time.
        throw new Error("PI_A2U_SUBMISSION_OUTCOME_UNCERTAIN");
      }

      try {
        txid = clean(await client.submitPayment(paymentId));
      } catch (submitError) {
        // The submit response may have been lost after Pi accepted the tx.
        // Read the same payment ID; do not create or submit another ID.
        payment = await client.getPayment(paymentId).catch(() => null);
        verifyPayment(payment, expected);
        txid = paymentTxid(payment);

        if (!txid) {
          throw new Error("PI_A2U_SUBMISSION_OUTCOME_UNCERTAIN");
        }
      }

      if (!txid) {
        throw new Error("PI_A2U_TRANSACTION_ID_MISSING");
      }

      // Critical ordering: txid is recorded before completePayment.
      await persistTransaction(requestRow, sourceType, paymentId, txid);
    }

    await completeAndVerify(client, paymentId, txid, expected);

    return {
      txid,
      paymentId,
      memo: paymentId,
      reconciled: Boolean(located.recovered || located.existedBefore),
    };
  }

  async function reconcile(requestRow, piUid, sourceType) {
    const expected = expectedFor(requestRow, piUid, sourceType);
    const client = await getClient();
    let paymentId = clean(requestRow.a2u_payment_id);

    if (!paymentId) {
      let incomplete;
      try {
        incomplete = await client.getIncompleteServerPayments();
      } catch (_) {
        throw new Error("PI_A2U_INCOMPLETE_PAYMENT_LOOKUP_FAILED");
      }

      const matches = (Array.isArray(incomplete) ? incomplete : [])
        .filter((candidate) => metadataMatches(candidate, expected));

      if (matches.length === 0) {
        return {
          payoutFound: false,
          pending: false,
          txid: null,
          paymentId: null,
        };
      }
      if (matches.length !== 1) {
        throw new Error("PI_A2U_MULTIPLE_MATCHING_INCOMPLETE_PAYMENTS");
      }

      paymentId = paymentIdOf(matches[0]);
      if (!paymentId) {
        throw new Error("PI_A2U_INCOMPLETE_PAYMENT_ID_MISSING");
      }

      await persistId(requestRow, sourceType, paymentId);
    }

    let payment = await client.getPayment(paymentId);
    verifyPayment(payment, expected);
    let txid = paymentTxid(payment);

    if (!txid) {
      return {
        payoutFound: false,
        pending: true,
        txid: null,
        paymentId,
      };
    }

    const storedTxid = clean(requestRow.txid);
    if (storedTxid && storedTxid !== txid) {
      throw new Error("PI_A2U_STORED_TXID_MISMATCH");
    }

    await persistTransaction(requestRow, sourceType, paymentId, txid);

    if (!isTransactionVerified(payment)) {
      return {
        payoutFound: false,
        pending: true,
        txid,
        paymentId,
      };
    }

    if (!isDeveloperCompleted(payment)) {
      try {
        await client.completePayment(paymentId, txid);
      } catch (_) {
        // Re-read below to determine whether Pi accepted completion.
      }
    }

    payment = await client.getPayment(paymentId);
    verifyPayment(payment, expected);

    if (!isDeveloperCompleted(payment) ||
        !isTransactionVerified(payment) ||
        paymentTxid(payment) !== txid) {
      return {
        payoutFound: false,
        pending: true,
        txid,
        paymentId,
      };
    }

    return {
      payoutFound: true,
      pending: false,
      txid,
      paymentId,
      reconciled: true,
    };
  }

  return { submit, reconcile };
}

module.exports = createTestnetA2UPayout;
