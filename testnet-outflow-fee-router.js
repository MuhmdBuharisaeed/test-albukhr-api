"use strict";

const express = require("express");
const crypto = require("crypto");

/*
 * ALBUKHR Testnet Global Treasury — Outflow Fee Router v1
 *
 * This router is Testnet-only and is intentionally not mounted until the
 * matching server.js patch is reviewed. The database global treasury policy
 * must remain inactive until end-to-end Testnet tests pass.
 *
 * Security properties:
 * - Short-lived Testnet session is required on every route.
 * - Pi payment approval/completion requires a separately verified Pi identity.
 * - Fee amount and destination are read from database/server configuration;
 *   browser-supplied fee amounts are never authoritative.
 * - U2A payment network, direction, sender, destination, amount, metadata,
 *   developer approval, completion, transaction verification and txid are checked.
 * - Owner withdrawal fee assessment is allowed only for an admin-approved request.
 * - Staker payout only follows a paid/not-required fee assessment and an atomic
 *   pending -> processing claim. Processing requests are never paid twice here.
 * - No localStorage/sessionStorage is used by this server module.
 */

function createTestnetOutflowFeeRouter({
  supabase,
  axios,
  piApiKey,
  piApiBase = "https://api.minepi.com/v2",
  piTestnetAppWallet = "",
submitTestnetWithdrawalPayout,
markWithdrawalCompleted,
findTestnetWithdrawalPayoutByMemo,
markOwnerWithdrawalCompleted,
if (typeof findTestnetWithdrawalPayoutByMemo !== "function") {
  throw new Error("TESTNET_WITHDRAWAL_MEMO_LOOKUP_HELPER_REQUIRED");
}

if (typeof markOwnerWithdrawalCompleted !== "function") {
  throw new Error("TESTNET_OWNER_WITHDRAWAL_SETTLEMENT_HELPER_REQUIRED");
    }
}) {
  if (!supabase) throw new Error("SUPABASE_CLIENT_REQUIRED");
  if (!axios) throw new Error("AXIOS_CLIENT_REQUIRED");
  if (!piApiKey) throw new Error("PI_API_KEY_REQUIRED");
  if (typeof submitTestnetWithdrawalPayout !== "function") {
    throw new Error("TESTNET_WITHDRAWAL_PAYOUT_HELPER_REQUIRED");
  }
  if (typeof markWithdrawalCompleted !== "function") {
    throw new Error("TESTNET_WITHDRAWAL_SETTLEMENT_HELPER_REQUIRED");
  }

  const router = express.Router();
  const NETWORK = "testnet";
  const FEE_ACTION = "outflow_fee";

  function clean(value) {
    return String(value == null ? "" : value).trim();
  }

  function numeric(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function piEqual(a, b) {
    const left = numeric(a);
    const right = numeric(b);
    return left !== null && right !== null &&
      Math.abs(left - right) < 0.00000005;
  }

  function bearer(req) {
    const value = clean(req.get("authorization"));
    return /^Bearer\s+/i.test(value)
      ? value.replace(/^Bearer\s+/i, "").trim()
      : "";
  }

  function sessionToken(req) {
    return clean(req.get("x-testnet-session"));
  }

  function hashToken(token) {
    return crypto.createHash("sha256").update(token, "utf8").digest("hex");
  }

  function piKeyHeaders(extra = {}) {
    return { Authorization: `Key ${piApiKey}`, ...extra };
  }

  function errorStatus(error) {
    const code = clean(error && error.message);
    const map = {
      TESTNET_SESSION_REQUIRED: 401,
      TESTNET_SESSION_INVALID: 401,
      TESTNET_SESSION_REVOKED: 401,
      TESTNET_SESSION_EXPIRED: 401,
      TESTNET_SESSION_LOOKUP_FAILED: 500,
      
      PI_ACCESS_TOKEN_REQUIRED: 401,
      PI_ACCESS_TOKEN_INVALID: 401,
      PI_ACCESS_TOKEN_VERIFY_FAILED: 502,
      
      PI_USER_SESSION_MISMATCH: 403,
      
      PI_PAYMENT_NOT_FOUND: 404,
      PI_PAYMENT_READ_FAILED: 502,
      
      PI_APPROVE_FAILED: 502,
      
      PI_COMPLETE_FAILED: 502,
      
      PI_PAYMENT_USER_MISMATCH: 403,
      PI_PAYMENT_NETWORK_INVALID: 400,
      PI_PAYMENT_DIRECTION_INVALID: 400,
      PI_PAYMENT_CANCELLED: 409,
      PI_PAYMENT_NOT_CONFIRMED_CANCELLED: 409,
      PI_PAYMENT_AMOUNT_MISMATCH: 400,
      PI_PAYMENT_METADATA_MISMATCH: 400,
      PI_PAYMENT_RECIPIENT_MISMATCH: 400,
      PI_TESTNET_APP_WALLET_REQUIRED: 503,
      PI_PAYMENT_NOT_APPROVED: 409,
      PI_PAYMENT_NOT_COMPLETED: 409,
      PI_PAYMENT_TRANSACTION_NOT_VERIFIED: 409,
      PI_PAYMENT_TXID_MISMATCH: 409,
      
      PAYMENT_ID_REQUIRED: 400,
      
      FEE_ASSESSMENT_ID_REQUIRED: 400,
      FEE_ASSESSMENT_NOT_FOUND: 404,
      FEE_ASSESSMENT_READ_FAILED: 500,
      FEE_PAYMENT_RECORD_FAILED: 500,
      FEE_PAYMENT_ATTEMPT_RESERVATION_FAILED: 503,
      FEE_PAYMENT_ATTEMPT_APPROVAL_RECORD_FAILED: 503,
      FEE_PAYMENT_ATTEMPT_CANCEL_FAILED: 503,
      FEE_ASSESSMENT_REQUIRED: 409,
      
      OUTFLOW_FEE_PAYMENT_REQUIRED: 409,
      
      FEE_ASSESSMENT_ACTOR_MISMATCH: 403,
      FEE_PAYMENT_NOT_REQUIRED: 400,
      FEE_PAYMENT_NOT_PENDING: 409,
      FEE_ALREADY_PAID_DIFFERENT_PAYMENT: 409,
      
      OUTFLOW_FEE_ATTEMPT_FIELDS_REQUIRED: 400,
      OUTFLOW_FEE_ATTEMPT_ACTOR_MISMATCH: 403,
      OUTFLOW_FEE_ATTEMPT_NOT_REUSABLE: 409,
      OUTFLOW_FEE_PAYMENT_ATTEMPT_ACTIVE: 409,
      OUTFLOW_FEE_ATTEMPT_NOT_FOUND: 404,
      OUTFLOW_FEE_ATTEMPT_NOT_APPROVABLE: 409,
      OUTFLOW_FEE_ATTEMPT_NOT_CANCELLABLE: 409,
      OUTFLOW_FEE_ATTEMPT_NOT_PAYABLE: 409,
      
      WITHDRAWAL_ID_REQUIRED: 400,
      WITHDRAWAL_NOT_FOUND: 404,
      WITHDRAWAL_READ_FAILED: 500,
      WITHDRAWAL_IDEMPOTENCY_KEY_REUSED: 409,
      WITHDRAWAL_NOT_OWNED: 403,
      WITHDRAWAL_NOT_PAYABLE: 409,
      WITHDRAWAL_IDEMPOTENCY_KEY_REQUIRED: 400,
      WITHDRAWAL_CREATE_FAILED: 500,
      
      FEE_ASSESSMENT_CREATE_FAILED: 503,
      
      TESTNET_GLOBAL_TREASURY_POLICY_INACTIVE: 423,
      
      OUTFLOW_FEE_SOURCE_NOT_READY: 409,
      
      OWNER_WITHDRAWAL_NOT_APPROVED: 409,
      OWNER_WITHDRAWAL_NOT_OWNED: 403,
      OWNER_IDENTITY_UNAVAILABLE: 403,
      OWNER_WITHDRAWAL_READ_FAILED: 500,
      OWNER_WITHDRAWAL_APPROVAL_REQUIRED: 409,
      OWNER_WITHDRAWAL_APPROVAL_REQUIRED: 409,
OWNER_WITHDRAWAL_RECONCILIATION_REQUIRED: 409,
OWNER_WITHDRAWAL_NOT_RECONCILABLE: 409,
OWNER_WITHDRAWAL_CLAIM_FAILED: 503,

      WITHDRAWAL_CLAIM_FAILED: 409,
      
      PAYOUT_RECORDED_FAILED: 502,
      PAYOUT_SUBMISSION_FAILED: 502,
    };
    return Number((error && error.status) || map[code] || 400);
  }

  function sendError(res, error) {
    const code = clean(error && error.message) || "TESTNET_OUTFLOW_FEE_ERROR";
    const status = errorStatus(error);
    console.error("[TESTNET OUTFLOW FEE]", code);
    return res.status(status).json({
      success: false,
      network: NETWORK,
      error: code,
      message: status >= 500
        ? "The Testnet request could not be completed safely. Reconcile before retrying any payment or payout."
        : code,
    });
  }

  async function getTestnetSession(req) {
    const token = sessionToken(req);
    if (!token) throw new Error("TESTNET_SESSION_REQUIRED");

    const { data, error } = await supabase
      .from("testnet_sessions")
      .select("id,pi_uid,username,wallet_address,network,expires_at,revoked_at")
      .eq("session_hash", hashToken(token))
      .eq("network", NETWORK)
      .maybeSingle();

    if (error) throw new Error("TESTNET_SESSION_LOOKUP_FAILED");
    if (!data) throw new Error("TESTNET_SESSION_INVALID");
    if (data.revoked_at) throw new Error("TESTNET_SESSION_REVOKED");
    if (!data.expires_at || new Date(data.expires_at).getTime() <= Date.now()) {
      throw new Error("TESTNET_SESSION_EXPIRED");
    }
    if (!clean(data.pi_uid)) throw new Error("TESTNET_SESSION_INVALID");
    return data;
  }

  async function getPiUser(accessToken) {
    const token = clean(accessToken);
    if (!token) throw new Error("PI_ACCESS_TOKEN_REQUIRED");

    try {
      const response = await axios.get(`${piApiBase}/me`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
      });
      if (!response.data || !clean(response.data.uid)) {
        throw new Error("PI_ACCESS_TOKEN_INVALID");
      }
      return response.data;
    } catch (error) {
      if (clean(error && error.message) === "PI_ACCESS_TOKEN_INVALID") throw error;
      const status = Number(error && error.response && error.response.status || 0);
      if (status === 401 || status === 403) {
        const invalid = new Error("PI_ACCESS_TOKEN_INVALID");
        invalid.status = 401;
        throw invalid;
      }
      throw new Error("PI_ACCESS_TOKEN_VERIFY_FAILED");
    }
  }

  async function validateSessionAndPiIdentity(req) {
    const session = await getTestnetSession(req);
    const piUser = await getPiUser(bearer(req));
    if (clean(session.pi_uid) !== clean(piUser.uid)) {
      throw new Error("PI_USER_SESSION_MISMATCH");
    }
    return { session, piUser };
  }

  async function getPiPayment(paymentId) {
    const id = clean(paymentId);
    if (!id) throw new Error("PAYMENT_ID_REQUIRED");
    try {
      const response = await axios.get(
        `${piApiBase}/payments/${encodeURIComponent(id)}`,
        { headers: piKeyHeaders(), timeout: 15000 }
      );
      if (!response.data) throw new Error("PI_PAYMENT_NOT_FOUND");
      return response.data;
    } catch (error) {
      if (clean(error && error.message) === "PI_PAYMENT_NOT_FOUND") throw error;
      if (Number(error && error.response && error.response.status || 0) === 404) {
        throw new Error("PI_PAYMENT_NOT_FOUND");
      }
      throw new Error("PI_PAYMENT_READ_FAILED");
    }
  }

  async function approvePiPayment(paymentId) {
    try {
      await axios.post(
        `${piApiBase}/payments/${encodeURIComponent(paymentId)}/approve`,
        {},
        {
          headers: piKeyHeaders({ "Content-Type": "application/json" }),
          timeout: 15000,
        }
      );
    } catch (error) {
      // The Pi API may have approved successfully before a network error.
      const latest = await getPiPayment(paymentId).catch(() => null);
      if (!developerApproved(latest)) {
        const wrapped = new Error("PI_APPROVE_FAILED");
        wrapped.status = 502;
        throw wrapped;
      }
    }
    return getPiPayment(paymentId);
  }

  async function completePiPayment(paymentId, txid) {
    try {
      await axios.post(
        `${piApiBase}/payments/${encodeURIComponent(paymentId)}/complete`,
        { txid },
        {
          headers: piKeyHeaders({ "Content-Type": "application/json" }),
          timeout: 15000,
        }
      );
    } catch (error) {
      // Completion can succeed upstream even if the response is lost. The
      // caller rereads the authoritative payment before recording the fee.
      if (!developerCompleted(await getPiPayment(paymentId).catch(() => null))) {
        const wrapped = new Error("PI_COMPLETE_FAILED");
        wrapped.status = 502;
        throw wrapped;
      }
    }
    return getPiPayment(paymentId);
  }

  function developerApproved(payment) {
    return Boolean(payment && payment.status && (
      payment.status.developer_approved === true ||
      payment.status.developerApproved === true
    ));
  }

  function developerCompleted(payment) {
    return Boolean(payment && payment.status && (
      payment.status.developer_completed === true ||
      payment.status.developerCompleted === true
    ));
  }

  function transactionVerified(payment) {
    return Boolean(
      (payment && payment.status && (
        payment.status.transaction_verified === true ||
        payment.status.transactionVerified === true
      )) || (payment && payment.transaction && payment.transaction.verified === true)
    );
  }

  function paymentTxid(payment) {
    return clean(
      payment && payment.transaction && (
        payment.transaction.txid || payment.transaction.tx_hash
      ) || payment && payment.txid
    );
  }

  function paymentMetadata(payment) {
    return payment && payment.metadata && typeof payment.metadata === "object"
      ? payment.metadata
      : {};
  }

  async function getAssessment(assessmentId) {
    const id = clean(assessmentId);
    if (!id) throw new Error("FEE_ASSESSMENT_ID_REQUIRED");
    const { data, error } = await supabase
      .from("testnet_outflow_fee_assessments")
      .select("*")
      .eq("id", id)
      .eq("network", NETWORK)
      .maybeSingle();
    if (error) throw new Error("FEE_ASSESSMENT_READ_FAILED");
    if (!data) throw new Error("FEE_ASSESSMENT_NOT_FOUND");
    return data;
  }

  function validateFeePayment(payment, assessment, piUser, allowCancelled) {
    if (!payment) throw new Error("PI_PAYMENT_NOT_FOUND");
    const network = clean(payment.network).toLowerCase();
    if (network !== "pi testnet" && network !== "testnet") {
      throw new Error("PI_PAYMENT_NETWORK_INVALID");
    }
    if (clean(payment.direction) !== "user_to_app") {
      throw new Error("PI_PAYMENT_DIRECTION_INVALID");
    }
    if (!allowCancelled && payment.status && (
      payment.status.cancelled === true || payment.status.user_cancelled === true
    )) throw new Error("PI_PAYMENT_CANCELLED");

    if (clean(payment.user_uid) !== clean(piUser.uid) ||
        clean(assessment.actor_pi_uid) !== clean(piUser.uid)) {
      throw new Error("PI_PAYMENT_USER_MISMATCH");
    }

    const amount = numeric(payment.amount);
    if (amount === null || !piEqual(amount, assessment.fee_amount)) {
      throw new Error("PI_PAYMENT_AMOUNT_MISMATCH");
    }

    const expectedWallet = clean(piTestnetAppWallet);
    if (!expectedWallet) throw new Error("PI_TESTNET_APP_WALLET_REQUIRED");
    if (clean(payment.to_address) !== expectedWallet) {
      throw new Error("PI_PAYMENT_RECIPIENT_MISMATCH");
    }

    const metadata = paymentMetadata(payment);
    if (
      clean(metadata.network).toLowerCase() !== NETWORK ||
      clean(metadata.action) !== FEE_ACTION ||
      clean(metadata.fee_assessment_id) !== clean(assessment.id) ||
      clean(metadata.source_type) !== clean(assessment.source_type) ||
      clean(metadata.source_id) !== clean(assessment.source_id)
    ) throw new Error("PI_PAYMENT_METADATA_MISMATCH");

    if (numeric(assessment.fee_amount) === null || Number(assessment.fee_amount) <= 0) {
      throw new Error("FEE_PAYMENT_NOT_REQUIRED");
    }
  }

  async function getOwnedStakerWithdrawal(withdrawalId, piUid) {
    const id = clean(withdrawalId);
    if (!id) throw new Error("WITHDRAWAL_ID_REQUIRED");
    const { data, error } = await supabase
      .from("withdrawal_requests")
      .select("id,stake_id,user_id,pi_uid,project_id,project_code,network,withdrawal_type,requested_amount,fee_amount,net_amount,wallet_address,status,txid,created_at,updated_at")
      .eq("id", id)
      .eq("pi_uid", clean(piUid))
      .eq("network", NETWORK)
      .maybeSingle();
    if (error) throw new Error("WITHDRAWAL_READ_FAILED");
    if (!data) throw new Error("WITHDRAWAL_NOT_OWNED");
    return data;
  }

  async function createFeeAssessment(sourceType, sourceId) {
    const { data, error } = await supabase.rpc("create_testnet_outflow_fee_assessment", {
      p_source_type: sourceType,
      p_source_id: sourceId,
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row || !row.id) {
      const message = clean(error && error.message) || "FEE_ASSESSMENT_CREATE_FAILED";
      const wrapped = new Error(message.includes("TESTNET_GLOBAL_TREASURY_POLICY_INACTIVE")
        ? "TESTNET_GLOBAL_TREASURY_POLICY_INACTIVE"
        : message.includes("OUTFLOW_FEE_SOURCE_NOT_READY")
          ? "OUTFLOW_FEE_SOURCE_NOT_READY"
          : "FEE_ASSESSMENT_CREATE_FAILED");
      wrapped.status = wrapped.message === "TESTNET_GLOBAL_TREASURY_POLICY_INACTIVE" ? 423 : 503;
      throw wrapped;
    }
    return row;
  }

  async function reserveFeePaymentAttempt(assessment, piUid, paymentId) {
    const { data, error } = await supabase.rpc("reserve_testnet_outflow_fee_payment", {
      p_assessment_id: assessment.id,
      p_actor_pi_uid: clean(piUid),
      p_fee_payment_id: clean(paymentId),
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row || !row.id) {
      const reason = clean(error && error.message);
      const known = [
        "FEE_ASSESSMENT_NOT_FOUND", "FEE_ASSESSMENT_ACTOR_MISMATCH",
        "FEE_PAYMENT_NOT_REQUIRED", "FEE_ALREADY_PAID_DIFFERENT_PAYMENT",
        "FEE_PAYMENT_NOT_PENDING", "OUTFLOW_FEE_ATTEMPT_ACTOR_MISMATCH",
        "OUTFLOW_FEE_ATTEMPT_NOT_REUSABLE", "OUTFLOW_FEE_PAYMENT_ATTEMPT_ACTIVE",
      ].find((code) => reason.includes(code));
      throw new Error(known || "FEE_PAYMENT_ATTEMPT_RESERVATION_FAILED");
    }
    return row;
  }

  async function markFeePaymentAttemptApproved(assessment, piUid, paymentId) {
    const { data, error } = await supabase.rpc("mark_testnet_outflow_fee_payment_attempt_approved", {
      p_assessment_id: assessment.id,
      p_actor_pi_uid: clean(piUid),
      p_fee_payment_id: clean(paymentId),
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row || !row.id || !["approved", "paid"].includes(clean(row.status))) {
      throw new Error("FEE_PAYMENT_ATTEMPT_APPROVAL_RECORD_FAILED");
    }
    return row;
  }

  async function cancelFeePaymentAttempt(assessment, piUid, paymentId) {
    const { data, error } = await supabase.rpc("cancel_testnet_outflow_fee_payment_attempt", {
      p_assessment_id: assessment.id,
      p_actor_pi_uid: clean(piUid),
      p_fee_payment_id: clean(paymentId),
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row || !row.id || clean(row.status) !== "cancelled") {
      throw new Error("FEE_PAYMENT_ATTEMPT_CANCEL_FAILED");
    }
    return row;
  }

  function feeQuote(assessment) {
    return {
      id: assessment.id,
      network: NETWORK,
      source_type: assessment.source_type,
      source_id: assessment.source_id,
      requested_amount: Number(assessment.requested_amount),
      recipient_amount: Number(assessment.recipient_amount),
      fee_amount: Number(assessment.fee_amount),
      sender_total_debit: assessment.sender_total_debit == null
        ? null : Number(assessment.sender_total_debit),
      fee_status: assessment.fee_status,
      fee_basis: assessment.fee_basis,
      fee_policy_version: assessment.fee_policy_version,
      local_day: assessment.local_day,
    };
  }

  /* ---------------------------------------------------------
     Prepare staker request. No payout is sent in this endpoint.
     --------------------------------------------------------- */
  router.post("/withdrawal/prepare", async (req, res) => {
    try {
      const session = await getTestnetSession(req);
      const stakeId = clean(req.body && req.body.stakeId);
      const type = clean(req.body && req.body.withdrawalType).toLowerCase();
      const amount = numeric(req.body && req.body.requestedAmount);
      const wallet = clean(req.body && req.body.walletAddress) || clean(session.wallet_address);
      const idempotencyKey = clean(req.body && req.body.idempotencyKey);

      if (!stakeId || !["reward", "capital"].includes(type)) {
        throw new Error("INVALID_WITHDRAWAL_REQUEST");
      }
      if (amount === null || amount < 0.5) throw new Error("MINIMUM_STAKER_WITHDRAWAL_IS_0.50_PI");
      if (!wallet) throw new Error("WALLET_ADDRESS_REQUIRED");
      if (!idempotencyKey) throw new Error("WITHDRAWAL_IDEMPOTENCY_KEY_REQUIRED");

      const { data, error } = await supabase.rpc("create_testnet_withdrawal_idempotent", {
        p_pi_uid: clean(session.pi_uid),
        p_stake_id: stakeId,
        p_withdrawal_type: type,
        p_requested_amount: amount,
        p_wallet_address: wallet,
        p_client_request_key: idempotencyKey,
      });
      const withdrawal = Array.isArray(data) ? data[0] : data;
      if (error || !withdrawal || !withdrawal.id) {
        const reason = clean(error && error.message);
        if (reason.includes("TESTNET_GLOBAL_TREASURY_POLICY_INACTIVE")) {
          throw new Error("TESTNET_GLOBAL_TREASURY_POLICY_INACTIVE");
        }
        throw new Error(reason.includes("WITHDRAWAL_IDEMPOTENCY_KEY_REUSED")
          ? "WITHDRAWAL_IDEMPOTENCY_KEY_REUSED"
          : "WITHDRAWAL_CREATE_FAILED");
      }

      let assessment;
      try {
        assessment = await createFeeAssessment("staker_withdrawal", withdrawal.id);
      } catch (feeError) {
        return res.status(errorStatus(feeError)).json({
          success: false,
          network: NETWORK,
          error: clean(feeError && feeError.message) || "FEE_ASSESSMENT_CREATE_FAILED",
          withdrawal_id: withdrawal.id,
          recoverable: true,
          message: "The request exists but fee assessment did not finish. Retry the assessment endpoint with this withdrawal ID; do not create another withdrawal request.",
        });
      }

      return res.status(201).json({
        success: true,
        network: NETWORK,
        withdrawal: {
          id: withdrawal.id,
          status: withdrawal.status,
          requested_amount: Number(withdrawal.requested_amount),
          net_amount: Number(withdrawal.net_amount),
          withdrawal_type: withdrawal.withdrawal_type,
          wallet_address: withdrawal.wallet_address,
        },
        fee: feeQuote(assessment),
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  /* ---------------------------------------------------------
     Recover fee assessment after an interrupted prepare response.
     --------------------------------------------------------- */
  router.post("/withdrawal/assess", async (req, res) => {
    try {
      const session = await getTestnetSession(req);
      const withdrawal = await getOwnedStakerWithdrawal(
        req.body && req.body.withdrawalId,
        session.pi_uid
      );
      if (["completed", "rejected", "cancelled", "failed"].includes(clean(withdrawal.status))) {
        throw new Error("WITHDRAWAL_NOT_PAYABLE");
      }
      const assessment = await createFeeAssessment("staker_withdrawal", withdrawal.id);
      return res.json({ success: true, network: NETWORK, withdrawal_id: withdrawal.id, fee: feeQuote(assessment) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  /* ---------------------------------------------------------
     Owner request has already been independently approved by admin.
     This endpoint only creates/returns the fee assessment; it does not pay out.
     --------------------------------------------------------- */
  router.post("/owner/prepare-payment", async (req, res) => {
    try {
      const session = await getTestnetSession(req);
      const withdrawalId = clean(req.body && req.body.withdrawalId);
      if (!withdrawalId) throw new Error("WITHDRAWAL_ID_REQUIRED");

      const { data: owner, error: ownerError } = await supabase
        .from("users")
        .select("id,pi_uid,network")
        .eq("pi_uid", clean(session.pi_uid))
        .eq("network", NETWORK)
        .maybeSingle();
      if (ownerError || !owner) throw new Error("OWNER_IDENTITY_UNAVAILABLE");

      const { data: withdrawal, error } = await supabase
        .from("project_owner_withdrawals")
        .select("id,project_id,owner_user_id,network,requested_amount,status")
        .eq("id", withdrawalId)
        .eq("owner_user_id", owner.id)
        .eq("network", NETWORK)
        .maybeSingle();
      if (error) throw new Error("OWNER_WITHDRAWAL_READ_FAILED");
      if (!withdrawal) throw new Error("OWNER_WITHDRAWAL_NOT_OWNED");
      if (!["approved", "processing"].includes(clean(withdrawal.status))) {
        throw new Error("OWNER_WITHDRAWAL_NOT_APPROVED");
      }

      const assessment = await createFeeAssessment("project_owner_withdrawal", withdrawal.id);
      return res.json({ success: true, network: NETWORK, withdrawal_id: withdrawal.id, fee: feeQuote(assessment) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  /* ---------------------------------------------------------
     Pi U2A fee payment approval callback.
     --------------------------------------------------------- */
  router.post("/approve", async (req, res) => {
    try {
      const { piUser } = await validateSessionAndPiIdentity(req);
      const paymentId = clean(req.body && req.body.paymentId);
      const assessment = await getAssessment(req.body && req.body.assessmentId);
      if (!paymentId) throw new Error("PAYMENT_ID_REQUIRED");
      if (clean(assessment.actor_pi_uid) !== clean(piUser.uid)) throw new Error("FEE_ASSESSMENT_ACTOR_MISMATCH");
      if (assessment.fee_status === "paid") {
        if (clean(assessment.fee_payment_id) !== paymentId) throw new Error("FEE_ALREADY_PAID_DIFFERENT_PAYMENT");
        return res.json({ success: true, network: NETWORK, payment_id: paymentId, approved: true, already_paid: true });
      }
      if (assessment.fee_status !== "payment_pending") throw new Error("FEE_PAYMENT_NOT_PENDING");

      let payment = await getPiPayment(paymentId);
      validateFeePayment(payment, assessment, piUser);
      await reserveFeePaymentAttempt(assessment, piUser.uid, paymentId);
      if (!developerApproved(payment)) {
        payment = await approvePiPayment(paymentId);
      }
      validateFeePayment(payment, assessment, piUser);
      if (!developerApproved(payment)) throw new Error("PI_PAYMENT_NOT_APPROVED");
      await markFeePaymentAttemptApproved(assessment, piUser.uid, paymentId);

      return res.json({ success: true, network: NETWORK, payment_id: paymentId, approved: true, assessment_id: assessment.id });
    } catch (error) {
      return sendError(res, error);
    }
  });

  /* ---------------------------------------------------------
     Pi U2A completion callback and authoritative fee ledger record.
     --------------------------------------------------------- */
  router.post("/complete", async (req, res) => {
    try {
      const { piUser } = await validateSessionAndPiIdentity(req);
      const paymentId = clean(req.body && req.body.paymentId);
      const txid = clean(req.body && req.body.txid);
      if (!paymentId) throw new Error("PAYMENT_ID_REQUIRED");
      if (!txid) throw new Error("PAYMENT_TXID_REQUIRED");

      const assessment = await getAssessment(req.body && req.body.assessmentId);
      if (clean(assessment.actor_pi_uid) !== clean(piUser.uid)) throw new Error("FEE_ASSESSMENT_ACTOR_MISMATCH");

      let payment = await getPiPayment(paymentId);
      validateFeePayment(payment, assessment, piUser);

      if (assessment.fee_status === "paid") {
        if (clean(assessment.fee_payment_id) !== paymentId || clean(assessment.fee_payment_txid) !== txid) {
          throw new Error("FEE_ALREADY_PAID_DIFFERENT_PAYMENT");
        }
        if (!developerCompleted(payment) || !transactionVerified(payment) || paymentTxid(payment) !== txid) {
          throw new Error("PI_PAYMENT_TRANSACTION_NOT_VERIFIED");
        }
        return res.json({ success: true, network: NETWORK, fee_paid: true, already_paid: true, assessment_id: assessment.id, payment_id: paymentId, txid });
      }

      if (assessment.fee_status !== "payment_pending") throw new Error("FEE_PAYMENT_NOT_PENDING");

      // Reserve one active U2A attempt before approval. This makes approval
      // callbacks retry-safe and prevents two fee payments for one assessment.
      await reserveFeePaymentAttempt(assessment, piUser.uid, paymentId);

      // Payment metadata/amount/sender/recipient are server-validated before
      // any Pi API approval or completion call.
      if (!developerApproved(payment)) payment = await approvePiPayment(paymentId);
      validateFeePayment(payment, assessment, piUser);
      if (!developerApproved(payment)) throw new Error("PI_PAYMENT_NOT_APPROVED");
      await markFeePaymentAttemptApproved(assessment, piUser.uid, paymentId);

      if (!developerCompleted(payment)) payment = await completePiPayment(paymentId, txid);
      else payment = await getPiPayment(paymentId);

      validateFeePayment(payment, assessment, piUser);
      if (!developerCompleted(payment)) throw new Error("PI_PAYMENT_NOT_COMPLETED");
      if (!transactionVerified(payment)) throw new Error("PI_PAYMENT_TRANSACTION_NOT_VERIFIED");
      if (paymentTxid(payment) !== txid) throw new Error("PI_PAYMENT_TXID_MISMATCH");

      const { data, error } = await supabase.rpc("mark_testnet_outflow_fee_paid", {
        p_assessment_id: assessment.id,
        p_actor_pi_uid: clean(piUser.uid),
        p_fee_payment_id: paymentId,
        p_fee_payment_txid: txid,
      });
      const recorded = Array.isArray(data) ? data[0] : data;
      if (error || !recorded || recorded.fee_status !== "paid") {
        throw new Error("FEE_PAYMENT_RECORD_FAILED");
      }

      return res.json({ success: true, network: NETWORK, fee_paid: true, assessment_id: assessment.id, payment_id: paymentId, txid });
    } catch (error) {
      return sendError(res, error);
    }
  });

  /* ---------------------------------------------------------
     Verified cancellation unlocks an attempt only after Pi confirms that
     the payment is actually cancelled. A browser callback alone is not trusted.
     --------------------------------------------------------- */
  router.post("/cancel", async (req, res) => {
    try {
      const { piUser } = await validateSessionAndPiIdentity(req);
      const paymentId = clean(req.body && req.body.paymentId);
      const assessment = await getAssessment(req.body && req.body.assessmentId);
      if (!paymentId) throw new Error("PAYMENT_ID_REQUIRED");
      if (clean(assessment.actor_pi_uid) !== clean(piUser.uid)) {
        throw new Error("FEE_ASSESSMENT_ACTOR_MISMATCH");
      }

      const payment = await getPiPayment(paymentId);
      validateFeePayment(payment, assessment, piUser, true);
      const status = payment && payment.status || {};
      if (status.cancelled !== true && status.user_cancelled !== true) {
        throw new Error("PI_PAYMENT_NOT_CONFIRMED_CANCELLED");
      }

      const attempt = await cancelFeePaymentAttempt(assessment, piUser.uid, paymentId);
      return res.json({
        success: true, network: NETWORK, cancelled: true,
        assessment_id: assessment.id, payment_id: paymentId,
        attempt_status: attempt.status,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  /* ---------------------------------------------------------
     Staker payout. Requires an authoritative fee-ready assessment first.
     Processing requests are returned as reconciliation-needed, never retried
     from this endpoint. Use the existing admin /reconcile-withdraw route.
     --------------------------------------------------------- */
  router.post("/withdrawal/execute", async (req, res) => {
    try {
      const session = await getTestnetSession(req);
      const withdrawal = await getOwnedStakerWithdrawal(
        req.body && req.body.withdrawalId,
        session.pi_uid
      );

      if (withdrawal.status === "completed") {
        return res.json({ success: true, network: NETWORK, already_completed: true, txid: withdrawal.txid, request: withdrawal });
      }
      if (withdrawal.status === "processing" || withdrawal.status === "approved") {
        return res.status(409).json({
          success: false,
          network: NETWORK,
          error: "WITHDRAWAL_RECONCILIATION_REQUIRED",
          message: "This request is already claimed or has an uncertain payout. Use the existing Testnet admin reconciliation process; do not submit another payout.",
          withdrawal_id: withdrawal.id,
        });
      }
      if (withdrawal.status !== "pending") throw new Error("WITHDRAWAL_NOT_PAYABLE");

      const { data: feeRow, error: feeError } = await supabase.rpc("assert_testnet_outflow_fee_ready", {
        p_source_type: "staker_withdrawal",
        p_source_id: withdrawal.id,
      });
      const assessment = Array.isArray(feeRow) ? feeRow[0] : feeRow;
      if (feeError || !assessment || (Number(assessment.fee_amount) > 0 && assessment.fee_status !== "paid")) {
        const reason = clean(feeError && feeError.message);
        throw new Error(reason.includes("OUTFLOW_FEE_PAYMENT_REQUIRED")
          ? "OUTFLOW_FEE_PAYMENT_REQUIRED"
          : "OUTFLOW_FEE_ASSESSMENT_REQUIRED");
      }

      const { data: claimData, error: claimError } = await supabase.rpc("claim_testnet_withdrawal", {
        p_request_id: withdrawal.id,
        p_pi_uid: clean(session.pi_uid),
      });
      const claimed = Array.isArray(claimData) ? claimData[0] : claimData;
      if (claimError || !claimed || !claimed.id || claimed.status !== "processing") {
        throw new Error("WITHDRAWAL_CLAIM_FAILED");
      }

      let payout;
      try {
        payout = await submitTestnetWithdrawalPayout(claimed);
      } catch (payoutError) {
        console.error("[TESTNET OUTFLOW FEE PAYOUT] uncertain payout outcome; do not retry automatically", clean(payoutError && payoutError.message));
        const wrapped = new Error("PAYOUT_SUBMISSION_FAILED");
        wrapped.status = 502;
        throw wrapped;
      }

      try {
        const completed = await markWithdrawalCompleted(withdrawal.id, payout.txid);
        return res.json({
          success: true,
          network: NETWORK,
          payout: "completed",
          reconciled: Boolean(payout.reconciled),
          txid: payout.txid,
          request: completed || claimed,
        });
      } catch (settlementError) {
        console.error("[TESTNET OUTFLOW FEE PAYOUT] transfer submitted but settlement failed", clean(settlementError && settlementError.message));
        return res.status(502).json({
          success: false,
          network: NETWORK,
          error: "PAYOUT_RECORDED_FAILED",
          txid: payout.txid,
          withdrawal_id: withdrawal.id,
          message: "The Testnet payout may have succeeded but settlement was not recorded. Reconcile by memo before retrying.",
        });
      }
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

module.exports = createTestnetOutflowFeeRouter;
