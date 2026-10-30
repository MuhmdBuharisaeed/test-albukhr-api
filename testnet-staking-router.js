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

  function adminSessionToken(req) {
  return clean(req.get("x-testnet-admin-session"));
  }

  function apiError(res, error) {
    const code = clean(error && error.message) || "TESTNET_STAKING_ERROR";
    const statuses = {
  // TESTNET USER SESSION
  TESTNET_SESSION_REQUIRED: 401,
  TESTNET_SESSION_INVALID: 401,
  TESTNET_SESSION_REVOKED: 401,
  TESTNET_SESSION_EXPIRED: 401,

  // PI ACCESS TOKEN
  PI_ACCESS_TOKEN_REQUIRED: 401,
  PI_ACCESS_TOKEN_INVALID: 401,
  PI_ACCESS_TOKEN_VERIFY_FAILED: 502,
  PI_USER_SESSION_MISMATCH: 403,

  // PI PAYMENT VALIDATION
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

  // PROJECT VALIDATION
  PROJECT_ID_AND_CODE_REQUIRED: 400,
  PROJECT_NOT_APPROVED: 400,
  PROJECT_NOT_FOUND: 404,
  PROJECT_TREASURY_NOT_CONFIGURED: 400,
  PROJECT_TREASURY_NOT_ACTIVE: 400,
  PROJECT_TREASURY_APP_WALLET_MISMATCH: 400,

  // STAKE INTENT VALIDATION
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

  // STAKING OPERATIONS
  STAKING_OFFERS_READ_FAILED: 500,
  STAKING_COVERAGE_READ_FAILED: 500,
  STAKING_INTENT_CREATE_FAILED: 409,
  STAKE_PAYMENT_READ_FAILED: 500,
  STAKE_PAYMENT_RECORD_MISMATCH: 409,
  STAKE_PAYMENT_RECORD_WRITE_FAILED: 500,

  // PI PAYMENT EXECUTION
  PI_APPROVE_FAILED: 502,
  PI_COMPLETE_FAILED: 502,

  // TESTNET ADMIN SESSION
  TESTNET_ADMIN_SESSION_REQUIRED: 401,
  TESTNET_ADMIN_SESSION_INVALID: 401,
  TESTNET_ADMIN_SESSION_REVOKED: 401,
  TESTNET_ADMIN_SESSION_EXPIRED: 401,
  TESTNET_ADMIN_SESSION_LOOKUP_FAILED: 500,
  TESTNET_ADMIN_ROLE_REQUIRED: 403,

  // STAKING POLICY ADMINISTRATION
  STAKING_POLICY_SUPER_ADMIN_REQUIRED: 403,
  STAKING_POLICY_PROJECT_SCOPE_REQUIRED: 403,
  STAKING_POLICY_READ_FAILED: 500,
  STAKING_POLICY_ALREADY_EXISTS: 409,
  STAKING_POLICY_PROVISION_FAILED: 500,

  // TESTNET STAKING STAGE ADMINISTRATION
  TESTNET_STAKING_STAGE_SUPER_ADMIN_REQUIRED: 403,
  TESTNET_ADMIN_ACTOR_ID_REQUIRED: 500,

  STAKING_STAGE_PROJECTS_READ_FAILED: 500,
  STAKING_STAGE_TREASURY_READ_FAILED: 500,
  STAKING_STAGE_UPDATE_FAILED: 500,

  // TESTNET PROJECT STAGE VALIDATION
  TESTNET_PROJECT_STAGE_FIELDS_REQUIRED: 400,
  TESTNET_PROJECT_STAKING_STAGE_INVALID: 400,
  TESTNET_APPROVED_PROJECT_REQUIRED: 404,

  TESTNET_PROJECT_STAGE_CHANGE_BLOCKED_PENDING_STAKE_INTENTS: 409,
  TESTNET_PROJECT_STAGE_CAP_BELOW_OUTSTANDING_PRINCIPAL: 409,

  // GLOBAL TESTNET POLICY VALIDATION
  GLOBAL_TESTNET_POLICY_NOT_CONFIGURED: 409,

  // GLOBAL STAKING STAGE POLICY VALIDATION
  GLOBAL_STAKING_STAGE_POLICY_NOT_CONFIGURED: 409,
  GLOBAL_STAKING_STAGE_POLICY_INVALID: 400,

  // TESTNET STAKING COVERAGE
  TESTNET_STAKING_COVERAGE_UNAVAILABLE: 409
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
    // TESTNET USER SESSION
    TESTNET_SESSION_REQUIRED:
      "A valid ALBUKHR Testnet session is required.",
    TESTNET_SESSION_INVALID:
      "The ALBUKHR Testnet session is invalid.",
    TESTNET_SESSION_REVOKED:
      "The ALBUKHR Testnet session has been revoked.",
    TESTNET_SESSION_EXPIRED:
      "The ALBUKHR Testnet session has expired.",

    // PI AUTHENTICATION
    PI_ACCESS_TOKEN_REQUIRED:
      "Pi authentication is required before staking.",
    PI_ACCESS_TOKEN_INVALID:
      "Pi authentication could not be verified.",
    PI_ACCESS_TOKEN_VERIFY_FAILED:
      "Pi authentication could not be verified because the Pi service is unavailable.",
    PI_USER_SESSION_MISMATCH:
      "Your Pi identity does not match your Testnet session.",

    // PI PAYMENT VALIDATION
    PI_PAYMENT_NOT_FOUND:
      "The requested Pi payment could not be found.",
    PI_PAYMENT_USER_MISMATCH:
      "The Pi payment does not belong to your authenticated Pi account.",
    PI_PAYMENT_NETWORK_INVALID:
      "The Pi payment was not made on the required Testnet network.",
    PI_PAYMENT_DIRECTION_INVALID:
      "The Pi payment direction is invalid for this operation.",
    PI_PAYMENT_CANCELLED:
      "This Pi payment has already been cancelled.",
    PI_PAYMENT_AMOUNT_INVALID:
      "The Pi payment amount does not match the required amount.",
    PI_PAYMENT_DESTINATION_MISMATCH:
      "The Pi payment destination is not the approved Testnet treasury.",
    PI_PAYMENT_NOT_APPROVED:
      "The Pi payment has not been approved.",
    PI_PAYMENT_NOT_COMPLETED:
      "The Pi payment has not been completed.",
    PI_PAYMENT_NOT_VERIFIED:
      "The Pi payment could not be verified.",
    PI_PAYMENT_TXID_MISMATCH:
      "The blockchain transaction ID does not match the verified Pi payment.",
    PI_PAYMENT_NOT_CONFIRMED_CANCELLED:
      "Pi has not confirmed the payment cancellation; the reward reserve remains protected until reconciliation.",

    // PROJECT VALIDATION
    PROJECT_ID_AND_CODE_REQUIRED:
      "A valid project ID and project code are required.",
    PROJECT_NOT_APPROVED:
      "This project has not been approved for Testnet staking.",
    PROJECT_NOT_FOUND:
      "The requested project could not be found.",
    PROJECT_TREASURY_NOT_CONFIGURED:
      "The project treasury has not been configured.",
    PROJECT_TREASURY_NOT_ACTIVE:
      "The project treasury is not active.",
    PROJECT_TREASURY_APP_WALLET_MISMATCH:
      "The configured project treasury does not match the Testnet app wallet.",

    // STAKE INTENT VALIDATION
    STAKE_INTENT_ID_REQUIRED:
      "A staking intent ID is required.",
    STAKE_INTENT_NOT_FOUND:
      "The requested staking intent could not be found.",
    STAKE_INTENT_MISMATCH:
      "The staking intent does not match the requested project or payment.",
    STAKE_INTENT_NOT_PENDING:
      "This staking intent is no longer pending.",
    STAKE_INTENT_ALREADY_PENDING:
      "You already have an unresolved staking payment for this project. Reconcile or cancel it before creating another stake.",
    STAKE_INTENT_ALREADY_BOUND_TO_PAYMENT:
      "This staking intent is already linked to another Pi payment.",
    STAKE_INTENT_EXPIRED:
      "This staking intent has expired. Create a new staking request.",
    STAKE_INTENT_BIND_FAILED:
      "The Pi payment could not be safely linked to the staking intent.",
    STAKE_INTENT_CANCEL_FAILED:
      "The staking intent could not be cancelled. Please reconcile its current payment status.",
    STAKE_INTENT_FINALIZATION_FAILED:
      "The payment was verified, but the stake needs safe reconciliation. Do not make a second payment.",

    // STAKING OPERATIONS
    STAKING_OFFERS_READ_FAILED:
      "Staking offers could not be loaded. Please try again later.",
    STAKING_COVERAGE_READ_FAILED:
      "The project's staking liquidity coverage could not be verified.",
    STAKING_INTENT_CREATE_FAILED:
      "The staking offer cannot be reserved under current ALBUKHR policy or liquidity coverage.",
    STAKE_PAYMENT_READ_FAILED:
      "The staking payment record could not be retrieved.",
    STAKE_PAYMENT_RECORD_MISMATCH:
      "The staking payment record does not match the verified payment details.",
    STAKE_PAYMENT_RECORD_WRITE_FAILED:
      "The verified staking payment could not be recorded. Reconciliation is required.",

    // PI PAYMENT EXECUTION
    PI_APPROVE_FAILED:
      "Pi could not approve this payment. Please check its status before trying again.",
    PI_COMPLETE_FAILED:
      "Pi could not complete this payment. Check the payment status before attempting another payment.",

    // EXISTING STAKING POLICY RULES
    STAKING_POLICY_NOT_APPROVED:
      "ALBUKHR has not enabled staking for this project yet.",
    STAKING_REWARD_RATE_EXCEEDS_ALBUKHR_LIMIT:
      "The requested reward rate exceeds the maximum approved by ALBUKHR.",
    STAKING_DURATION_NOT_ALLOWED:
      "This staking duration is not in the ALBUKHR-approved duration list.",
    PROJECT_OWNER_ACCESS_DENIED:
      "Only the verified owner of this Testnet project can change its offers.",

    // TESTNET ADMIN SESSION
    TESTNET_ADMIN_SESSION_REQUIRED:
      "A Testnet admin session is required.",
    TESTNET_ADMIN_SESSION_INVALID:
      "The Testnet admin session is invalid.",
    TESTNET_ADMIN_SESSION_REVOKED:
      "The Testnet admin session has been revoked.",
    TESTNET_ADMIN_SESSION_EXPIRED:
      "The Testnet admin session has expired.",
    TESTNET_ADMIN_SESSION_LOOKUP_FAILED:
      "The Testnet admin session could not be verified because of a server error.",
    TESTNET_ADMIN_ROLE_REQUIRED:
      "An authorized Testnet admin role is required.",

    // STAKING POLICY ADMINISTRATION
    STAKING_POLICY_SUPER_ADMIN_REQUIRED:
      "Only a Testnet super admin can provision a staking policy.",
    STAKING_POLICY_PROJECT_SCOPE_REQUIRED:
      "The admin session is not authorized for this project.",
    STAKING_POLICY_READ_FAILED:
      "The staking policy could not be loaded.",
    STAKING_POLICY_ALREADY_EXISTS:
      "A staking policy record already exists; provisioning did not change it.",
    STAKING_POLICY_PROVISION_FAILED:
      "The pending staking policy could not be provisioned.",

    // TESTNET STAKING STAGE ADMINISTRATION
    TESTNET_STAKING_STAGE_SUPER_ADMIN_REQUIRED:
      "Only a Testnet super admin can assign or change a project's staking stage.",
    TESTNET_ADMIN_ACTOR_ID_REQUIRED:
      "The verified Testnet admin identity is missing. The staking stage change cannot proceed.",

    STAKING_STAGE_PROJECTS_READ_FAILED:
      "Approved Testnet projects could not be loaded for staking stage management.",
    STAKING_STAGE_TREASURY_READ_FAILED:
      "Testnet project treasury information could not be loaded.",
    STAKING_STAGE_UPDATE_FAILED:
      "The project's staking stage could not be updated. Please verify its current status before trying again.",

    // TESTNET PROJECT STAGE VALIDATION
    TESTNET_PROJECT_STAGE_FIELDS_REQUIRED:
      "A valid project identifier and staking stage are required.",
    TESTNET_PROJECT_STAKING_STAGE_INVALID:
      "The selected staking stage is invalid. Choose an ALBUKHR-supported Testnet stage.",
    TESTNET_APPROVED_PROJECT_REQUIRED:
      "Only an approved Testnet project can be assigned a staking stage.",
    TESTNET_PROJECT_STAGE_CHANGE_BLOCKED_PENDING_STAKE_INTENTS:
      "The project's staking stage cannot be changed while unresolved staking payment intents exist.",
    TESTNET_PROJECT_STAGE_CAP_BELOW_OUTSTANDING_PRINCIPAL:
      "The selected stage capacity is below the project's outstanding staking principal.",

    // GLOBAL TESTNET POLICY VALIDATION
    GLOBAL_TESTNET_POLICY_NOT_CONFIGURED:
      "The global Testnet staking policy has not been configured.",
    GLOBAL_STAKING_STAGE_POLICY_NOT_CONFIGURED:
      "The global staking stage policy has not been configured.",
    GLOBAL_STAKING_STAGE_POLICY_INVALID:
      "The configured global staking stage policy is invalid. Review its configuration before proceeding.",

    // TESTNET STAKING COVERAGE
    TESTNET_STAKING_COVERAGE_UNAVAILABLE:
      "The project's Testnet staking liquidity coverage is unavailable or insufficient."
  };

  return messages[code] || "An unexpected error occurred. Please try again or contact ALBUKHR support.";
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

  async function getTestnetAdminSession(req) {
  const token = adminSessionToken(req);

  if (!token) {
    throw new Error("TESTNET_ADMIN_SESSION_REQUIRED");
  }

  const { data, error } = await supabase
    .from("testnet_admin_sessions")
    .select(
      "id,admin_user_id,email,roles,scoped_projects," +
      "network,expires_at,revoked_at"
    )
    .eq("session_hash", hashToken(token))
    .eq("network", NETWORK)
    .maybeSingle();

  if (error) {
    throw new Error("TESTNET_ADMIN_SESSION_LOOKUP_FAILED");
  }

  if (!data) {
    throw new Error("TESTNET_ADMIN_SESSION_INVALID");
  }

  if (data.revoked_at) {
    throw new Error("TESTNET_ADMIN_SESSION_REVOKED");
  }

  if (
    !data.expires_at ||
    new Date(data.expires_at).getTime() <= Date.now()
  ) {
    throw new Error("TESTNET_ADMIN_SESSION_EXPIRED");
  }

  const roles = Array.isArray(data.roles)
    ? data.roles.map(clean)
    : [];

  if (
    !roles.includes("super_admin") &&
    !roles.includes("finance_admin")
  ) {
    throw new Error("TESTNET_ADMIN_ROLE_REQUIRED");
  }

  return { ...data, roles };
}

function assertAdminProjectScope(adminSession, project) {
  if ((adminSession.roles || []).includes("super_admin")) {
    return;
  }

  const scope = adminSession.scoped_projects;

  if (!Array.isArray(scope) || scope.length === 0) {
    throw new Error("STAKING_POLICY_PROJECT_SCOPE_REQUIRED");
  }

  const projectId = clean(project && project.id);
  const projectCode = clean(project && project.project_code);

  const allowed = scope.some((entry) => {
    if (typeof entry === "string") {
      return entry === projectId || entry === projectCode;
    }

    if (entry && typeof entry === "object") {
      return (
        clean(entry.project_id) === projectId ||
        clean(entry.project_code) === projectCode
      );
    }

    return false;
  });

  if (!allowed) {
    throw new Error("STAKING_POLICY_PROJECT_SCOPE_REQUIRED");
  }
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

  
  // ============================================================
  // TESTNET ADMIN — GLOBAL STAKING PROJECT STAGES
  // ============================================================
  //
  // GET:
  //   POST /staking/admin/project-stages
  //
  // SET:
  //   POST /staking/admin/project-stages/set
  //
  // Security:
  //   - Testnet only
  //   - Super Admin only
  //   - Server-side admin session validation
  //   - Supabase service-role RPC only
  //   - No direct browser database writes
  //   - Does not activate staking
  // ============================================================

  const TESTNET_STAKING_STAGES = [
    "setup_pre_operation",
    "construction_fit_out",
    "operating_expansion"
  ];

  function requireTestnetStakingSuperAdmin(adminSession) {
    const roles = Array.isArray(adminSession && adminSession.roles)
      ? adminSession.roles
      : [];

    if (!roles.includes("super_admin")) {
      throw new Error("TESTNET_STAKING_STAGE_SUPER_ADMIN_REQUIRED");
    }
  }

  // ------------------------------------------------------------
  // LIST APPROVED TESTNET PROJECTS AND THEIR TREASURY STATUS
  // ------------------------------------------------------------

  router.post("/admin/project-stages", async (req, res) => {
    try {
      const adminSession = await getTestnetAdminSession(req);

      requireTestnetStakingSuperAdmin(adminSession);

      const { data: projectRows, error: projectError } =
        await supabase
          .from("projects")
          .select("id,project_code,name,staking_stage")
          .eq("network", NETWORK)
          .eq("status", "approved")
          .order("project_code", { ascending: true })
          .limit(100);

      if (projectError) {
        console.error(
          "[TESTNET STAGE PROJECT READ]",
          clean(projectError.message)
        );

        throw new Error("STAKING_STAGE_PROJECTS_READ_FAILED");
      }

      const projects = Array.isArray(projectRows)
        ? projectRows
        : [];

      if (projects.length === 0) {
        return res.json({
          success: true,
          network: NETWORK,
          projects: []
        });
      }

      const projectIds = projects
        .map((project) => clean(project.id))
        .filter(Boolean);

      if (projectIds.length === 0) {
        throw new Error("STAKING_STAGE_PROJECTS_READ_FAILED");
      }

      const { data: treasuryRows, error: treasuryError } =
        await supabase
          .from("project_treasury")
          .select(
            "project_id,network,required_liquidity," +
            "verified_liquidity,status"
          )
          .eq("network", NETWORK)
          .in("project_id", projectIds);

      if (treasuryError) {
        console.error(
          "[TESTNET STAGE TREASURY READ]",
          clean(treasuryError.message)
        );

        throw new Error("STAKING_STAGE_TREASURY_READ_FAILED");
      }

      const treasuryByProject = new Map();

      (Array.isArray(treasuryRows) ? treasuryRows : [])
        .forEach((treasury) => {
          treasuryByProject.set(
            clean(treasury.project_id),
            treasury
          );
        });

      const result = projects.map((project) => {
        const treasury = treasuryByProject.get(
          clean(project.id)
        ) || null;

        return {
          id: project.id,
          project_code: project.project_code,
          name: project.name,
          staking_stage: project.staking_stage || null,

          verified_liquidity: treasury
            ? Number(treasury.verified_liquidity || 0)
            : 0,

          required_liquidity: treasury
            ? Number(treasury.required_liquidity || 0)
            : null,

          treasury_status: treasury
            ? clean(treasury.status) || "unknown"
            : "Not configured"
        };
      });

      return res.json({
        success: true,
        network: NETWORK,
        projects: result
      });

    } catch (error) {
      console.error(
        "[TESTNET ADMIN PROJECT STAGES READ]",
        clean(error && error.message)
      );

      return apiError(res, error);
    }
  });


  // ------------------------------------------------------------
  // ASSIGN OR CHANGE A TESTNET PROJECT STAKING STAGE
  // ------------------------------------------------------------

  router.post("/admin/project-stages/set", async (req, res) => {
    try {
      const adminSession = await getTestnetAdminSession(req);

      requireTestnetStakingSuperAdmin(adminSession);

      const projectId = clean(
        req.body && req.body.projectId
      );

      const projectCode = clean(
        req.body && req.body.projectCode
      );

      const stakingStage = clean(
        req.body && req.body.stakingStage
      );

      if (!projectId || !projectCode || !stakingStage) {
        throw new Error(
          "TESTNET_PROJECT_STAGE_FIELDS_REQUIRED"
        );
      }

      if (!TESTNET_STAKING_STAGES.includes(stakingStage)) {
        throw new Error(
          "TESTNET_PROJECT_STAKING_STAGE_INVALID"
        );
      }

      // Revalidate the project from Testnet database.
      // Client-provided project identity is never trusted alone.
      const project = await getApprovedProject(
        projectId,
        projectCode
      );

      // This ID comes from the authenticated server-side
      // Testnet admin session, not from the browser request.
      const adminActorId = clean(
        adminSession.admin_user_id
      );

      if (!adminActorId) {
        throw new Error(
          "TESTNET_ADMIN_ACTOR_ID_REQUIRED"
        );
      }

      // The RPC is SECURITY DEFINER and executable only by
      // service_role. This API uses the server-side service
      // role client. Never expose the service key to the UI.
      const { data: rpcData, error: rpcError } =
        await supabase.rpc(
          "set_testnet_project_staking_stage",
          {
            p_project_id: project.id,
            p_staking_stage: stakingStage,
            p_admin_actor_id: adminActorId
          }
        );

      if (rpcError) {
        const dbMessage = clean(rpcError.message);

        console.error(
          "[TESTNET PROJECT STAGE RPC]",
          dbMessage
        );

        const knownErrors = [
          "TESTNET_PROJECT_STAGE_FIELDS_REQUIRED",
          "TESTNET_PROJECT_STAKING_STAGE_INVALID",
          "TESTNET_APPROVED_PROJECT_REQUIRED",
          "TESTNET_PROJECT_STAGE_CHANGE_BLOCKED_PENDING_STAKE_INTENTS",
          "TESTNET_PROJECT_STAGE_CAP_BELOW_OUTSTANDING_PRINCIPAL",
          "GLOBAL_TESTNET_POLICY_NOT_CONFIGURED",
          "GLOBAL_STAKING_STAGE_POLICY_NOT_CONFIGURED",
          "GLOBAL_STAKING_STAGE_POLICY_INVALID",
          "TESTNET_STAKING_COVERAGE_UNAVAILABLE"
        ];

        const matchedError = knownErrors.find((code) =>
          dbMessage.includes(code)
        );

        throw new Error(
          matchedError || "STAKING_STAGE_UPDATE_FAILED"
        );
      }

      const result = Array.isArray(rpcData)
        ? rpcData[0]
        : rpcData;

      if (!result || result.success !== true) {
        throw new Error("STAKING_STAGE_UPDATE_FAILED");
      }

      return res.json({
        success: true,
        network: NETWORK,

        changed: result.changed === true,

        project: {
          id: project.id,
          project_code: project.project_code,
          name: project.name
        },

        staking_stage: result.staking_stage || stakingStage
      });

    } catch (error) {
      console.error(
        "[TESTNET ADMIN PROJECT STAGE UPDATE]",
        clean(error && error.message)
      );

      return apiError(res, error);
    }
  });

  /*
 * TESTNET ADMIN STAKING POLICY
 *
 * Provisioning creates a pending policy only.
 * It never enables staking or approves risk limits.
 */

// Read the current Testnet policy.
router.post("/admin/policy", async (req, res) => {
  try {
    const adminSession = await getTestnetAdminSession(req);

    const project = await getApprovedProject(
      req.body && req.body.projectId,
      req.body && req.body.projectCode
    );

    assertAdminProjectScope(adminSession, project);

    const { data, error } = await supabase
      .from("project_staking_risk_controls")
      .select(
        "id,project_id,project_code,network,staking_enabled," +
        "approval_status,minimum_liquidity,capital_reserve_percent," +
        "maximum_deployment_percent,max_reward_rate," +
        "max_active_principal,reward_reserve_coverage_percent," +
        "created_at,updated_at"
      )
      .eq("project_id", project.id)
      .eq("network", NETWORK)
      .maybeSingle();

    if (error) {
      throw new Error("STAKING_POLICY_READ_FAILED");
    }

    return res.json({
      success: true,
      network: NETWORK,
      project: {
        id: project.id,
        project_code: project.project_code,
        name: project.name
      },
      policy: data || null,
      provisioning_required: !data,
      can_provision:
        (adminSession.roles || []).includes("super_admin") &&
        !data
    });
  } catch (error) {
    console.error(
      "[TESTNET STAKING ADMIN POLICY READ]",
      clean(error && error.message)
    );

    return apiError(res, error);
  }
});

// Create a disabled, pending Testnet policy.
router.post("/admin/policy/provision", async (req, res) => {
  try {
    const adminSession = await getTestnetAdminSession(req);

    // Only a Testnet super admin may provision a policy.
    if (!(adminSession.roles || []).includes("super_admin")) {
      throw new Error("STAKING_POLICY_SUPER_ADMIN_REQUIRED");
    }

    const project = await getApprovedProject(
      req.body && req.body.projectId,
      req.body && req.body.projectCode
    );

    const { data: existing, error: existingError } =
      await supabase
        .from("project_staking_risk_controls")
        .select("id,project_id,network")
        .eq("project_id", project.id)
        .eq("network", NETWORK)
        .maybeSingle();

    if (existingError) {
      throw new Error("STAKING_POLICY_READ_FAILED");
    }

    if (existing) {
      throw new Error("STAKING_POLICY_ALREADY_EXISTS");
    }

    const { data: policy, error: insertError } =
      await supabase
        .from("project_staking_risk_controls")
        .insert({
          project_id: project.id,
          project_code: project.project_code,
          network: NETWORK,
          staking_enabled: false,
          approval_status: "pending",
          minimum_liquidity: 100,
          reward_reserve_coverage_percent: 100
          // Risk limits remain unset until formally reviewed.
        })
        .select(
          "id,project_id,project_code,network,staking_enabled," +
          "approval_status,minimum_liquidity,capital_reserve_percent," +
          "maximum_deployment_percent,max_reward_rate," +
          "max_active_principal,reward_reserve_coverage_percent," +
          "created_at,updated_at"
        )
        .maybeSingle();

    if (insertError || !policy) {
      if (clean(insertError && insertError.code) === "23505") {
        throw new Error("STAKING_POLICY_ALREADY_EXISTS");
      }

      console.error(
        "[TESTNET STAKING POLICY PROVISION DB]",
        clean(insertError && insertError.message)
      );

      throw new Error("STAKING_POLICY_PROVISION_FAILED");
    }

    console.info(
      "[TESTNET STAKING POLICY PROVISION]",
      JSON.stringify({
        network: NETWORK,
        project_id: project.id,
        project_code: project.project_code,
        actor_admin_user_id: adminSession.admin_user_id,
        policy_id: policy.id,
        approval_status: policy.approval_status,
        staking_enabled: policy.staking_enabled
      })
    );

    return res.status(201).json({
      success: true,
      network: NETWORK,
      project: {
        id: project.id,
        project_code: project.project_code,
        name: project.name
      },
      policy,
      requires_manual_review: true,
      staking_enabled: false
    });
  } catch (error) {
    console.error(
      "[TESTNET STAKING POLICY PROVISION]",
      clean(error && error.message)
    );

    return apiError(res, error);
  }
});

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
