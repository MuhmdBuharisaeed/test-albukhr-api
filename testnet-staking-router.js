const express = require("express");
const crypto = require("crypto");

/*
 * ALBUKHR TESTNET STAKING ROUTER v1
 *
 * Additive Testnet-only route module. It does not expose Supabase directly to
 * the browser and does not send payout transactions itself. It verifies the
 * official Pi payment and delegates intent/stake accounting to service-role
 * PostgreSQL RPCs. Do not mount this on the Mainnet API.
 */
function createTestnetStakingRouter({
  supabase,
  axios,
  piApiKey,
  piApiBase = "https://api.minepi.com/v2",
  piTestnetAppWallet = "",
}) {
  if (!supabase) throw new Error("SUPABASE_CLIENT_REQUIRED");
  if (!axios) throw new Error("AXIOS_CLIENT_REQUIRED");
  if (!piApiKey) throw new Error("PI_API_KEY_REQUIRED");

  const router = express.Router();
  const NETWORK = "testnet";

  function clean(value) {
    return String(value == null ? "" : value).trim();
  }

  function numeric(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function hashToken(token) {
    return crypto.createHash("sha256").update(token, "utf8").digest("hex");
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

  function apiError(res, error) {
    const code = clean(error && error.message) || "TESTNET_STAKING_ERROR";
    const statuses = {
      TESTNET_SESSION_REQUIRED: 401,
      TESTNET_SESSION_INVALID: 401,
      TESTNET_SESSION_REVOKED: 401,
      TESTNET_SESSION_EXPIRED: 401,
      PI_ACCESS_TOKEN_REQUIRED: 401,
      PI_ACCESS_TOKEN_INVALID: 401,
      PI_ACCESS_TOKEN_VERIFY_FAILED: 502,
      PI_USER_SESSION_MISMATCH: 403,
      PI_PAYMENT_NOT_FOUND: 404,
      PI_PAYMENT_USER_MISMATCH: 403,
      PI_PAYMENT_NETWORK_INVALID: 400,
      PI_PAYMENT_DIRECTION_INVALID: 400,
      PI_PAYMENT_CANCELLED: 409,
      PI_PAYMENT_AMOUNT_INVALID: 400,
      PI_PAYMENT_DESTINATION_MISMATCH: 400,
      PI_PAYMENT_NOT_APPROVED: 409,
      PI_PAYMENT_NOT_COMPLETED: 409,
      PI_PAYMENT_NOT_VERIFIED: 409,
      PI_PAYMENT_TXID_MISMATCH: 409,
      PI_PAYMENT_NOT_CONFIRMED_CANCELLED: 409,
      PROJECT_ID_AND_CODE_REQUIRED: 400,
      PROJECT_NOT_APPROVED: 400,
      PROJECT_NOT_FOUND: 404,
      PROJECT_TREASURY_NOT_CONFIGURED: 400,
      PROJECT_TREASURY_NOT_ACTIVE: 400,
      PROJECT_TREASURY_APP_WALLET_MISMATCH: 400,
      STAKE_INTENT_ID_REQUIRED: 400,
      STAKE_INTENT_NOT_FOUND: 404,
      STAKE_INTENT_MISMATCH: 409,
      STAKE_INTENT_NOT_PENDING: 409,
      STAKE_INTENT_ALREADY_PENDING: 409,
      STAKE_INTENT_ALREADY_BOUND_TO_PAYMENT: 409,
      STAKE_INTENT_EXPIRED: 409,
      STAKE_INTENT_BIND_FAILED: 409,
      STAKE_INTENT_CANCEL_FAILED: 409,
      STAKE_INTENT_FINALIZATION_FAILED: 409,
      STAKING_OFFERS_READ_FAILED: 500,
      STAKING_COVERAGE_READ_FAILED: 500,
      STAKING_INTENT_CREATE_FAILED: 409,
      STAKE_PAYMENT_READ_FAILED: 500,
      STAKE_PAYMENT_RECORD_MISMATCH: 409,
      STAKE_PAYMENT_RECORD_WRITE_FAILED: 500,
      PI_APPROVE_FAILED: 502,
      PI_COMPLETE_FAILED: 502,
    };

    const status = Number(error && error.status) || statuses[code] || 400;
    return res.status(status).json({
      success: false,
      network: NETWORK,
      error: code,
      message: friendlyMessage(code),
    });
  }

  function friendlyMessage(code) {
    const messages = {
      TESTNET_SESSION_REQUIRED: "A valid ALBUKHR Testnet session is required.",
      TESTNET_SESSION_INVALID: "The ALBUKHR Testnet session is invalid.",
      TESTNET_SESSION_REVOKED: "The ALBUKHR Testnet session has been revoked.",
      TESTNET_SESSION_EXPIRED: "The ALBUKHR Testnet session has expired.",
      PI_ACCESS_TOKEN_REQUIRED: "Pi authentication is required before staking.",
      PI_ACCESS_TOKEN_INVALID: "Pi authentication could not be verified.",
      PI_USER_SESSION_MISMATCH: "Your Pi identity does not match your Testnet session.",
      PI_PAYMENT_DESTINATION_MISMATCH: "The Pi payment destination is not the approved Testnet treasury.",
      PROJECT_TREASURY_APP_WALLET_MISMATCH: "The configured project treasury does not match the Testnet app wallet.",
      STAKING_INTENT_CREATE_FAILED: "The staking offer cannot be reserved under current ALBUKHR policy or liquidity coverage.",
      STAKE_INTENT_ALREADY_PENDING: "You already have an unresolved staking payment for this project. Reconcile or cancel it before creating another stake.",
      STAKE_INTENT_FINALIZATION_FAILED: "The payment was verified, but the stake needs safe reconciliation. Do not make a second payment.",
      PI_PAYMENT_NOT_CONFIRMED_CANCELLED: "Pi has not confirmed the payment cancellation; the reward reserve remains protected until reconciliation.",
      STAKING_POLICY_NOT_APPROVED: "ALBUKHR has not enabled staking for this project yet.",
      STAKING_REWARD_RATE_EXCEEDS_ALBUKHR_LIMIT: "The requested reward rate exceeds the maximum approved by ALBUKHR.",
      STAKING_DURATION_NOT_ALLOWED: "This staking duration is not in the ALBUKHR-approved duration list.",
      PROJECT_OWNER_ACCESS_DENIED: "Only the verified owner of this Testnet project can change its offers.",
    };
    return messages[code] || code;
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

    if (error) throw new Error("TESTNET_SESSION_INVALID");
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
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
      });
      if (!response.data || !clean(response.data.uid)) {
        throw new Error("PI_ACCESS_TOKEN_INVALID");
      }
      return response.data;
    } catch (error) {
      if (error && error.message === "PI_ACCESS_TOKEN_INVALID") throw error;
      const status = Number(error && error.response && error.response.status) || 0;
      if (status === 401 || status === 403) throw new Error("PI_ACCESS_TOKEN_INVALID");
      throw new Error("PI_ACCESS_TOKEN_VERIFY_FAILED");
    }
  }

  async function validateSessionAndPiIdentity(req) {
    const session = await getTestnetSession(req);
    const piUser = await getPiUser(bearer(req));
    if (!clean(session.pi_uid) || clean(session.pi_uid) !== clean(piUser.uid)) {
      throw new Error("PI_USER_SESSION_MISMATCH");
    }
    return { session, piUser };
  }

  function piKeyHeaders(extra = {}) {
    return { Authorization: `Key ${piApiKey}`, ...extra };
  }

  async function getPayment(paymentId) {
    const id = clean(paymentId);
    if (!id) throw new Error("PI_PAYMENT_NOT_FOUND");
    try {
      const response = await axios.get(`${piApiBase}/payments/${encodeURIComponent(id)}`, {
        headers: piKeyHeaders(), timeout: 15000,
      });
      if (!response.data) throw new Error("PI_PAYMENT_NOT_FOUND");
      return response.data;
    } catch (error) {
      if (error && error.message === "PI_PAYMENT_NOT_FOUND") throw error;
      if (Number(error && error.response && error.response.status) === 404) {
        throw new Error("PI_PAYMENT_NOT_FOUND");
      }
      throw new Error("STAKE_PAYMENT_READ_FAILED");
    }
  }

  function paymentId(payment) {
    return clean(payment && (payment.identifier || payment.id));
  }

  function paymentAmount(payment) {
    return numeric(payment && payment.amount);
  }

  function paymentMetadata(payment) {
    return payment && payment.metadata && typeof payment.metadata === "object"
      ? payment.metadata : {};
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
    return Boolean(payment && payment.status && (
      payment.status.transaction_verified === true ||
      payment.status.transactionVerified === true ||
      (payment.transaction && payment.transaction.verified === true)
    ));
  }

  function paymentTxid(payment) {
    return clean(payment && (
      (payment.transaction && (payment.transaction.txid || payment.transaction.tx_hash)) ||
      payment.txid
    ));
  }

  function validatePaymentBasics(payment, options = {}) {
    if (!payment) throw new Error("PI_PAYMENT_NOT_FOUND");
    const network = clean(payment.network).toLowerCase();
    if (network !== "pi testnet" && network !== "testnet") {
      throw new Error("PI_PAYMENT_NETWORK_INVALID");
    }
    if (clean(payment.direction) !== "user_to_app") {
      throw new Error("PI_PAYMENT_DIRECTION_INVALID");
    }
    if (!options.allowCancelled && payment.status && (payment.status.cancelled === true || payment.status.user_cancelled === true)) {
      throw new Error("PI_PAYMENT_CANCELLED");
    }
    const amount = paymentAmount(payment);
    if (amount === null || amount <= 0) throw new Error("PI_PAYMENT_AMOUNT_INVALID");
  }

  function validatePaymentUser(payment, piUser) {
    if (!clean(payment && payment.user_uid) || clean(payment.user_uid) !== clean(piUser && piUser.uid)) {
      throw new Error("PI_PAYMENT_USER_MISMATCH");
    }
  }

  async function getApprovedProject(projectId, projectCode) {
    const id = clean(projectId);
    const code = clean(projectCode);
    if (!id || !code) throw new Error("PROJECT_ID_AND_CODE_REQUIRED");
    const { data, error } = await supabase
      .from("projects")
      .select("id,project_code,name,network,status")
      .eq("id", id).eq("project_code", code)
      .eq("network", NETWORK).eq("status", "approved")
      .maybeSingle();
    if (error) throw new Error("PROJECT_NOT_FOUND");
    if (!data) throw new Error("PROJECT_NOT_APPROVED");
    return data;
  }

  async function getTreasury(projectId) {
    const { data, error } = await supabase
      .from("project_treasury")
      .select("project_id,network,treasury_wallet,required_liquidity,verified_liquidity,status")
      .eq("project_id", projectId).eq("network", NETWORK)
      .maybeSingle();
    if (error || !data) throw new Error("PROJECT_TREASURY_NOT_CONFIGURED");
    if (clean(data.status).toLowerCase() !== "active") throw new Error("PROJECT_TREASURY_NOT_ACTIVE");
    if (!clean(data.treasury_wallet) || !clean(piTestnetAppWallet)) {
      throw new Error("PI_PAYMENT_DESTINATION_MISMATCH");
    }
    if (clean(data.treasury_wallet) !== clean(piTestnetAppWallet)) {
      throw new Error("PROJECT_TREASURY_APP_WALLET_MISMATCH");
    }
    return data;
  }

  async function getOwnedProject(projectId, projectCode, session) {
    const id = clean(projectId);
    const code = clean(projectCode);
    if (!id || !code) throw new Error("PROJECT_ID_AND_CODE_REQUIRED");
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id,project_code,name,network,status,owner_user_id")
      .eq("id", id).eq("project_code", code)
      .eq("network", NETWORK).eq("status", "approved")
      .maybeSingle();
    if (projectError) throw new Error("PROJECT_NOT_FOUND");
    if (!project) throw new Error("PROJECT_NOT_APPROVED");
    const { data: owner, error: ownerError } = await supabase
      .from("users")
      .select("id,pi_uid,network")
      .eq("pi_uid", clean(session.pi_uid)).eq("network", NETWORK)
      .maybeSingle();
    if (ownerError || !owner || !project.owner_user_id || owner.id !== project.owner_user_id) {
      throw new Error("PROJECT_OWNER_ACCESS_DENIED");
    }
    return { project, owner };
  }

  async function getIntent(intentId) {
    const id = clean(intentId);
    if (!id) throw new Error("STAKE_INTENT_ID_REQUIRED");
    const { data, error } = await supabase
      .from("testnet_stake_intents")
      .select("*")
      .eq("id", id).eq("network", NETWORK)
      .maybeSingle();
    if (error) throw new Error("STAKE_INTENT_NOT_FOUND");
    if (!data) throw new Error("STAKE_INTENT_NOT_FOUND");
    return data;
  }

  async function validatePaymentContext(payment, session, piUser, expectedIntentId) {
    validatePaymentBasics(payment);
    validatePaymentUser(payment, piUser);
    if (clean(session.pi_uid) !== clean(piUser.uid)) throw new Error("PI_USER_SESSION_MISMATCH");

    const metadata = paymentMetadata(payment);
    if (clean(metadata.network).toLowerCase() !== NETWORK || clean(metadata.action) !== "stake") {
      throw new Error("PI_PAYMENT_DIRECTION_INVALID");
    }
    const metadataIntentId = clean(metadata.stake_intent_id);
    if (!metadataIntentId || (expectedIntentId && metadataIntentId !== clean(expectedIntentId))) {
      throw new Error("STAKE_INTENT_MISMATCH");
    }

    const intent = await getIntent(metadataIntentId);
    const id = paymentId(payment);
    const amount = paymentAmount(payment);
    const duration = Number(metadata.duration_days);

    if (intent.pi_uid !== clean(piUser.uid) ||
        intent.project_id !== clean(metadata.project_id) ||
        intent.project_code !== clean(metadata.project_code) ||
        Number(intent.duration_days) !== duration ||
        Math.abs(Number(intent.amount) - amount) > 0.0000001 ||
        Math.abs(Number(intent.amount) - Number(payment.amount)) > 0.0000001) {
      throw new Error("STAKE_INTENT_MISMATCH");
    }
    if (!id) throw new Error("PI_PAYMENT_NOT_FOUND");
    if (intent.payment_id && clean(intent.payment_id) !== id) {
      throw new Error("STAKE_INTENT_ALREADY_BOUND_TO_PAYMENT");
    }
    if (intent.status !== "pending_payment" && intent.status !== "created") {
      throw new Error("STAKE_INTENT_NOT_PENDING");
    }

    const project = await getApprovedProject(intent.project_id, intent.project_code);
    const treasury = await getTreasury(project.id);
    if (clean(payment.to_address) !== clean(piTestnetAppWallet) ||
        clean(payment.to_address) !== clean(treasury.treasury_wallet)) {
      throw new Error("PI_PAYMENT_DESTINATION_MISMATCH");
    }
    return { intent, project, treasury };
  }

  async function approvePiPayment(id) {
    try {
      await axios.post(`${piApiBase}/payments/${encodeURIComponent(id)}/approve`, {}, {
        headers: piKeyHeaders({ "Content-Type": "application/json" }), timeout: 15000,
      });
    } catch (error) {
      const latest = await getPayment(id).catch(() => null);
      if (!developerApproved(latest)) {
        const wrapped = new Error("PI_APPROVE_FAILED");
        wrapped.status = 502;
        throw wrapped;
      }
    }
    const latest = await getPayment(id);
    if (!developerApproved(latest)) throw new Error("PI_APPROVE_FAILED");
    return latest;
  }

  async function completeAndVerifyPiPayment(id, txid, paymentBefore) {
    if (!developerApproved(paymentBefore)) throw new Error("PI_PAYMENT_NOT_APPROVED");
    if (!clean(txid)) throw new Error("PI_PAYMENT_TXID_MISMATCH");

    const existingTxid = paymentTxid(paymentBefore);
    if (developerCompleted(paymentBefore) && existingTxid && existingTxid !== clean(txid)) {
      throw new Error("PI_PAYMENT_TXID_MISMATCH");
    }

    if (!developerCompleted(paymentBefore)) {
      try {
        await axios.post(`${piApiBase}/payments/${encodeURIComponent(id)}/complete`, { txid }, {
          headers: piKeyHeaders({ "Content-Type": "application/json" }), timeout: 15000,
        });
      } catch (error) {
        const latest = await getPayment(id).catch(() => null);
        if (!(developerCompleted(latest) && transactionVerified(latest) && paymentTxid(latest) === clean(txid))) {
          const wrapped = new Error("PI_COMPLETE_FAILED");
          wrapped.status = 502;
          throw wrapped;
        }
      }
    }

    const latest = await getPayment(id);
    if (!developerCompleted(latest)) throw new Error("PI_PAYMENT_NOT_COMPLETED");
    if (!transactionVerified(latest)) throw new Error("PI_PAYMENT_NOT_VERIFIED");
    if (!paymentTxid(latest) || paymentTxid(latest) !== clean(txid)) {
      throw new Error("PI_PAYMENT_TXID_MISMATCH");
    }
    return latest;
  }

  async function writeVerifiedPayment(payment, context, piUser, txid) {
    const id = paymentId(payment);
    const payload = {
      payment_id: id,
      project_id: context.intent.project_id,
      project_code: context.intent.project_code,
      payer_pi_uid: clean(piUser.uid),
      amount: Number(context.intent.amount),
      recipient_wallet: context.treasury.treasury_wallet,
      network: NETWORK,
      action: "stake",
      pi_status: "completed",
      verification_status: "verified",
      txid: clean(txid),
      verified_at: new Date().toISOString(),
      verification_reference: clean(txid),
      metadata: {
        network: NETWORK,
        action: "stake",
        project_id: context.intent.project_id,
        project_code: context.intent.project_code,
        duration_days: context.intent.duration_days,
        stake_intent_id: context.intent.id,
        username: clean(piUser.username) || null,
        txid: clean(txid),
      },
      updated_at: new Date().toISOString(),
    };

    const existingResult = await supabase
      .from("testnet_stake_payments")
      .select("id,payment_id,project_id,project_code,payer_pi_uid,amount,recipient_wallet,network,action,pi_status,verification_status,txid")
      .eq("payment_id", id).eq("network", NETWORK).maybeSingle();

    if (existingResult.error) throw new Error("STAKE_PAYMENT_READ_FAILED");
    const existing = existingResult.data;
    if (existing) {
      if (existing.project_id !== payload.project_id ||
          existing.project_code !== payload.project_code ||
          existing.payer_pi_uid !== payload.payer_pi_uid ||
          Math.abs(Number(existing.amount) - payload.amount) > 0.0000001 ||
          existing.action !== "stake" || existing.network !== NETWORK) {
        throw new Error("STAKE_PAYMENT_RECORD_MISMATCH");
      }
      const { data, error } = await supabase
        .from("testnet_stake_payments")
        .update(payload).eq("id", existing.id).eq("network", NETWORK)
        .select("*").maybeSingle();
      if (error || !data) throw new Error("STAKE_PAYMENT_RECORD_WRITE_FAILED");
      return data;
    }

    const { data, error } = await supabase
      .from("testnet_stake_payments")
      .insert(payload).select("*").maybeSingle();
    if (!error && data) return data;

    // A duplicate callback may race the first insert. Re-read and validate it.
    const reread = await supabase
      .from("testnet_stake_payments")
      .select("*").eq("payment_id", id).eq("network", NETWORK).maybeSingle();
    if (reread.error || !reread.data) throw new Error("STAKE_PAYMENT_RECORD_WRITE_FAILED");
    if (reread.data.project_id !== payload.project_id ||
        reread.data.project_code !== payload.project_code ||
        reread.data.payer_pi_uid !== payload.payer_pi_uid ||
        Math.abs(Number(reread.data.amount) - payload.amount) > 0.0000001) {
      throw new Error("STAKE_PAYMENT_RECORD_MISMATCH");
    }
    return reread.data;
  }

  // Read-only project offer check. Client-provided identity is only a lookup;
  // all authorization and policy reads are revalidated by the database RPC.
  router.post("/offers", async (req, res) => {
    try {
      await getTestnetSession(req);
      const project = await getApprovedProject(req.body && req.body.projectId, req.body && req.body.projectCode);
      const treasury = await getTreasury(project.id);
      const [termsResult, controlsResult, coverageResult] = await Promise.all([
        supabase.from("project_staking_terms")
          .select("duration_days,min_stake,reward_rate,active")
          .eq("project_code", project.project_code).eq("network", NETWORK).eq("active", true)
          .order("duration_days", { ascending: true }),
        supabase.from("project_staking_risk_controls")
          .select("staking_enabled,approval_status,minimum_liquidity,max_reward_rate,max_active_principal,capital_reserve_percent,maximum_deployment_percent")
          .eq("project_id", project.id).eq("network", NETWORK).maybeSingle(),
        supabase.rpc("get_testnet_staking_coverage", { p_project_id: project.id }),
      ]);
      if (termsResult.error || controlsResult.error || coverageResult.error) {
        throw new Error("STAKING_OFFERS_READ_FAILED");
      }
      const control = controlsResult.data;
      const coverage = Array.isArray(coverageResult.data) ? coverageResult.data[0] : coverageResult.data;
      const treasuryReady = treasury.status === "active" &&
        Number(treasury.verified_liquidity) >= Number(treasury.required_liquidity);
      const policyReady = !!control && control.staking_enabled === true && control.approval_status === "approved";
      const canStake = policyReady && treasuryReady && !!coverage && coverage.staking_eligible === true;
      const terms = (termsResult.data || []).map((term) => ({
        duration_days: Number(term.duration_days),
        min_stake: Number(term.min_stake),
        reward_rate: Number(term.reward_rate),
        reward_percent: Number(term.reward_rate) * 100,
        available: policyReady && Number(term.reward_rate) > 0 &&
          Number(term.reward_rate) <= Number(control.max_reward_rate),
      }));

      return res.json({
        success: true,
        network: NETWORK,
        project: { id: project.id, project_code: project.project_code, name: project.name },
        can_stake: canStake,
        reason: canStake ? null : "STAKING_POLICY_OR_LIQUIDITY_NOT_READY",
        terms,
        coverage: coverage ? {
          verified_liquidity_contributed: Number(coverage.verified_liquidity_contributed || 0),
          liquidity_buffer: Number(coverage.liquidity_buffer || 0),
          capital_reserve_balance: Number(coverage.capital_reserve_balance || 0),
          project_operating_balance: Number(coverage.project_operating_balance || 0),
          reward_reserve_balance: Number(coverage.reward_reserve_balance || 0),
          total_tracked_assets: Number(coverage.total_tracked_assets || 0),
          total_liability: Number(coverage.total_liability || 0),
          coverage_ratio: coverage.coverage_ratio == null ? null : Number(coverage.coverage_ratio),
          staking_eligible: coverage.staking_eligible === true,
        } : null,
      });
    } catch (error) {
      console.error("[TESTNET STAKING OFFERS]", clean(error && error.message));
      return apiError(res, error);
    }
  });

  router.post("/owner/offers", async (req, res) => {
    try {
      const session = await getTestnetSession(req);
      const owned = await getOwnedProject(req.body && req.body.projectId, req.body && req.body.projectCode, session);
      const project = owned.project;
      const [termsResult, controlResult, coverageResult] = await Promise.all([
        supabase.from("project_staking_terms")
          .select("duration_days,min_stake,reward_rate,active")
          .eq("project_code", project.project_code).eq("network", NETWORK).eq("active", true)
          .order("duration_days", { ascending: true }),
        supabase.from("project_staking_risk_controls")
          .select("staking_enabled,approval_status,minimum_liquidity,max_reward_rate,capital_reserve_percent,maximum_deployment_percent,max_active_principal")
          .eq("project_id", project.id).eq("network", NETWORK).maybeSingle(),
        supabase.rpc("get_testnet_staking_coverage", { p_project_id: project.id })
      ]);
      if (termsResult.error || controlResult.error || coverageResult.error) throw new Error("STAKING_OFFERS_READ_FAILED");
      const control = controlResult.data;
      const coverage = Array.isArray(coverageResult.data) ? coverageResult.data[0] : coverageResult.data;
      const policyReady = !!control && control.staking_enabled === true && control.approval_status === "approved";
      const coverageReady = !!coverage && coverage.staking_eligible === true;
      return res.json({
        success: true,
        network: NETWORK,
        project: { id: project.id, project_code: project.project_code, name: project.name },
        can_configure: policyReady && coverageReady,
        policy: control ? {
          staking_enabled: control.staking_enabled === true,
          approval_status: control.approval_status,
          minimum_liquidity: Number(control.minimum_liquidity || 0),
          max_reward_rate: control.max_reward_rate == null ? null : Number(control.max_reward_rate),
          max_reward_percent: control.max_reward_rate == null ? null : Number(control.max_reward_rate) * 100,
          capital_reserve_percent: control.capital_reserve_percent == null ? null : Number(control.capital_reserve_percent),
          maximum_deployment_percent: control.maximum_deployment_percent == null ? null : Number(control.maximum_deployment_percent),
          max_active_principal: control.max_active_principal == null ? null : Number(control.max_active_principal)
        } : null,
        terms: (termsResult.data || []).map((term) => ({
          duration_days: Number(term.duration_days),
          min_stake: Number(term.min_stake),
          reward_rate: Number(term.reward_rate),
          reward_percent: Number(term.reward_rate) * 100
        })),
        coverage: coverage ? {
          verified_liquidity_contributed: Number(coverage.verified_liquidity_contributed || 0),
          liquidity_buffer: Number(coverage.liquidity_buffer || 0),
          capital_reserve_balance: Number(coverage.capital_reserve_balance || 0),
          project_operating_balance: Number(coverage.project_operating_balance || 0),
          reward_reserve_balance: Number(coverage.reward_reserve_balance || 0),
          total_liability: Number(coverage.total_liability || 0),
          coverage_ratio: coverage.coverage_ratio == null ? null : Number(coverage.coverage_ratio),
          staking_eligible: coverage.staking_eligible === true
        } : null,
        locked_reason: !policyReady ? "ALBUKHR_POLICY_NOT_APPROVED" : !coverageReady ? "LIQUIDITY_COVERAGE_NOT_READY" : null
      });
    } catch (error) {
      console.error("[TESTNET STAKING OWNER OFFERS]", clean(error && error.message));
      return apiError(res, error);
    }
  });

  router.post("/owner/offer-settings", async (req, res) => {
    try {
      const session = await getTestnetSession(req);
      const owned = await getOwnedProject(req.body && req.body.projectId, req.body && req.body.projectCode, session);
      const durationDays = Number(req.body && req.body.durationDays);
      const rewardRate = numeric(req.body && req.body.rewardRate);
      if (!Number.isInteger(durationDays) || durationDays <= 0 || rewardRate === null) {
        throw new Error("STAKING_OFFER_FIELDS_REQUIRED");
      }
      const { data, error } = await supabase.rpc("update_testnet_project_staking_offer", {
        p_project_id: owned.project.id,
        p_pi_uid: clean(session.pi_uid),
        p_duration_days: durationDays,
        p_reward_rate: rewardRate
      });
      if (error || !data) {
        const message = clean(error && error.message);
        console.error("[TESTNET STAKING OWNER OFFER UPDATE]", message);
        if (message.includes("PROJECT_OWNER_ACCESS_DENIED")) throw new Error("PROJECT_OWNER_ACCESS_DENIED");
        if (message.includes("STAKING_REWARD_RATE_EXCEEDS_ALBUKHR_LIMIT")) throw new Error("STAKING_REWARD_RATE_EXCEEDS_ALBUKHR_LIMIT");
        if (message.includes("STAKING_DURATION_NOT_ALLOWED")) throw new Error("STAKING_DURATION_NOT_ALLOWED");
        if (message.includes("STAKING_POLICY_NOT_APPROVED")) throw new Error("STAKING_POLICY_NOT_APPROVED");
        if (message.includes("COVERAGE")) throw new Error("STAKING_INTENT_CREATE_FAILED");
        throw new Error("STAKING_OFFERS_READ_FAILED");
      }
      return res.json({ success: true, network: NETWORK, offer: {
        duration_days: Number(data.duration_days),
        min_stake: Number(data.min_stake),
        reward_rate: Number(data.reward_rate),
        reward_percent: Number(data.reward_rate) * 100,
        active: data.active
      } });
    } catch (error) {
      console.error("[TESTNET STAKING OWNER OFFER UPDATE]", clean(error && error.message));
      return apiError(res, error);
    }
  });

  router.post("/intent", async (req, res) => {
    try {
      const { session, piUser } = await validateSessionAndPiIdentity(req);
      const projectId = clean(req.body && req.body.projectId);
      const projectCode = clean(req.body && req.body.projectCode);
      const amount = numeric(req.body && req.body.amount);
      const durationDays = Number(req.body && req.body.durationDays);
      if (!projectId || !projectCode) throw new Error("PROJECT_ID_AND_CODE_REQUIRED");
      if (amount === null || amount <= 0 || !Number.isInteger(durationDays) || durationDays <= 0) {
        throw new Error("STAKE_INTENT_MISMATCH");
      }
      if (clean(session.pi_uid) !== clean(piUser.uid)) throw new Error("PI_USER_SESSION_MISMATCH");

      const { data, error } = await supabase.rpc("create_testnet_stake_intent", {
        p_project_id: projectId,
        p_project_code: projectCode,
        p_pi_uid: clean(piUser.uid),
        p_amount: amount,
        p_duration_days: durationDays,
      });
      if (error || !data || !data.id) {
        console.error("[TESTNET STAKE INTENT RPC]", clean(error && error.message));
        const message = clean(error && error.message);
        const mapped = new Error(message.includes("STAKE_INTENT_ALREADY_PENDING") ? "STAKE_INTENT_ALREADY_PENDING" :
          message.includes("STAKING_NOT_ENABLED") ? "STAKING_NOT_ENABLED_OR_NOT_APPROVED" :
          message.includes("STAKING_TERM_NOT_ACTIVE") ? "STAKING_TERM_NOT_ACTIVE" :
          message.includes("LIQUIDITY") || message.includes("COVERAGE") || message.includes("RESERVE") ? "STAKING_INTENT_CREATE_FAILED" :
          "STAKING_INTENT_CREATE_FAILED");
        throw mapped;
      }
      return res.json({
        success: true,
        network: NETWORK,
        intent: {
          id: data.id,
          project_id: data.project_id,
          project_code: data.project_code,
          amount: Number(data.amount),
          duration_days: Number(data.duration_days),
          reward_rate: Number(data.reward_rate),
          reward_amount: Number(data.reward_amount),
          expires_at: data.expires_at,
          status: data.status,
        },
      });
    } catch (error) {
      console.error("[TESTNET STAKE INTENT]", clean(error && error.message));
      return apiError(res, error);
    }
  });

  router.post("/arm", async (req, res) => {
    try {
      const { session, piUser } = await validateSessionAndPiIdentity(req);
      const intentId = clean(req.body && req.body.intentId);
      if (!intentId) throw new Error("STAKE_INTENT_ID_REQUIRED");
      if (clean(session.pi_uid) !== clean(piUser.uid)) throw new Error("PI_USER_SESSION_MISMATCH");
      const { data, error } = await supabase.rpc("arm_testnet_stake_intent_payment", {
        p_intent_id: intentId,
        p_pi_uid: clean(piUser.uid)
      });
      if (error || !data || !data.id) {
        const message = clean(error && error.message);
        if (message.includes("STAKE_INTENT_NOT_FOUND")) throw new Error("STAKE_INTENT_NOT_FOUND");
        if (message.includes("STAKE_INTENT_USER_MISMATCH")) throw new Error("STAKE_INTENT_MISMATCH");
        if (message.includes("STAKE_INTENT_NOT_PENDING")) throw new Error("STAKE_INTENT_NOT_PENDING");
        throw new Error("STAKE_INTENT_BIND_FAILED");
      }
      return res.json({
        success: true, network: NETWORK, intent_id: data.id,
        status: data.status, payment_armed: true
      });
    } catch (error) {
      console.error("[TESTNET STAKE ARM]", clean(error && error.message));
      return apiError(res, error);
    }
  });

  router.post("/approve", async (req, res) => {
    try {
      const { session, piUser } = await validateSessionAndPiIdentity(req);
      const id = clean(req.body && req.body.paymentId);
      if (!id) throw new Error("PI_PAYMENT_NOT_FOUND");
      const payment = await getPayment(id);
      const context = await validatePaymentContext(payment, session, piUser, req.body && req.body.intentId);

      if (context.intent.status !== "created") {
        const { error: bindError } = await supabase.rpc("bind_testnet_stake_intent_payment", {
          p_intent_id: context.intent.id,
          p_pi_uid: clean(piUser.uid),
          p_payment_id: id,
        });
        if (bindError) {
          console.error("[TESTNET STAKE INTENT BIND]", clean(bindError.message));
          throw new Error("STAKE_INTENT_BIND_FAILED");
        }
      }

      const approved = developerApproved(payment) ? payment : await approvePiPayment(id);
      return res.json({
        success: true,
        network: NETWORK,
        payment_id: id,
        intent_id: context.intent.id,
        approved: developerApproved(approved),
      });
    } catch (error) {
      console.error("[TESTNET STAKE APPROVE]", clean(error && error.message));
      return apiError(res, error);
    }
  });

  router.post("/complete", async (req, res) => {
    try {
      const { session, piUser } = await validateSessionAndPiIdentity(req);
      const id = clean(req.body && req.body.paymentId);
      const txid = clean(req.body && req.body.txid);
      if (!id || !txid) throw new Error("PI_PAYMENT_TXID_MISMATCH");
      const payment = await getPayment(id);
      const context = await validatePaymentContext(payment, session, piUser, req.body && req.body.intentId);
      if (!developerApproved(payment)) throw new Error("PI_PAYMENT_NOT_APPROVED");

      const completedPayment = await completeAndVerifyPiPayment(id, txid, payment);
      if (context.intent.status !== "created") {
        const { data: bound, error: bindError } = await supabase.rpc("bind_testnet_stake_intent_payment", {
          p_intent_id: context.intent.id,
          p_pi_uid: clean(piUser.uid),
          p_payment_id: id,
        });
        if (bindError || !bound) throw new Error("STAKE_INTENT_BIND_FAILED");
      } else if (clean(context.intent.payment_id) !== id) {
        throw new Error("STAKE_INTENT_ALREADY_BOUND_TO_PAYMENT");
      }

      const paymentRecord = await writeVerifiedPayment(completedPayment, context, piUser, txid);
      const { data: stakeData, error: finalizeError } = await supabase.rpc("finalize_testnet_stake_intent", {
        p_intent_id: context.intent.id,
        p_pi_uid: clean(piUser.uid),
        p_payment_id: id,
      });
      if (finalizeError || !stakeData || !stakeData.id) {
        console.error("[TESTNET STAKE FINALIZE]", clean(finalizeError && finalizeError.message));
        throw new Error("STAKE_INTENT_FINALIZATION_FAILED");
      }

      return res.json({
        success: true,
        network: NETWORK,
        payment_id: id,
        txid: paymentTxid(completedPayment),
        verification_status: paymentRecord.verification_status,
        stake: {
          id: stakeData.id,
          project_id: stakeData.project_id,
          project_code: stakeData.project_code,
          amount: Number(stakeData.amount),
          duration_days: Number(stakeData.duration_days),
          reward_rate: Number(stakeData.reward_rate),
          reward_amount: Number(stakeData.reward_amount),
          status: stakeData.status,
          start_at: stakeData.start_at,
          unlock_at: stakeData.unlock_at,
        },
      });
    } catch (error) {
      console.error("[TESTNET STAKE COMPLETE]", clean(error && error.message));
      return apiError(res, error);
    }
  });

  router.post("/reconcile", async (req, res) => {
    try {
      const { session, piUser } = await validateSessionAndPiIdentity(req);
      const id = clean(req.body && req.body.paymentId);
      if (!id) throw new Error("PI_PAYMENT_NOT_FOUND");
      const payment = await getPayment(id);
      validatePaymentUser(payment, piUser);
      validatePaymentBasics(payment, { allowCancelled: true });

      const metadata = paymentMetadata(payment);
      if (clean(metadata.network).toLowerCase() !== NETWORK || clean(metadata.action) !== "stake") {
        throw new Error("PI_PAYMENT_DIRECTION_INVALID");
      }
      const intentId = clean(metadata.stake_intent_id || (req.body && req.body.intentId));
      if (!intentId) throw new Error("STAKE_INTENT_MISMATCH");
      const intent = await getIntent(intentId);
      if (intent.pi_uid !== clean(piUser.uid) ||
          intent.project_id !== clean(metadata.project_id) ||
          intent.project_code !== clean(metadata.project_code)) {
        throw new Error("STAKE_INTENT_MISMATCH");
      }

      const status = payment.status || {};
      if (status.cancelled === true || status.user_cancelled === true) {
        const { data, error } = await supabase.rpc("cancel_testnet_stake_intent", {
          p_intent_id: intent.id,
          p_pi_uid: clean(piUser.uid),
          p_payment_id: id,
        });
        if (error || !data) throw new Error("STAKE_INTENT_CANCEL_FAILED");
        return res.json({ success: true, network: NETWORK, outcome: "cancelled", intent_id: intent.id, status: data.status });
      }

      const context = await validatePaymentContext(payment, session, piUser, intent.id);
      if (context.intent.status !== "created") {
        const { error: bindError } = await supabase.rpc("bind_testnet_stake_intent_payment", {
          p_intent_id: context.intent.id,
          p_pi_uid: clean(piUser.uid),
          p_payment_id: id,
        });
        if (bindError) throw new Error("STAKE_INTENT_BIND_FAILED");
      } else if (clean(context.intent.payment_id) !== id) {
        throw new Error("STAKE_INTENT_ALREADY_BOUND_TO_PAYMENT");
      }
      if (!developerApproved(payment)) {
        return res.json({ success: true, network: NETWORK, outcome: "pending_pi_approval", intent_id: intent.id });
      }

      const txid = paymentTxid(payment);
      if (!txid) {
        return res.json({ success: true, network: NETWORK, outcome: "awaiting_transaction", intent_id: intent.id });
      }
      const completedPayment = await completeAndVerifyPiPayment(id, txid, payment);
      const paymentRecord = await writeVerifiedPayment(completedPayment, context, piUser, txid);
      const { data: stake, error: finalizeError } = await supabase.rpc("finalize_testnet_stake_intent", {
        p_intent_id: context.intent.id,
        p_pi_uid: clean(piUser.uid),
        p_payment_id: id,
      });
      if (finalizeError || !stake || !stake.id) throw new Error("STAKE_INTENT_FINALIZATION_FAILED");
      return res.json({ success: true, network: NETWORK, outcome: "finalized", intent_id: intent.id,
        payment_id: id, txid, verification_status: paymentRecord.verification_status,
        stake: { id: stake.id, amount: Number(stake.amount), reward_amount: Number(stake.reward_amount), unlock_at: stake.unlock_at } });
    } catch (error) {
      console.error("[TESTNET STAKE RECONCILE]", clean(error && error.message));
      return apiError(res, error);
    }
  });

  router.post("/cancel", async (req, res) => {
    try {
      const { piUser } = await validateSessionAndPiIdentity(req);
      const intentId = clean(req.body && req.body.intentId);
      const id = clean(req.body && req.body.paymentId);
      if (!intentId) throw new Error("STAKE_INTENT_ID_REQUIRED");
      const intent = await getIntent(intentId);
      if (intent.pi_uid !== clean(piUser.uid)) throw new Error("STAKE_INTENT_MISMATCH");

      if (id) {
        const payment = await getPayment(id);
        validatePaymentBasics(payment, { allowCancelled: true });
        validatePaymentUser(payment, piUser);
        const metadata = paymentMetadata(payment);
        if (clean(metadata.stake_intent_id) !== intentId) throw new Error("STAKE_INTENT_MISMATCH");
        const status = payment.status || {};
        if (status.cancelled !== true && status.user_cancelled !== true) {
          throw new Error("PI_PAYMENT_NOT_CONFIRMED_CANCELLED");
        }
      }

      const { data, error } = await supabase.rpc("cancel_testnet_stake_intent", {
        p_intent_id: intentId,
        p_pi_uid: clean(piUser.uid),
        p_payment_id: id || null,
      });
      if (error || !data) throw new Error("STAKE_INTENT_CANCEL_FAILED");
      return res.json({ success: true, network: NETWORK, intent_id: intentId, status: data.status });
    } catch (error) {
      console.error("[TESTNET STAKE CANCEL]", clean(error && error.message));
      return apiError(res, error);
    }
  });

  return router;
}

module.exports = createTestnetStakingRouter;
