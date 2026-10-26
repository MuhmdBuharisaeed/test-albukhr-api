"use strict";

const express = require("express");
const crypto = require("crypto");

/*
 * ALBUKHR TESTNET STAKING ROUTER v1
 * Additive router; mount at /staking in test-albukhr-api/server.js.
 * It never accepts or writes Mainnet records.
 */
function createTestnetStakingRouter({
  supabase,
  axios,
  piApiKey,
  piTestnetAppWallet = "",
  piApiBase = "https://api.minepi.com/v2"
}) {
  if (!supabase) throw new Error("SUPABASE_CLIENT_REQUIRED");
  if (!axios) throw new Error("AXIOS_CLIENT_REQUIRED");
  if (!piApiKey) throw new Error("PI_API_KEY_REQUIRED");

  const router = express.Router();
  const NETWORK = "testnet";
  const ACTION = "stake";

  const errors = {
    TESTNET_SESSION_REQUIRED: 401,
    TESTNET_SESSION_INVALID: 401,
    TESTNET_SESSION_REVOKED: 401,
    TESTNET_SESSION_EXPIRED: 401,
    TESTNET_SESSION_LOOKUP_FAILED: 500,
    PI_ACCESS_TOKEN_REQUIRED: 401,
    PI_ACCESS_TOKEN_INVALID: 401,
    PI_ACCESS_TOKEN_VERIFY_FAILED: 502,
    PI_PAYMENT_ID_REQUIRED: 400,
    PI_PAYMENT_NOT_FOUND: 404,
    PI_PAYMENT_READ_FAILED: 502,
    PI_PAYMENT_USER_MISMATCH: 403,
    PI_PAYMENT_NETWORK_INVALID: 400,
    PI_PAYMENT_DIRECTION_INVALID: 400,
    PI_PAYMENT_CANCELLED: 409,
    PI_PAYMENT_AMOUNT_INVALID: 400,
    PI_PAYMENT_RECIPIENT_MISMATCH: 400,
    PI_TESTNET_APP_WALLET_REQUIRED: 503,
    PI_PAYMENT_METADATA_INVALID: 400,
    PI_PAYMENT_NOT_APPROVED: 409,
    PI_PAYMENT_NOT_COMPLETED: 409,
    PI_PAYMENT_TRANSACTION_NOT_VERIFIED: 409,
    PI_PAYMENT_TXID_MISMATCH: 409,
    PROJECT_NOT_FOUND: 404,
    PROJECT_NOT_APPROVED: 409,
    PROJECT_NETWORK_INVALID: 400,
    TREASURY_NOT_READY: 409,
    STAKING_TERMS_UNAVAILABLE: 409,
    STAKE_AMOUNT_BELOW_MINIMUM: 400,
    STAKE_PAYMENT_RECORD_REQUIRED: 409,
    STAKE_PAYMENT_RECORD_MISMATCH: 409,
    STAKE_PAYMENT_RECORD_FAILED: 500,
    STAKE_FINALIZATION_FAILED: 500,
    PI_APPROVE_FAILED: 502,
    PI_COMPLETE_FAILED: 502
  };

  function clean(value) {
    return String(value == null ? "" : value).trim();
  }
  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  function sha256(value) {
    return crypto.createHash("sha256").update(value, "utf8").digest("hex");
  }
  function sendError(res, error) {
    const code = clean(error && error.message) || "TESTNET_STAKING_ERROR";
    const status = Number(error && error.status) || errors[code] || 400;
    return res.status(status).json({ success: false, network: NETWORK, error: code });
  }
  function sessionToken(req) {
    return clean(req.get("x-testnet-session"));
  }
  function piBearer(req) {
    const value = clean(req.get("authorization"));
    return /^Bearer\s+/i.test(value) ? value.replace(/^Bearer\s+/i, "").trim() : "";
  }
  function piKeyHeaders(extra = {}) {
    return { Authorization: `Key ${piApiKey}`, ...extra };
  }
  function assertPaymentDestination(payment) {
    const expected = clean(piTestnetAppWallet);
    if (!expected) throw new Error("PI_TESTNET_APP_WALLET_REQUIRED");
    if (!clean(payment && payment.to_address) || clean(payment.to_address) !== expected) {
      throw new Error("PI_PAYMENT_RECIPIENT_MISMATCH");
    }
  }

  async function getSession(req) {
    const token = sessionToken(req);
    if (!token) throw new Error("TESTNET_SESSION_REQUIRED");
    const { data, error } = await supabase
      .from("testnet_sessions")
      .select("id,pi_uid,username,wallet_address,network,expires_at,revoked_at")
      .eq("session_hash", sha256(token))
      .eq("network", NETWORK)
      .maybeSingle();
    if (error) throw new Error("TESTNET_SESSION_LOOKUP_FAILED");
    if (!data) throw new Error("TESTNET_SESSION_INVALID");
    if (data.revoked_at) throw new Error("TESTNET_SESSION_REVOKED");
    if (!data.expires_at || new Date(data.expires_at).getTime() <= Date.now()) {
      throw new Error("TESTNET_SESSION_EXPIRED");
    }
    return data;
  }

  async function getPiUser(accessToken) {
    const token = clean(accessToken);
    if (!token) throw new Error("PI_ACCESS_TOKEN_REQUIRED");
    try {
      const response = await axios.get(`${piApiBase}/me`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 15000
      });
      if (!response.data || !clean(response.data.uid)) throw new Error("PI_ACCESS_TOKEN_INVALID");
      return response.data;
    } catch (error) {
      if (error && error.message === "PI_ACCESS_TOKEN_INVALID") throw error;
      const status = Number(error && error.response && error.response.status || 0);
      if (status === 401 || status === 403) throw new Error("PI_ACCESS_TOKEN_INVALID");
      throw new Error("PI_ACCESS_TOKEN_VERIFY_FAILED");
    }
  }

  async function requireUser(req) {
    const session = await getSession(req);
    const piUser = await getPiUser(piBearer(req));
    if (!clean(session.pi_uid) || clean(session.pi_uid) !== clean(piUser.uid)) {
      throw new Error("PI_PAYMENT_USER_MISMATCH");
    }
    return { session, piUser };
  }

  async function getPayment(paymentId) {
    const id = clean(paymentId);
    if (!id) throw new Error("PI_PAYMENT_ID_REQUIRED");
    try {
      const response = await axios.get(`${piApiBase}/payments/${encodeURIComponent(id)}`, {
        headers: piKeyHeaders(), timeout: 15000
      });
      if (!response.data) throw new Error("PI_PAYMENT_NOT_FOUND");
      return response.data;
    } catch (error) {
      if (error && error.message === "PI_PAYMENT_NOT_FOUND") throw error;
      if (Number(error && error.response && error.response.status || 0) === 404) {
        throw new Error("PI_PAYMENT_NOT_FOUND");
      }
      const wrapped = new Error("PI_PAYMENT_READ_FAILED");
      wrapped.status = 502;
      throw wrapped;
    }
  }

  async function approvePayment(paymentId) {
    try {
      const response = await axios.post(
        `${piApiBase}/payments/${encodeURIComponent(paymentId)}/approve`, {},
        { headers: piKeyHeaders({ "Content-Type": "application/json" }), timeout: 15000 }
      );
      return response.data || null;
    } catch (error) {
      const wrapped = new Error("PI_APPROVE_FAILED");
      wrapped.status = 502;
      wrapped.cause = error;
      throw wrapped;
    }
  }

  async function completePayment(paymentId, txid) {
    try {
      const response = await axios.post(
        `${piApiBase}/payments/${encodeURIComponent(paymentId)}/complete`, { txid },
        { headers: piKeyHeaders({ "Content-Type": "application/json" }), timeout: 15000 }
      );
      return response.data || null;
    } catch (error) {
      const wrapped = new Error("PI_COMPLETE_FAILED");
      wrapped.status = 502;
      wrapped.cause = error;
      throw wrapped;
    }
  }

  function metadataOf(payment) {
    return payment && payment.metadata && typeof payment.metadata === "object" ? payment.metadata : {};
  }
  function paymentIdOf(payment) {
    return clean(payment && (payment.identifier || payment.id));
  }
  function developerApproved(payment) {
    return Boolean(payment && payment.status &&
      (payment.status.developer_approved === true || payment.status.developerApproved === true));
  }
  function developerCompleted(payment) {
    return Boolean(payment && payment.status &&
      (payment.status.developer_completed === true || payment.status.developerCompleted === true));
  }
  function transactionVerified(payment) {
    return Boolean(
      (payment && payment.status &&
        (payment.status.transaction_verified === true || payment.status.transactionVerified === true)) ||
      (payment && payment.transaction && payment.transaction.verified === true)
    );
  }
  function authoritativeTxid(payment) {
    return clean(payment && (
      (payment.transaction && (payment.transaction.txid || payment.transaction.tx_hash)) || payment.txid
    ));
  }

  async function getApprovedProject(projectId, projectCode, requireApproved = true) {
    const { data, error } = await supabase
      .from("projects")
      .select("id,project_code,slug,name,status,network")
      .eq("id", clean(projectId))
      .eq("project_code", clean(projectCode))
      .eq("network", NETWORK)
      .maybeSingle();
    if (error) throw new Error("PROJECT_NOT_FOUND");
    if (!data) throw new Error("PROJECT_NOT_FOUND");
    if (requireApproved && clean(data.status).toLowerCase() !== "approved") throw new Error("PROJECT_NOT_APPROVED");
    if (clean(data.network).toLowerCase() !== NETWORK) throw new Error("PROJECT_NETWORK_INVALID");
    return data;
  }

  async function getTreasuryState(projectId) {
    const { data, error } = await supabase
      .from("project_treasury")
      .select("project_id,network,treasury_wallet,required_liquidity,verified_liquidity,status")
      .eq("project_id", clean(projectId))
      .eq("network", NETWORK)
      .maybeSingle();
    if (error || !data) return null;

    // A stake payment must never count toward project liquidity. Calculate
    // readiness only from completed, verified add_liquidity records.
    const paymentRows = await supabase
      .from("project_liquidity_payments")
      .select("amount")
      .eq("project_id", clean(projectId))
      .eq("network", NETWORK)
      .eq("action", "add_liquidity")
      .eq("pi_status", "completed")
      .eq("verification_status", "verified");
    if (paymentRows.error) throw new Error("TREASURY_NOT_READY");

    const configuredRequired = num(data.required_liquidity);
    const required = Math.max(100, configuredRequired === null ? 0 : configuredRequired);
    const verified = (paymentRows.data || []).reduce((sum, row) => sum + (num(row.amount) || 0), 0);
    const ready = clean(data.status).toLowerCase() === "active" &&
      !!clean(data.treasury_wallet) && verified >= required;
    return {
      ...data,
      required_liquidity: required,
      verified_liquidity: verified,
      ready
    };
  }

  async function getTreasury(projectId) {
    const state = await getTreasuryState(projectId);
    if (!state || !state.ready) throw new Error("TREASURY_NOT_READY");
    return state;
  }

  async function getTerm(projectCode, durationDays) {
    let query = supabase
      .from("project_staking_terms")
      .select("id,project_code,network,duration_days,min_stake,reward_rate,active")
      .eq("project_code", clean(projectCode))
      .eq("network", NETWORK)
      .eq("active", true);
    if (durationDays != null) query = query.eq("duration_days", Number(durationDays));
    const { data, error } = await query.order("duration_days", { ascending: true });
    if (error) throw new Error("STAKING_TERMS_UNAVAILABLE");
    return Array.isArray(data) ? data : [];
  }

  async function getPaymentRecord(paymentId) {
    const { data, error } = await supabase
      .from("project_liquidity_payments")
      .select("id,payment_id,project_id,payer_pi_uid,amount,recipient_wallet,network,action,pi_status,verification_status,verified_at,verification_reference,metadata")
      .eq("payment_id", clean(paymentId))
      .eq("network", NETWORK)
      .maybeSingle();
    if (error) throw new Error("STAKE_PAYMENT_RECORD_FAILED");
    return data || null;
  }

  async function validatePiPayment(payment, session, expectedRecord, requireReady) {
    if (!payment) throw new Error("PI_PAYMENT_NOT_FOUND");
    const paymentId = paymentIdOf(payment);
    if (!paymentId) throw new Error("PI_PAYMENT_ID_REQUIRED");
    const network = clean(payment.network).toLowerCase();
    if (network !== "pi testnet" && network !== "testnet") throw new Error("PI_PAYMENT_NETWORK_INVALID");
    if (clean(payment.direction) !== "user_to_app") throw new Error("PI_PAYMENT_DIRECTION_INVALID");
    if (payment.status && (payment.status.cancelled === true || payment.status.user_cancelled === true)) {
      throw new Error("PI_PAYMENT_CANCELLED");
    }
    const amount = num(payment.amount);
    if (amount === null || amount <= 0) throw new Error("PI_PAYMENT_AMOUNT_INVALID");
    if (clean(payment.user_uid) !== clean(session.pi_uid)) throw new Error("PI_PAYMENT_USER_MISMATCH");

    const meta = metadataOf(payment);
    if (clean(meta.network).toLowerCase() !== NETWORK || clean(meta.action) !== ACTION ||
        !clean(meta.project_id) || !clean(meta.project_code) || !Number.isInteger(Number(meta.duration_days)) ||
        Number(meta.duration_days) <= 0) {
      throw new Error("PI_PAYMENT_METADATA_INVALID");
    }
    const project = await getApprovedProject(meta.project_id, meta.project_code, !expectedRecord);
    let treasury;
    let term;
    if (expectedRecord) {
      if (clean(expectedRecord.action) !== ACTION || clean(expectedRecord.network) !== NETWORK ||
          clean(expectedRecord.payer_pi_uid) !== clean(session.pi_uid) ||
          clean(expectedRecord.project_id) !== clean(project.id) ||
          Math.abs(num(expectedRecord.amount) - amount) > 0.0000001) {
        throw new Error("STAKE_PAYMENT_RECORD_MISMATCH");
      }
      const recMeta = expectedRecord.metadata && typeof expectedRecord.metadata === "object" ? expectedRecord.metadata : {};
      if (Number(recMeta.duration_days) !== Number(meta.duration_days) ||
          clean(recMeta.project_code) !== clean(meta.project_code) ||
          clean(recMeta.pi_recipient_wallet) !== clean(payment.to_address)) {
        throw new Error("STAKE_PAYMENT_RECORD_MISMATCH");
      }
      treasury = { treasury_wallet: expectedRecord.recipient_wallet };
      term = {
        duration_days: Number(recMeta.duration_days),
        min_stake: num(recMeta.min_stake),
        reward_rate: num(recMeta.reward_rate),
        id: clean(recMeta.term_id)
      };
      if (!Number.isInteger(term.duration_days) || term.duration_days <= 0 ||
          term.min_stake === null || term.min_stake <= 0 ||
          term.reward_rate === null || term.reward_rate < 0 || !term.id) {
        throw new Error("PI_PAYMENT_METADATA_INVALID");
      }
    } else {
      treasury = await getTreasury(project.id);
      assertPaymentDestination(payment);
      const terms = await getTerm(project.project_code, Number(meta.duration_days));
      term = terms[0];
      if (!term) throw new Error("STAKING_TERMS_UNAVAILABLE");
      if (amount < num(term.min_stake)) throw new Error("STAKE_AMOUNT_BELOW_MINIMUM");
      if (requireReady && clean(treasury.status).toLowerCase() !== "active") throw new Error("TREASURY_NOT_READY");
    }
    if (amount < num(term.min_stake)) throw new Error("STAKE_AMOUNT_BELOW_MINIMUM");
    return { paymentId, amount, project, treasury, term, metadata: meta };
  }

  async function saveApprovalSnapshot(context, session) {
    const { paymentId, amount, project, treasury, term, metadata } = context;
    const existing = await getPaymentRecord(paymentId);
    if (existing) {
      if (clean(existing.action) !== ACTION || clean(existing.payer_pi_uid) !== clean(session.pi_uid) ||
          clean(existing.project_id) !== clean(project.id) ||
          Math.abs(num(existing.amount) - amount) > 0.0000001 ||
          clean(existing.recipient_wallet) !== clean(treasury.treasury_wallet)) {
        throw new Error("STAKE_PAYMENT_RECORD_MISMATCH");
      }
      const oldMeta = existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {};
      if (Number(oldMeta.duration_days) !== Number(term.duration_days) ||
          clean(oldMeta.pi_recipient_wallet) !== clean(piTestnetAppWallet) ||
          clean(oldMeta.project_code) !== clean(project.project_code)) {
        throw new Error("STAKE_PAYMENT_RECORD_MISMATCH");
      }
      return existing;
    }
    const row = {
      payment_id: paymentId,
      project_id: project.id,
      payer_pi_uid: session.pi_uid,
      amount,
      recipient_wallet: treasury.treasury_wallet,
      network: NETWORK,
      action: ACTION,
      pi_status: "approved",
      verification_status: "pending",
      metadata: {
        network: NETWORK,
        action: ACTION,
        project_id: project.id,
        project_code: project.project_code,
        duration_days: Number(term.duration_days),
        min_stake: Number(term.min_stake),
        reward_rate: Number(term.reward_rate),
        term_id: term.id,
        pi_recipient_wallet: clean(piTestnetAppWallet),
        username: clean(session.username) || null,
        intent_saved_at: new Date().toISOString()
      }
    };
    const { data, error } = await supabase
      .from("project_liquidity_payments")
      .insert(row)
      .select("id,payment_id,project_id,payer_pi_uid,amount,recipient_wallet,network,action,pi_status,verification_status,verified_at,verification_reference,metadata")
      .single();
    if (error) {
      if (error.code === "23505") {
        const raced = await getPaymentRecord(paymentId);
        if (raced && clean(raced.action) === ACTION &&
            clean(raced.payer_pi_uid) === clean(session.pi_uid) &&
            clean(raced.project_id) === clean(project.id) &&
            Math.abs(num(raced.amount) - amount) <= 0.0000001 &&
            clean(raced.recipient_wallet) === clean(treasury.treasury_wallet)) return raced;
      }
      throw new Error("STAKE_PAYMENT_RECORD_FAILED");
    }
    return data;
  }

  async function markRecordVerified(record, txid) {
    const current = await getPaymentRecord(record.payment_id);
    if (!current || clean(current.action) !== ACTION || clean(current.network) !== NETWORK ||
        clean(current.payer_pi_uid) !== clean(record.payer_pi_uid)) {
      throw new Error("STAKE_PAYMENT_RECORD_MISMATCH");
    }
    if (clean(current.verification_status) === "verified" && clean(current.verification_reference) === clean(txid)) {
      return current;
    }
    const meta = current.metadata && typeof current.metadata === "object" ? current.metadata : {};
    const { data, error } = await supabase
      .from("project_liquidity_payments")
      .update({
        pi_status: "completed",
        verification_status: "verified",
        verified_at: new Date().toISOString(),
        verification_reference: clean(txid),
        metadata: { ...meta, verified_by: "testnet-staking-router", verified_at: new Date().toISOString() },
        updated_at: new Date().toISOString()
      })
      .eq("id", current.id)
      .eq("network", NETWORK)
      .eq("action", ACTION)
      .select("id,payment_id,project_id,payer_pi_uid,amount,recipient_wallet,network,action,pi_status,verification_status,verified_at,verification_reference,metadata")
      .single();
    if (error || !data) throw new Error("STAKE_PAYMENT_RECORD_FAILED");
    return data;
  }

  async function finalizeStake(paymentId) {
    const { data, error } = await supabase.rpc("create_testnet_stake_from_verified_payment", {
      p_payment_id: clean(paymentId)
    });
    if (error || !data) {
      console.error("[TESTNET STAKE FINALIZE]", error && error.message);
      throw new Error("STAKE_FINALIZATION_FAILED");
    }
    return Array.isArray(data) ? data[0] : data;
  }

  async function completeAndFinalize(payment, context, txid) {
    if (!developerApproved(payment)) throw new Error("PI_PAYMENT_NOT_APPROVED");
    const suppliedTxid = clean(txid);
    if (!suppliedTxid) throw new Error("PI_PAYMENT_TXID_MISMATCH");
    if (!developerCompleted(payment)) await completePayment(context.paymentId, suppliedTxid);
    const latest = await getPayment(context.paymentId);
    if (!developerCompleted(latest)) throw new Error("PI_PAYMENT_NOT_COMPLETED");
    if (!transactionVerified(latest)) throw new Error("PI_PAYMENT_TRANSACTION_NOT_VERIFIED");
    const confirmedTxid = authoritativeTxid(latest);
    if (!confirmedTxid || confirmedTxid !== suppliedTxid) throw new Error("PI_PAYMENT_TXID_MISMATCH");
    const record = await getPaymentRecord(context.paymentId);
    if (!record) throw new Error("STAKE_PAYMENT_RECORD_REQUIRED");
    await markRecordVerified(record, confirmedTxid);
    const stake = await finalizeStake(context.paymentId);
    return { success: true, network: NETWORK, paymentId: context.paymentId, txid: confirmedTxid, stake };
  }

  router.get("/terms", async (req, res) => {
    try {
      await getSession(req);
      const code = clean(req.query.project_code || req.query.projectCode);
      if (!code) throw new Error("PROJECT_NOT_FOUND");
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("id,project_code,name,slug,status,network")
        .eq("project_code", code)
        .eq("network", NETWORK)
        .maybeSingle();
      if (projectError || !project) throw new Error("PROJECT_NOT_FOUND");
      if (clean(project.status).toLowerCase() !== "approved") throw new Error("PROJECT_NOT_APPROVED");
      const [treasury, terms] = await Promise.all([
        getTreasuryState(project.id),
        getTerm(project.project_code)
      ]);
      const required = treasury ? num(treasury.required_liquidity) : null;
      const verified = treasury ? num(treasury.verified_liquidity) : null;
      const treasuryReady = Boolean(treasury && treasury.ready);
      const eligible = treasuryReady && terms.length > 0;
      return res.json({
        success: true, network: NETWORK, project: { id: project.id, project_code: project.project_code, name: project.name },
        eligible,
        reason: eligible ? null : (!treasuryReady ? "TREASURY_NOT_READY" : "STAKING_TERMS_UNAVAILABLE"),
        liquidity: { required, verified, status: clean(treasury && treasury.status) || "unavailable" },
        terms: terms.map((term) => ({
          id: term.id, duration_days: Number(term.duration_days), min_stake: Number(term.min_stake), reward_rate: Number(term.reward_rate)
        }))
      });
    } catch (error) { return sendError(res, error); }
  });

  router.post("/approve", async (req, res) => {
    try {
      const { session } = await requireUser(req);
      const paymentId = clean(req.body && req.body.paymentId);
      if (!paymentId) throw new Error("PI_PAYMENT_ID_REQUIRED");
      const payment = await getPayment(paymentId);
      const context = await validatePiPayment(payment, session, null, true);
      if ((clean(req.body && req.body.projectId) && clean(req.body.projectId) !== clean(context.project.id)) ||
          (clean(req.body && req.body.projectCode) && clean(req.body.projectCode) !== clean(context.project.project_code))) {
        throw new Error("PI_PAYMENT_METADATA_INVALID");
      }
      let approved = payment;
      if (!developerApproved(payment)) {
        await approvePayment(paymentId);
        approved = await getPayment(paymentId);
      }
      if (!developerApproved(approved)) throw new Error("PI_PAYMENT_NOT_APPROVED");
      const approvedContext = await validatePiPayment(approved, session, null, true);
      const record = await saveApprovalSnapshot(approvedContext, session);
      return res.json({ success: true, network: NETWORK, approved: true, alreadyRecorded: clean(record.verification_status) === "verified", paymentId });
    } catch (error) { return sendError(res, error); }
  });

  router.post("/complete", async (req, res) => {
    try {
      const { session } = await requireUser(req);
      const paymentId = clean(req.body && req.body.paymentId);
      const txid = clean(req.body && req.body.txid);
      if (!paymentId || !txid) throw new Error("PI_PAYMENT_ID_REQUIRED");
      const record = await getPaymentRecord(paymentId);
      if (!record) throw new Error("STAKE_PAYMENT_RECORD_REQUIRED");
      if (clean(record.action) !== ACTION || clean(record.payer_pi_uid) !== clean(session.pi_uid)) {
        throw new Error("STAKE_PAYMENT_RECORD_MISMATCH");
      }
      const payment = await getPayment(paymentId);
      const context = await validatePiPayment(payment, session, record, false);
      if ((clean(req.body && req.body.projectId) && clean(req.body.projectId) !== clean(context.project.id)) ||
          (clean(req.body && req.body.projectCode) && clean(req.body.projectCode) !== clean(context.project.project_code))) {
        throw new Error("STAKE_PAYMENT_RECORD_MISMATCH");
      }
      const result = await completeAndFinalize(payment, context, txid);
      return res.json(result);
    } catch (error) { return sendError(res, error); }
  });

  router.post("/incomplete", async (req, res) => {
    try {
      const { session } = await requireUser(req);
      const paymentId = clean(req.body && (req.body.paymentId || req.body.identifier));
      const suppliedTxid = clean(req.body && req.body.txid);
      if (!paymentId) throw new Error("PI_PAYMENT_ID_REQUIRED");
      const record = await getPaymentRecord(paymentId);
      if (!record) {
        return res.status(409).json({ success: false, network: NETWORK, error: "STAKE_PAYMENT_RECORD_REQUIRED", recovery: "manual_review_required" });
      }
      if (clean(record.action) !== ACTION || clean(record.payer_pi_uid) !== clean(session.pi_uid)) {
        throw new Error("STAKE_PAYMENT_RECORD_MISMATCH");
      }
      const payment = await getPayment(paymentId);
      const context = await validatePiPayment(payment, session, record, false);
      if (!developerApproved(payment)) {
        return res.json({ success: true, network: NETWORK, recovered: false, state: "not_approved" });
      }
      const txid = suppliedTxid || authoritativeTxid(payment);
      if (!txid) return res.json({ success: true, network: NETWORK, recovered: false, state: "awaiting_transaction" });
      const result = await completeAndFinalize(payment, context, txid);
      return res.json({ ...result, recovered: true });
    } catch (error) { return sendError(res, error); }
  });

  return router;
}

module.exports = createTestnetStakingRouter;
