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
  TESTNET_STAKING_MAX_DEPLOYMENT_EXCEEDED: 409,
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
    TESTNET_RISK_PROJECTS_READ_FAILED: 500,
  TESTNET_RISK_TREASURY_READ_FAILED: 500,
  STAKING_POLICY_ALREADY_EXISTS: 409,
  STAKING_POLICY_PROVISION_FAILED: 500,
    STAKING_POLICY_REVIEW_FAILED: 500,
  STAKING_POLICY_REVIEW_DECISION_INVALID: 400,
  STAKING_POLICY_NOT_APPROVED: 409,
  STAKING_POLICY_NOT_PROVISIONED: 409,
  STAKING_POLICY_NOT_PENDING_REVIEW: 409,
  STAKING_POLICY_REVIEW_STALE: 409,
    PROJECT_STAKING_STAGE_REQUIRED: 409,
  GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED: 409,
  GLOBAL_UNIVERSAL_RISK_POLICY_INVALID: 400,
  GLOBAL_UNIVERSAL_RISK_POLICY_MUST_MATCH_APPROVED_LIMITS: 400,
  PROJECT_TREASURY_NOT_CONFIGURED: 409,

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
  TESTNET_STAKING_COVERAGE_UNAVAILABLE: 409,

  // TESTNET PROJECT-LEVEL STAKING ENABLEMENT
  TESTNET_STAKING_ENABLEMENT_FIELDS_REQUIRED: 400,
  TESTNET_STAKING_ENABLEMENT_REASON_REQUIRED: 400,
  TESTNET_STAKING_ENABLEMENT_ADMIN_REQUIRED: 403,
  TESTNET_STAKING_ENABLEMENT_PROJECT_NOT_FOUND: 404,
  TESTNET_STAKING_ENABLEMENT_PROJECT_NOT_APPROVED: 409,
  TESTNET_STAKING_ENABLEMENT_MAINNET_APPROVAL_REQUIRED: 409,
  TESTNET_STAKING_ENABLEMENT_RISK_CONTROLS_NOT_APPROVED: 409,
  TESTNET_STAKING_ENABLEMENT_POLICY_NOT_CONFIGURED: 409,
  TESTNET_STAKING_ENABLEMENT_LIMITS_INVALID: 409,
  TESTNET_STAKING_ENABLEMENT_TREASURY_NOT_READY: 409,
  TESTNET_STAKING_ENABLEMENT_OFFERS_NOT_READY: 409,
  TESTNET_STAKING_ENABLEMENT_COVERAGE_NOT_READY: 409,
  TESTNET_STAKING_ENABLEMENT_PENDING_INTENTS: 409,
  TESTNET_STAKING_ENABLEMENT_GUARD_REJECTED: 409,
  TESTNET_STAKING_ENABLEMENT_FAILED: 409
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
        TESTNET_RISK_PROJECTS_READ_FAILED:
      "Approved Testnet projects could not be loaded for risk-control administration.",
    TESTNET_RISK_TREASURY_READ_FAILED:
      "Testnet project treasury information could not be loaded for risk-control administration.",
    STAKING_POLICY_ALREADY_EXISTS:
      "A staking policy record already exists; provisioning did not change it.",
    STAKING_POLICY_PROVISION_FAILED:
      "The pending staking policy could not be provisioned.",
    STAKING_POLICY_REVIEW_FAILED:
  "The staking risk-control review could not be saved.",

STAKING_POLICY_REVIEW_DECISION_INVALID:
  "Choose approved, rejected, or suspended for the risk-control review.",

STAKING_POLICY_NOT_PROVISIONED:
  "A pending risk-control record must be provisioned before review.",

STAKING_POLICY_NOT_PENDING_REVIEW:
  "This risk-control record is no longer awaiting review.",

STAKING_POLICY_REVIEW_STALE:
  "The project stage or global staking policy changed. Review the current risk limits.",

PROJECT_STAKING_STAGE_REQUIRED:
  "Assign an approved staking stage before provisioning risk controls.",
    GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED:
      "The universal Testnet risk policy is missing or incomplete.",

    GLOBAL_UNIVERSAL_RISK_POLICY_INVALID:
      "The universal Testnet risk policy failed validation.",

    GLOBAL_UNIVERSAL_RISK_POLICY_MUST_MATCH_APPROVED_LIMITS:
      "The universal Testnet risk policy must remain at 50% reserve, 25% deployment and 100 PI maximum active principal.",

PROJECT_TREASURY_NOT_CONFIGURED:
  "Configure an active project treasury and liquidity target before provisioning risk controls.",

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
        ,

    // TESTNET PROJECT-LEVEL STAKING ENABLEMENT
    TESTNET_STAKING_ENABLEMENT_FIELDS_REQUIRED:
      "A Testnet project, enable/disable decision, and valid reason are required.",
    TESTNET_STAKING_ENABLEMENT_REASON_REQUIRED:
      "Enter a reason of at least 10 characters and no more than 500 characters.",
    TESTNET_STAKING_ENABLEMENT_ADMIN_REQUIRED:
      "Only an active Testnet Super Admin may enable or disable project staking.",
    TESTNET_STAKING_ENABLEMENT_PROJECT_NOT_FOUND:
      "The Testnet project could not be found.",
    TESTNET_STAKING_ENABLEMENT_PROJECT_NOT_APPROVED:
      "The project is not currently approved in Testnet.",
    TESTNET_STAKING_ENABLEMENT_MAINNET_APPROVAL_REQUIRED:
      "The project does not have a verified Mainnet-approved mirror record.",
    TESTNET_STAKING_ENABLEMENT_RISK_CONTROLS_NOT_APPROVED:
      "ALBUKHR risk controls must be approved before project staking can be enabled.",
    TESTNET_STAKING_ENABLEMENT_POLICY_NOT_CONFIGURED:
      "The global Testnet staking policy is incomplete or invalid.",
    TESTNET_STAKING_ENABLEMENT_LIMITS_INVALID:
      "The approved project risk limits are incomplete or do not match the current global policy.",
    TESTNET_STAKING_ENABLEMENT_TREASURY_NOT_READY:
      "The project treasury must be active, use the approved global Testnet wallet, and meet its verified liquidity target.",
    TESTNET_STAKING_ENABLEMENT_OFFERS_NOT_READY:
      "At least one active owner offer is required, and every active offer must comply with approved durations and reward caps.",
    TESTNET_STAKING_ENABLEMENT_COVERAGE_NOT_READY:
      "The project's tracked assets, liquidity buffer, reserve coverage, or outstanding principal do not meet the staking safety checks.",
    TESTNET_STAKING_ENABLEMENT_PENDING_INTENTS:
      "This project has unresolved stake-payment intents. Reconcile or cancel them before disabling staking.",
    TESTNET_STAKING_ENABLEMENT_GUARD_REJECTED:
      "The database rejected an unexpected change outside the project staking enablement flag.",
    TESTNET_STAKING_MAX_DEPLOYMENT_EXCEEDED:
  "This stake would exceed the approved Universal Risk maximum-deployment limit.",
    TESTNET_STAKING_ENABLEMENT_FAILED:
      "Project staking could not be enabled or disabled. Review the current Testnet policy and try again."
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
      .select("id,project_code,name,network,status,owner_user_id")
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
        // Require server-side payment arming before Pi payment processing.
    if (intent.status === "pending_payment") {
      const intentMetadata = intent.metadata &&
        typeof intent.metadata === "object"
          ? intent.metadata
          : {};

      if (intentMetadata.payment_started !== true) {
        throw new Error("STAKE_INTENT_PAYMENT_NOT_ARMED");
      }
    }
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

// List approved Testnet projects for Universal Risk Controls.
// This endpoint deliberately does not read projects.staking_stage.
router.post("/admin/risk-projects", async (req, res) => {
  try {
    const adminSession = await getTestnetAdminSession(req);

    const roles = Array.isArray(adminSession && adminSession.roles)
      ? adminSession.roles
      : [];

    if (!roles.includes("super_admin")) {
      throw new Error("STAKING_POLICY_SUPER_ADMIN_REQUIRED");
    }

    const { data: projectRows, error: projectError } =
      await supabase
        .from("projects")
        .select("id,project_code,name")
        .eq("network", NETWORK)
        .eq("status", "approved")
        .order("project_code", { ascending: true })
        .limit(100);

    if (projectError) {
      console.error(
        "[TESTNET RISK PROJECTS READ]",
        clean(projectError.message)
      );

      throw new Error("TESTNET_RISK_PROJECTS_READ_FAILED");
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
      throw new Error("TESTNET_RISK_PROJECTS_READ_FAILED");
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
        "[TESTNET RISK TREASURY READ]",
        clean(treasuryError.message)
      );

      throw new Error("TESTNET_RISK_TREASURY_READ_FAILED");
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
      "[TESTNET ADMIN RISK PROJECTS READ]",
      clean(error && error.message)
    );

    return apiError(res, error);
  }
});

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

    const { data: globalPolicy, error: globalPolicyError } = await supabase
      .from("testnet_global_treasury_policy")
      .select("staking_policy_active")
      .eq("singleton_id", 1)
      .eq("network", NETWORK)
      .maybeSingle();

    if (globalPolicyError || !globalPolicy) {
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
      global_staking_policy_active: globalPolicy.staking_policy_active === true,
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

    if (!(adminSession.roles || []).includes("super_admin")) {
      throw new Error("STAKING_POLICY_SUPER_ADMIN_REQUIRED");
    }

    const project = await getApprovedProject(
      req.body && req.body.projectId,
      req.body && req.body.projectCode
    );

    const { data, error } = await supabase.rpc(
      "provision_testnet_project_staking_risk_control",
      {
        p_project_id: project.id,
        p_admin_session_id: adminSession.id
      }
    );

    if (error || !data || !data.id) {
      const message = clean(error && error.message);

      console.error("[TESTNET STAKING POLICY PROVISION RPC]", message);

      if (message.includes("STAKING_POLICY_ALREADY_EXISTS"))
        throw new Error("STAKING_POLICY_ALREADY_EXISTS");

            if (message.includes("GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED"))
        throw new Error("GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED");
      if (message.includes("GLOBAL_UNIVERSAL_RISK_POLICY_INVALID"))
        throw new Error("GLOBAL_UNIVERSAL_RISK_POLICY_INVALID");
      if (message.includes("GLOBAL_UNIVERSAL_RISK_POLICY_MUST_MATCH_APPROVED_LIMITS"))
        throw new Error("GLOBAL_UNIVERSAL_RISK_POLICY_MUST_MATCH_APPROVED_LIMITS");

      if (message.includes("TESTNET_STAKING_SUPER_ADMIN_REQUIRED"))
        throw new Error("STAKING_POLICY_SUPER_ADMIN_REQUIRED");

      if (message.includes("PROJECT_TREASURY_OR_TARGET_NOT_CONFIGURED"))
        throw new Error("PROJECT_TREASURY_NOT_CONFIGURED");

      throw new Error("STAKING_POLICY_PROVISION_FAILED");
    }

    return res.status(201).json({
      success: true,
      network: NETWORK,
      project: {
        id: project.id,
        project_code: project.project_code,
        name: project.name
      },
      policy: data,
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

// Super Admin review is separate from provisioning.
// Approval never enables staking.
router.post("/admin/policy/review", async (req, res) => {
  try {
    const adminSession = await getTestnetAdminSession(req);

    if (!(adminSession.roles || []).includes("super_admin")) {
      throw new Error("STAKING_POLICY_SUPER_ADMIN_REQUIRED");
    }

    const project = await getApprovedProject(
      req.body && req.body.projectId,
      req.body && req.body.projectCode
    );

    const decision = clean(
      req.body && req.body.decision
    ).toLowerCase();

    if (!["approved", "rejected", "suspended"].includes(decision)) {
      throw new Error("STAKING_POLICY_REVIEW_DECISION_INVALID");
    }

    const { data, error } = await supabase.rpc(
      "review_testnet_project_staking_risk_control",
      {
        p_project_id: project.id,
        p_admin_session_id: adminSession.id,
        p_decision: decision
      }
    );

    if (error || !data || !data.id) {
      const message = clean(error && error.message);

      console.error("[TESTNET STAKING POLICY REVIEW RPC]", message);

      if (message.includes("STAKING_POLICY_NOT_PROVISIONED"))
        throw new Error("STAKING_POLICY_NOT_PROVISIONED");

      if (message.includes("STAKING_POLICY_NOT_PENDING_REVIEW"))
        throw new Error("STAKING_POLICY_NOT_PENDING_REVIEW");

      if (message.includes("TESTNET_RISK_CONTROLS_STALE_OR_POLICY_MISMATCH"))
        throw new Error("STAKING_POLICY_REVIEW_STALE");

      if (message.includes("TESTNET_STAKING_SUPER_ADMIN_REQUIRED"))
        throw new Error("STAKING_POLICY_SUPER_ADMIN_REQUIRED");

      throw new Error("STAKING_POLICY_REVIEW_FAILED");
    }

    return res.json({
      success: true,
      network: NETWORK,
      project: {
        id: project.id,
        project_code: project.project_code,
        name: project.name
      },
      policy: data,
      staking_enabled: false,
      requires_separate_staking_enablement: decision === "approved"
    });

  } catch (error) {
    console.error(
      "[TESTNET STAKING POLICY REVIEW]",
      clean(error && error.message)
    );

    return apiError(res, error);
  }
});

    // Project-level enablement is separate from global activation.
  // This endpoint never changes the global staking policy.
  router.post("/admin/policy/enablement", async (req, res) => {
    try {
      const adminSession = await getTestnetAdminSession(req);

      if (!(adminSession.roles || []).includes("super_admin")) {
        throw new Error("TESTNET_STAKING_ENABLEMENT_ADMIN_REQUIRED");
      }

      const projectId = clean(req.body && req.body.projectId);
      const projectCode = clean(req.body && req.body.projectCode);
      const enabled = req.body && req.body.enabled;
      const reason = clean(req.body && req.body.reason);

      if (!projectId || !projectCode || typeof enabled !== "boolean") {
        throw new Error("TESTNET_STAKING_ENABLEMENT_FIELDS_REQUIRED");
      }

      if (reason.length < 10 || reason.length > 500) {
        throw new Error("TESTNET_STAKING_ENABLEMENT_REASON_REQUIRED");
      }

      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("id,project_code,name,network,status")
        .eq("id", projectId)
        .eq("project_code", projectCode)
        .eq("network", NETWORK)
        .maybeSingle();

      if (projectError || !project) {
        throw new Error("TESTNET_STAKING_ENABLEMENT_PROJECT_NOT_FOUND");
      }

      const { data: globalPolicy, error: globalPolicyError } = await supabase
        .from("testnet_global_treasury_policy")
        .select("active,staking_policy_active")
        .eq("singleton_id", 1)
        .eq("network", NETWORK)
        .maybeSingle();

      if (globalPolicyError || !globalPolicy) {
        throw new Error("STAKING_POLICY_READ_FAILED");
      }

      const { data, error } = await supabase.rpc(
        "set_testnet_project_staking_enabled",
        {
          p_project_id: project.id,
          p_admin_session_id: adminSession.id,
          p_enabled: enabled,
          p_reason: reason
        }
      );

      if (error || !data) {
        const message = clean(error && error.message);

        const known = [
          "TESTNET_STAKING_ENABLEMENT_FIELDS_REQUIRED",
          "TESTNET_STAKING_ENABLEMENT_REASON_REQUIRED",
          "TESTNET_STAKING_ENABLEMENT_ADMIN_REQUIRED",
          "TESTNET_STAKING_ENABLEMENT_PROJECT_NOT_FOUND",
          "TESTNET_STAKING_ENABLEMENT_PROJECT_NOT_APPROVED",
          "TESTNET_STAKING_ENABLEMENT_MAINNET_APPROVAL_REQUIRED",
          "TESTNET_STAKING_ENABLEMENT_RISK_CONTROLS_NOT_APPROVED",
          "TESTNET_STAKING_ENABLEMENT_POLICY_NOT_CONFIGURED",
          "TESTNET_STAKING_ENABLEMENT_LIMITS_INVALID",
          "TESTNET_STAKING_ENABLEMENT_TREASURY_NOT_READY",
          "TESTNET_STAKING_ENABLEMENT_OFFERS_NOT_READY",
          "TESTNET_STAKING_ENABLEMENT_COVERAGE_NOT_READY",
          "TESTNET_STAKING_ENABLEMENT_PENDING_INTENTS",
          "TESTNET_STAKING_ENABLEMENT_GUARD_REJECTED"
        ];

        const mapped = known.find((code) => message.includes(code));

        console.error("[TESTNET PROJECT STAKING ENABLEMENT RPC]", message);

        throw new Error(
          mapped || "TESTNET_STAKING_ENABLEMENT_FAILED"
        );
      }

      return res.json({
        success: true,
        network: NETWORK,

        project: {
          id: project.id,
          project_code: project.project_code,
          name: project.name
        },

        staking_enabled: data.staking_enabled === true,
        approval_status: data.approval_status,

        global_treasury_active: globalPolicy.active === true,
        global_staking_policy_active:
          globalPolicy.staking_policy_active === true,

        global_activation_still_required:
          globalPolicy.staking_policy_active !== true
      });

    } catch (error) {
      console.error(
        "[TESTNET PROJECT STAKING ENABLEMENT]",
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

      const project = await getApprovedProject(
        req.body && req.body.projectId,
        req.body && req.body.projectCode
      );

      const treasury = await getTreasury(project.id);

      const [
        termsResult,
        controlsResult,
        coverageResult,
        globalPolicyResult
      ] = await Promise.all([
        supabase
          .from("project_staking_terms")
          .select("duration_days,min_stake,reward_rate,active")
          .eq("project_code", project.project_code)
          .eq("network", NETWORK)
          .eq("active", true)
          .order("duration_days", { ascending: true }),

        supabase
          .from("project_staking_risk_controls")
          .select(
            "staking_enabled,approval_status,minimum_liquidity," +
            "max_reward_rate,max_active_principal,capital_reserve_percent," +
            "maximum_deployment_percent,reward_reserve_coverage_percent"
          )
          .eq("project_id", project.id)
          .eq("network", NETWORK)
          .maybeSingle(),

        supabase.rpc("get_testnet_staking_coverage", {
          p_project_id: project.id
        }),

        supabase
          .from("testnet_global_treasury_policy")
          .select(
            "active,staking_policy_active,minimum_project_liquidity," +
            "staking_minimum_stake_amount," +
            "staking_reward_reserve_coverage_percent," +
            "staking_universal_risk_policy"
          )
          .eq("singleton_id", 1)
          .eq("network", NETWORK)
          .maybeSingle()
      ]);

      if (
        termsResult.error ||
        controlsResult.error ||
        coverageResult.error ||
        globalPolicyResult.error
      ) {
        throw new Error("STAKING_OFFERS_READ_FAILED");
      }

      const control = controlsResult.data;
      const coverage = Array.isArray(coverageResult.data)
        ? coverageResult.data[0]
        : coverageResult.data;

      const globalPolicy = globalPolicyResult.data;

      if (!globalPolicy) {
        throw new Error("STAKING_OFFERS_READ_FAILED");
      }

      const universalRiskPolicy =
        globalPolicy.staking_universal_risk_policy &&
        typeof globalPolicy.staking_universal_risk_policy === "object" &&
        !Array.isArray(globalPolicy.staking_universal_risk_policy)
          ? globalPolicy.staking_universal_risk_policy
          : null;

      const riskReserve = numeric(
        universalRiskPolicy &&
        universalRiskPolicy.capital_reserve_percent
      );

      const riskDeployment = numeric(
        universalRiskPolicy &&
        universalRiskPolicy.maximum_deployment_percent
      );

      const riskPrincipal = numeric(
        universalRiskPolicy &&
        universalRiskPolicy.max_active_principal
      );

      const universalRiskReady =
        riskReserve === 50 &&
        riskDeployment === 25 &&
        riskPrincipal === 100 &&
        numeric(globalPolicy.minimum_project_liquidity) === 100 &&
        numeric(globalPolicy.staking_minimum_stake_amount) === 10 &&
        numeric(globalPolicy.staking_reward_reserve_coverage_percent) === 100;

      const controlRiskReady =
        !!control &&
        numeric(control.capital_reserve_percent) === 50 &&
        numeric(control.maximum_deployment_percent) === 25 &&
        numeric(control.max_active_principal) === 100 &&
        numeric(control.minimum_liquidity) >= 100 &&
        numeric(control.reward_reserve_coverage_percent) === 100;

      const treasuryReady =
        clean(treasury.status).toLowerCase() === "active" &&
        numeric(treasury.verified_liquidity) !== null &&
        numeric(treasury.required_liquidity) !== null &&
        numeric(treasury.verified_liquidity) >=
          numeric(treasury.required_liquidity);

      const policyReady =
        !!control &&
        control.staking_enabled === true &&
        control.approval_status === "approved";

      const canStake =
        globalPolicy.active === true &&
        globalPolicy.staking_policy_active === true &&
        universalRiskReady &&
        controlRiskReady &&
        policyReady &&
        treasuryReady &&
        !!coverage &&
        coverage.staking_eligible === true;

      const terms = (termsResult.data || []).map((term) => ({
        duration_days: Number(term.duration_days),
        min_stake: Number(term.min_stake),
        reward_rate: Number(term.reward_rate),
        reward_percent: Number(term.reward_rate) * 100,
        available:
          canStake &&
          Number(term.reward_rate) > 0 &&
          Number(term.reward_rate) <= Number(control.max_reward_rate)
      }));

      return res.json({
        success: true,
        network: NETWORK,
        project: {
          id: project.id,
          project_code: project.project_code,
          name: project.name
        },
        can_stake: canStake,
        reason: canStake
          ? null
          : "STAKING_POLICY_OR_UNIVERSAL_RISK_OR_LIQUIDITY_NOT_READY",
        terms,
        coverage: coverage
          ? {
              verified_liquidity_contributed:
                Number(coverage.verified_liquidity_contributed || 0),
              liquidity_buffer:
                Number(coverage.liquidity_buffer || 0),
              capital_reserve_balance:
                Number(coverage.capital_reserve_balance || 0),
              project_operating_balance:
                Number(coverage.project_operating_balance || 0),
              reward_reserve_balance:
                Number(coverage.reward_reserve_balance || 0),
              total_tracked_assets:
                Number(coverage.total_tracked_assets || 0),
              total_liability:
                Number(coverage.total_liability || 0),
              coverage_ratio:
                coverage.coverage_ratio == null
                  ? null
                  : Number(coverage.coverage_ratio),
              staking_eligible:
                coverage.staking_eligible === true
            }
          : null
      });

    } catch (error) {
      console.error(
        "[TESTNET STAKING OFFERS]",
        clean(error && error.message)
      );

      return apiError(res, error);
    }
  });

  router.post("/owner/offers", async (req, res) => {
  try {
    const session = await getTestnetSession(req);
    const owned = await getOwnedProject(
      req.body && req.body.projectId,
      req.body && req.body.projectCode,
      session
    );
    const project = owned.project;

    // Read all configuration inputs from Testnet only.
    const [
      termsResult,
      controlResult,
      treasuryResult,
      globalPolicyResult,
      coverageResult
    ] = await Promise.all([
      supabase
        .from("project_staking_terms")
        .select("duration_days,min_stake,reward_rate,active")
        .eq("project_code", project.project_code)
        .eq("network", NETWORK)
        .order("duration_days", { ascending: true }),

      supabase
        .from("project_staking_risk_controls")
        .select(
          "staking_enabled,approval_status,minimum_liquidity," +
          "max_reward_rate,capital_reserve_percent," +
          "maximum_deployment_percent,max_active_principal," +
          "reward_reserve_coverage_percent"
        )
        .eq("project_id", project.id)
        .eq("network", NETWORK)
        .maybeSingle(),

      supabase
        .from("project_treasury")
        .select(
          "project_id,network,treasury_wallet,required_liquidity," +
          "verified_liquidity,status"
        )
        .eq("project_id", project.id)
        .eq("network", NETWORK)
        .maybeSingle(),

      supabase
        .from("testnet_global_treasury_policy")
        .select(
          "active,minimum_project_liquidity,allowed_duration_days," +
          "staking_policy_active,staking_minimum_stake_amount," +
                    "staking_reward_rates_by_duration,staking_universal_risk_policy," +
          "staking_reward_reserve_coverage_percent"
        )
        .eq("singleton_id", 1)
        .eq("network", NETWORK)
        .maybeSingle(),

      supabase.rpc("get_testnet_staking_coverage", {
        p_project_id: project.id
      })
    ]);

    if (
      termsResult.error ||
      controlResult.error ||
      treasuryResult.error ||
      globalPolicyResult.error ||
      coverageResult.error
    ) {
      throw new Error("STAKING_OFFERS_READ_FAILED");
    }

    const control = controlResult.data || null;
    const treasury = treasuryResult.data || null;
    const globalPolicy = globalPolicyResult.data;

    const coverage = Array.isArray(coverageResult.data)
      ? coverageResult.data[0] || null
      : coverageResult.data || null;

    if (!globalPolicy) {
      throw new Error("STAKING_OFFERS_READ_FAILED");
    }

    const numberOrNull = (value) => {
      if (value === null || value === undefined || value === "") {
        return null;
      }

      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const sameNumber = (left, right) =>
      left !== null &&
      right !== null &&
      Math.abs(left - right) < 0.0000001;

    const minimumProjectLiquidity = numberOrNull(
      globalPolicy.minimum_project_liquidity
    );

    const minimumStake = numberOrNull(
      globalPolicy.staking_minimum_stake_amount
    );

    const rewardCoveragePercent = numberOrNull(
      globalPolicy.staking_reward_reserve_coverage_percent
    );

    const requiredLiquidity = numberOrNull(
      treasury && treasury.required_liquidity
    );

    const verifiedLiquidity = numberOrNull(
      treasury && treasury.verified_liquidity
    );

    const rewardCaps =
      globalPolicy.staking_reward_rates_by_duration &&
      typeof globalPolicy.staking_reward_rates_by_duration === "object" &&
      !Array.isArray(globalPolicy.staking_reward_rates_by_duration)
        ? globalPolicy.staking_reward_rates_by_duration
        : {};

        const universalRiskPolicy =
      globalPolicy.staking_universal_risk_policy &&
      typeof globalPolicy.staking_universal_risk_policy === "object" &&
      !Array.isArray(globalPolicy.staking_universal_risk_policy)
        ? globalPolicy.staking_universal_risk_policy
        : null;

    const allowedDurations = Array.isArray(
      globalPolicy.allowed_duration_days
    )
      ? Array.from(
          new Set(
            globalPolicy.allowed_duration_days
              .map(Number)
              .filter(
                (days) => Number.isInteger(days) && days > 0
              )
          )
        ).sort((a, b) => a - b)
      : [];

    const rewardCapValues = Object.keys(rewardCaps)
      .map((duration) => numberOrNull(rewardCaps[duration]))
      .filter(
        (rate) => rate !== null && rate > 0 && rate <= 1
      );

    const globalMaximumRewardRate = rewardCapValues.length
      ? Math.max.apply(null, rewardCapValues)
      : null;

    const rewardCapsReady =
      allowedDurations.length > 0 &&
      allowedDurations.every((days) => {
        const cap = numberOrNull(rewardCaps[String(days)]);
        return cap !== null && cap > 0 && cap <= 1;
      });

        const riskCapitalReserve = numberOrNull(
      universalRiskPolicy && universalRiskPolicy.capital_reserve_percent
    );

    const riskMaximumDeployment = numberOrNull(
      universalRiskPolicy && universalRiskPolicy.maximum_deployment_percent
    );

    const riskMaximumPrincipal = numberOrNull(
      universalRiskPolicy && universalRiskPolicy.max_active_principal
    );

    // These are the globally approved Testnet risk limits.
    // The database validator independently enforces the same exact values.
        const universalRiskPolicyReady =
      riskCapitalReserve === 50 &&
      riskMaximumDeployment === 25 &&
      riskMaximumPrincipal === 100 &&
      minimumProjectLiquidity === 100 &&
      minimumStake === 10 &&
      rewardCoveragePercent === 100;
    
    const treasuryReady =
      !!treasury &&
      clean(treasury.status).toLowerCase() === "active" &&
      !!clean(treasury.treasury_wallet) &&
      clean(treasury.treasury_wallet) === clean(piTestnetAppWallet) &&
      requiredLiquidity !== null &&
      minimumProjectLiquidity !== null &&
      requiredLiquidity >= minimumProjectLiquidity;

    const controlMaximumRewardRate = numberOrNull(
      control && control.max_reward_rate
    );

    const controlMinimumLiquidity = numberOrNull(
      control && control.minimum_liquidity
    );

    const controlCapitalReserve = numberOrNull(
      control && control.capital_reserve_percent
    );

    const controlMaximumDeployment = numberOrNull(
      control && control.maximum_deployment_percent
    );

    const controlMaximumPrincipal = numberOrNull(
      control && control.max_active_principal
    );

    const controlRewardCoverage = numberOrNull(
      control && control.reward_reserve_coverage_percent
    );

    const expectedMinimumLiquidity =
      requiredLiquidity !== null &&
      minimumProjectLiquidity !== null
        ? Math.max(
            requiredLiquidity,
            minimumProjectLiquidity
          )
        : null;

    // Super Admin approval is required before owner offer setup.
    // Global activation and project staking_enabled remain
    // separate investor-staking controls.
    const riskControlsMatchCurrentPolicy =
      !!control &&
            control.approval_status === "approved" &&
      universalRiskPolicyReady &&
      treasuryReady &&
      globalMaximumRewardRate !== null &&
      sameNumber(
        controlMinimumLiquidity,
        expectedMinimumLiquidity
      ) &&
      sameNumber(
        controlCapitalReserve,
        riskCapitalReserve
      ) &&
      sameNumber(
        controlMaximumDeployment,
        riskMaximumDeployment
      ) &&
      sameNumber(
        controlMaximumPrincipal,
        riskMaximumPrincipal
      ) &&
      sameNumber(
        controlMaximumRewardRate,
        globalMaximumRewardRate
      ) &&
      sameNumber(
        controlRewardCoverage,
        rewardCoveragePercent
      );

    const canConfigure =
      riskControlsMatchCurrentPolicy &&
      minimumStake !== null &&
      minimumStake > 0 &&
      rewardCapsReady;

    const targetMinimum =
      expectedMinimumLiquidity !== null
        ? Math.max(
            expectedMinimumLiquidity,
            controlMinimumLiquidity || 0
          )
        : null;

    const targetMet =
      treasuryReady &&
      verifiedLiquidity !== null &&
      targetMinimum !== null &&
      verifiedLiquidity >= targetMinimum;

    // Use the same reserve, deployment and principal
    // limits enforced by the database staking engine.
        const effectiveCapitalReserve =
      universalRiskPolicyReady && controlCapitalReserve !== null
        ? Math.max(riskCapitalReserve, controlCapitalReserve)
        : null;

    const effectiveMaximumDeployment =
      universalRiskPolicyReady && controlMaximumDeployment !== null
        ? Math.min(riskMaximumDeployment, controlMaximumDeployment)
        : null;

    const effectiveMaximumPrincipal =
      universalRiskPolicyReady && controlMaximumPrincipal !== null
        ? Math.min(riskMaximumPrincipal, controlMaximumPrincipal)
        : null;

    const existingTerms = new Map(
      (termsResult.data || []).map((term) => [
        Number(term.duration_days),
        term
      ])
    );

    const terms = allowedDurations.map((durationDays) => {
      const saved = existingTerms.get(durationDays) || null;

      const globalDurationCap = numberOrNull(
        rewardCaps[String(durationDays)]
      );

      const effectiveRewardCap =
        globalDurationCap !== null &&
        controlMaximumRewardRate !== null
          ? Math.min(
              globalDurationCap,
              controlMaximumRewardRate
            )
          : globalDurationCap;

      const savedRewardRate = saved
        ? numberOrNull(saved.reward_rate)
        : null;

      return {
        duration_days: durationDays,

        min_stake: minimumStake,

        reward_rate:
          savedRewardRate !== null &&
          saved &&
          saved.active === true
            ? savedRewardRate
            : 0,

        reward_percent:
          savedRewardRate !== null &&
          saved &&
          saved.active === true
            ? savedRewardRate * 100
            : 0,

        max_reward_rate: effectiveRewardCap,

        max_reward_percent:
          effectiveRewardCap === null
            ? 0
            : effectiveRewardCap * 100,

        active: !!saved && saved.active === true
      };
    });

        const policyReadyForStaking =
      globalPolicy.active === true &&
      globalPolicy.staking_policy_active === true &&
      !!control &&
      control.staking_enabled === true &&
      control.approval_status === "approved";

    const coverageReady =
      !!coverage &&
      coverage.staking_eligible === true;

    const canStake =
      canConfigure &&
      policyReadyForStaking &&
      targetMet &&
      coverageReady;

    let lockedReason = null;

    if (!control) {
      lockedReason = "STAKING_POLICY_NOT_PROVISIONED";
    } else if (control.approval_status !== "approved") {
      lockedReason = "STAKING_POLICY_NOT_APPROVED";
        } else if (!universalRiskPolicyReady) {
      lockedReason = "GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED";
    } else if (!treasuryReady) {
      lockedReason = "PROJECT_TREASURY_OR_TARGET_NOT_CONFIGURED";
    } else if (!riskControlsMatchCurrentPolicy) {
      lockedReason = "STAKING_POLICY_CONFIGURATION_MISMATCH";
    } else if (
      !rewardCapsReady ||
      minimumStake === null ||
      minimumStake <= 0
    ) {
      lockedReason = "GLOBAL_STAKING_REWARD_LIMIT_INVALID";
    } else if (!globalPolicy.staking_policy_active) {
      lockedReason = "GLOBAL_STAKING_POLICY_INACTIVE";
    } else if (control.staking_enabled !== true) {
      lockedReason = "PROJECT_STAKING_NOT_ENABLED";
    } else if (!targetMet) {
      lockedReason = "PROJECT_LIQUIDITY_REQUIREMENT_NOT_MET";
    } else if (!coverageReady) {
      lockedReason = "LIQUIDITY_COVERAGE_NOT_READY";
    }

    return res.json({
      success: true,
      network: NETWORK,

            project: {
        id: project.id,
        project_code: project.project_code,
        name: project.name
      },

      can_configure: canConfigure,
      can_stake: canStake,

      policy: {
        staking_policy_active:
          globalPolicy.staking_policy_active === true,

        staking_enabled:
          !!control && control.staking_enabled === true,

        approval_status:
          control
            ? control.approval_status
            : "not_provisioned",

        minimum_liquidity: controlMinimumLiquidity,

        max_reward_rate: controlMaximumRewardRate,

        max_reward_percent:
          controlMaximumRewardRate === null
            ? null
            : controlMaximumRewardRate * 100,

        capital_reserve_percent: controlCapitalReserve,

        maximum_deployment_percent: controlMaximumDeployment,

        max_active_principal: controlMaximumPrincipal,

        reward_reserve_coverage_percent: controlRewardCoverage
      },

      terms: terms,

      preview: {
        minimum_stake: minimumStake,

        required_liquidity: requiredLiquidity,

        verified_liquidity: verifiedLiquidity,

        target_met: targetMet,

        // This is the same available owner-liquidity balance
        // checked by create_testnet_stake_intent().
        available_reward_liquidity:
          numberOrNull(
            coverage && coverage.owner_liquidity_available
          ) || 0,

        outstanding_principal:
          numberOrNull(
            coverage && coverage.outstanding_principal
          ) || 0,

        max_active_principal:
          effectiveMaximumPrincipal || 0,

        capital_reserve_percent:
          effectiveCapitalReserve || 0,

                maximum_deployment_percent:
          effectiveMaximumDeployment || 0
      },

      coverage: coverage
        
        ? {
            verified_liquidity_contributed:
              Number(coverage.verified_liquidity_contributed || 0),

            owner_liquidity_available:
              Number(coverage.owner_liquidity_available || 0),

            capital_reserve_balance:
              Number(coverage.capital_reserve_balance || 0),

            project_operating_balance:
              Number(coverage.project_operating_balance || 0),

            reward_reserve_balance:
              Number(coverage.reward_reserve_balance || 0),

            total_tracked_assets:
              Number(coverage.total_tracked_assets || 0),

            outstanding_principal:
              Number(coverage.outstanding_principal || 0),

            outstanding_rewards:
              Number(coverage.outstanding_rewards || 0),

            total_liability:
              Number(coverage.total_liability || 0),

            surplus:
              Number(coverage.surplus || 0),

            coverage_ratio:
              coverage.coverage_ratio == null
                ? null
                : Number(coverage.coverage_ratio),

            staking_eligible:
              coverage.staking_eligible === true
          }
        : null,

      locked_reason: lockedReason
    });

  } catch (error) {
    console.error(
      "[TESTNET STAKING OWNER OFFERS]",
      clean(error && error.message)
    );

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
        if (message.includes("STAKING_POLICY_REVIEW_STALE")) throw new Error("STAKING_POLICY_REVIEW_STALE");
                if (message.includes("GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED")) throw new Error("GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED");
        if (message.includes("GLOBAL_UNIVERSAL_RISK_POLICY_INVALID")) throw new Error("GLOBAL_UNIVERSAL_RISK_POLICY_INVALID");
        if (message.includes("GLOBAL_UNIVERSAL_RISK_POLICY_MUST_MATCH_APPROVED_LIMITS")) throw new Error("GLOBAL_UNIVERSAL_RISK_POLICY_MUST_MATCH_APPROVED_LIMITS");
        if (message.includes("PROJECT_TREASURY_NOT_CONFIGURED")) throw new Error("PROJECT_TREASURY_NOT_CONFIGURED");
        if (message.includes("GLOBAL_TESTNET_POLICY_NOT_CONFIGURED")) throw new Error("GLOBAL_TESTNET_POLICY_NOT_CONFIGURED");
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
  console.error(
    "[TESTNET STAKE INTENT RPC]",
    clean(error && error.message)
  );

  const message = clean(error && error.message);

  const mapped = new Error(
    message.includes("TESTNET_STAKING_MAX_DEPLOYMENT_EXCEEDED")
      ? "TESTNET_STAKING_MAX_DEPLOYMENT_EXCEEDED"
      : message.includes("STAKE_INTENT_ALREADY_PENDING")
        ? "STAKE_INTENT_ALREADY_PENDING"
        : message.includes("STAKING_NOT_ENABLED")
          ? "STAKING_NOT_ENABLED_OR_NOT_APPROVED"
          : message.includes("STAKING_TERM_NOT_ACTIVE")
            ? "STAKING_TERM_NOT_ACTIVE"
            : message.includes("LIQUIDITY") ||
              message.includes("COVERAGE") ||
              message.includes("RESERVE")
              ? "STAKING_INTENT_CREATE_FAILED"
              : "STAKING_INTENT_CREATE_FAILED"
  );

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
