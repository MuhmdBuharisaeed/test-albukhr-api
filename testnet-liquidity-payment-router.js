const express = require("express");

/*
 * ALBUKHR TESTNET LIQUIDITY PAYMENT ROUTER v2
 *
 * Purpose:
 *   Handle Pi Testnet User-to-App payments that fund a selected
 *   ALBUKHR Testnet project's liquidity requirement.
 *
 * Architectural boundaries:
 *   - Testnet only.
 *   - Requires an existing ALBUKHR Testnet gateway session.
 *   - Pi access token is ONLY the Testnet Pi token supplied by
 *     the Testnet Pi SDK payment flow. It is verified server-side
 *     through Pi /me and is never persisted.
 *   - Mainnet Pi access tokens are never accepted or stored here.
 *   - Project identity is authoritative from Pi payment metadata.
 *   - project_treasury is the ALBUKHR project treasury/readiness
 *     configuration. It is NOT assumed to be the Pi App wallet
 *     that receives a U2A payment.
 *   - project_liquidity_payments is the payment record source.
 *   - Verification remains an admin-controlled operation through
 *     the existing testnet-liquidity-admin Edge Function.
 *
 * Pi payment flow:
 *   createPayment()
 *      -> /approve
 *      -> user signs Testnet transaction
 *      -> /complete
 *      -> payment record remains verification_status=pending
 *      -> Testnet admin verifies the completed payment
 */

function createTestnetLiquidityPaymentRouter({
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
  const ACTION = "add_liquidity";
  const MIN_LIQUIDITY = 100;

  function clean(value) {
    return String(value == null ? "" : value).trim();
  }

  function numeric(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function bearer(req) {
    const value = clean(req.get("authorization"));
    return /^Bearer\s+/i.test(value)
      ? value.replace(/^Bearer\s+/i, "").trim()
      : "";
  }

  function testnetSessionToken(req) {
    const value = clean(req.get("x-testnet-session"));
    return value;
  }

  function errorCode(error) {
    return clean(error?.message) || "TESTNET_LIQUIDITY_PAYMENT_ERROR";
  }

  function sendError(res, error) {
    const code = errorCode(error);

    const statusMap = {
      TESTNET_SESSION_REQUIRED: 401,
      TESTNET_SESSION_INVALID: 401,
      TESTNET_SESSION_REVOKED: 401,
      TESTNET_SESSION_EXPIRED: 401,
      PI_ACCESS_TOKEN_REQUIRED: 401,
      PI_ACCESS_TOKEN_INVALID: 401,
      PI_PAYMENT_NOT_FOUND: 404,
      PI_PAYMENT_USER_MISMATCH: 403,
      PI_PAYMENT_NETWORK_INVALID: 400,
      PI_PAYMENT_DIRECTION_INVALID: 400,
      PI_PAYMENT_CANCELLED: 409,
      PI_PAYMENT_PROJECT_REQUIRED: 400,
      PI_PAYMENT_PROJECT_MISMATCH: 400,
      PI_PAYMENT_METADATA_NETWORK_INVALID: 400,
      PI_PAYMENT_METADATA_ACTION_INVALID: 400,
      PI_PAYMENT_AMOUNT_INVALID: 400,
      PI_PAYMENT_RECIPIENT_MISMATCH: 400,
      PROJECT_ID_REQUIRED: 400,
      PROJECT_CODE_REQUIRED: 400,
      PROJECT_NOT_APPROVED: 400,
      TREASURY_NOT_CONFIGURED: 400,
      TREASURY_NOT_ACTIVE: 400,
      TREASURY_WALLET_REQUIRED: 400,
      PROJECT_LIQUIDITY_ALREADY_READY: 409,
      LIQUIDITY_AMOUNT_BELOW_REMAINING_REQUIREMENT: 400,
      PAYMENT_ID_REQUIRED: 400,
      PAYMENT_COMPLETION_FIELDS_REQUIRED: 400,
      PI_PAYMENT_TXID_MISMATCH: 400,
      PI_PAYMENT_NOT_APPROVED: 409,
      PI_PAYMENT_TRANSACTION_NOT_VERIFIED: 409,
      LIQUIDITY_PAYMENT_READ_FAILED: 500,
      LIQUIDITY_PAYMENT_UPSERT_FAILED: 500,
      PI_APPROVE_FAILED: 502,
      PI_COMPLETE_FAILED: 502,
    };

    const status = Number(
      error?.status ||
      statusMap[code] ||
      400
    );

    return res.status(status).json({
      success: false,
      network: NETWORK,
      error: code,
    });
  }

  async function getTestnetSession(req) {
    const token = testnetSessionToken(req);

    if (!token) {
      throw new Error("TESTNET_SESSION_REQUIRED");
    }

    const crypto = require("crypto");
    const hash = crypto
      .createHash("sha256")
      .update(token, "utf8")
      .digest("hex");

    const { data, error } = await supabase
      .from("testnet_sessions")
      .select(
        "id,pi_uid,username,wallet_address,network,expires_at,revoked_at"
      )
      .eq("session_hash", hash)
      .eq("network", NETWORK)
      .maybeSingle();

    if (error) {
      throw new Error("TESTNET_SESSION_LOOKUP_FAILED");
    }

    if (!data) {
      throw new Error("TESTNET_SESSION_INVALID");
    }

    if (data.revoked_at) {
      throw new Error("TESTNET_SESSION_REVOKED");
    }

    if (
      !data.expires_at ||
      new Date(data.expires_at).getTime() <= Date.now()
    ) {
      throw new Error("TESTNET_SESSION_EXPIRED");
    }

    return data;
  }

  async function getPiUser(accessToken) {
    const token = clean(accessToken);

    if (!token) {
      throw new Error("PI_ACCESS_TOKEN_REQUIRED");
    }

    try {
      const response = await axios.get(
        `${piApiBase}/me`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          timeout: 15000,
        }
      );

      if (!response.data?.uid) {
        throw new Error("PI_ACCESS_TOKEN_INVALID");
      }

      return response.data;
    } catch (error) {
      if (error?.message === "PI_ACCESS_TOKEN_INVALID") {
        throw error;
      }

      const status = Number(error?.response?.status || 0);
      if (status === 401 || status === 403) {
        const invalid = new Error("PI_ACCESS_TOKEN_INVALID");
        invalid.status = 401;
        throw invalid;
      }

      throw new Error("PI_ACCESS_TOKEN_VERIFY_FAILED");
    }
  }

  function piKeyHeaders(extra = {}) {
    return {
      Authorization: `Key ${piApiKey}`,
      ...extra,
    };
  }

  async function getPayment(paymentId) {
    const id = clean(paymentId);

    if (!id) {
      throw new Error("PAYMENT_ID_REQUIRED");
    }

    try {
      const response = await axios.get(
        `${piApiBase}/payments/${encodeURIComponent(id)}`,
        {
          headers: piKeyHeaders(),
          timeout: 15000,
        }
      );

      if (!response.data) {
        throw new Error("PI_PAYMENT_NOT_FOUND");
      }

      return response.data;
    } catch (error) {
      if (error?.message === "PI_PAYMENT_NOT_FOUND") {
        throw error;
      }

      if (Number(error?.response?.status || 0) === 404) {
        throw new Error("PI_PAYMENT_NOT_FOUND");
      }

      throw new Error("PI_PAYMENT_READ_FAILED");
    }
  }

  async function approvePayment(paymentId) {
    try {
      const response = await axios.post(
        `${piApiBase}/payments/${encodeURIComponent(paymentId)}/approve`,
        {},
        {
          headers: piKeyHeaders({
            "Content-Type": "application/json",
          }),
          timeout: 15000,
        }
      );

      return response.data || null;
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      const wrapped = new Error("PI_APPROVE_FAILED");
      wrapped.status = status >= 400 && status < 600 ? status : 502;
      wrapped.cause = error;
      throw wrapped;
    }
  }

  async function completePayment(paymentId, txid) {
    try {
      const response = await axios.post(
        `${piApiBase}/payments/${encodeURIComponent(paymentId)}/complete`,
        { txid },
        {
          headers: piKeyHeaders({
            "Content-Type": "application/json",
          }),
          timeout: 15000,
        }
      );

      return response.data || null;
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      const wrapped = new Error("PI_COMPLETE_FAILED");
      wrapped.status = status >= 400 && status < 600 ? status : 502;
      wrapped.cause = error;
      throw wrapped;
    }
  }

  function paymentMetadata(payment) {
    return payment &&
      payment.metadata &&
      typeof payment.metadata === "object"
      ? payment.metadata
      : {};
  }

  function paymentId(payment) {
    return clean(payment?.identifier || payment?.id);
  }

  function paymentAmount(payment) {
    return numeric(payment?.amount);
  }

  function validatePaymentBasics(payment) {
    if (!payment) {
      throw new Error("PI_PAYMENT_NOT_FOUND");
    }

    const network = clean(payment.network).toLowerCase();

    if (
      network !== "pi testnet" &&
      network !== "testnet"
    ) {
      throw new Error("PI_PAYMENT_NETWORK_INVALID");
    }

    if (clean(payment.direction) !== "user_to_app") {
      throw new Error("PI_PAYMENT_DIRECTION_INVALID");
    }

    if (
      payment?.status?.cancelled === true ||
      payment?.status?.user_cancelled === true
    ) {
      throw new Error("PI_PAYMENT_CANCELLED");
    }

    const amount = paymentAmount(payment);
    if (amount === null || amount <= 0) {
      throw new Error("PI_PAYMENT_AMOUNT_INVALID");
    }
  }

  function validatePaymentUser(payment, piUser) {
    const paymentUid = clean(payment?.user_uid);
    const verifiedUid = clean(piUser?.uid);

    if (!paymentUid || !verifiedUid || paymentUid !== verifiedUid) {
      throw new Error("PI_PAYMENT_USER_MISMATCH");
    }
  }

  function resolveProjectIdentity(payment, body) {
    const metadata = paymentMetadata(payment);

    const metadataProjectId = clean(metadata.project_id);
    const metadataProjectCode = clean(metadata.project_code);

    if (!metadataProjectId) {
      throw new Error("PI_PAYMENT_PROJECT_REQUIRED");
    }

    if (!metadataProjectCode) {
      throw new Error("PROJECT_CODE_REQUIRED");
    }

    const suppliedProjectId = clean(body?.projectId);
    const suppliedProjectCode = clean(body?.projectCode);

    if (
      suppliedProjectId &&
      suppliedProjectId !== metadataProjectId
    ) {
      throw new Error("PI_PAYMENT_PROJECT_MISMATCH");
    }

    if (
      suppliedProjectCode &&
      suppliedProjectCode !== metadataProjectCode
    ) {
      throw new Error("PI_PAYMENT_PROJECT_MISMATCH");
    }

    return {
      projectId: metadataProjectId,
      projectCode: metadataProjectCode,
    };
  }

  function validateMetadata(payment, projectId, projectCode) {
    const metadata = paymentMetadata(payment);
    const network = clean(metadata.network).toLowerCase();
    const action = clean(metadata.action);

    if (network !== NETWORK) {
      throw new Error("PI_PAYMENT_METADATA_NETWORK_INVALID");
    }

    if (action !== ACTION) {
      throw new Error("PI_PAYMENT_METADATA_ACTION_INVALID");
    }

    if (
      clean(metadata.project_id) !== clean(projectId) ||
      clean(metadata.project_code) !== clean(projectCode)
    ) {
      throw new Error("PI_PAYMENT_PROJECT_MISMATCH");
    }
  }

  function validatePaymentDestination(payment) {
    const expected = clean(piTestnetAppWallet);

    /*
     * Pi U2A payments go to the registered Pi App wallet.
     * project_treasury.treasury_wallet is intentionally NOT used
     * as the PaymentDTO.to_address expectation because Pi.createPayment
     * does not choose an arbitrary per-project recipient.
     *
     * When PI_TESTNET_APP_WALLET is configured, enforce it.
     */
    if (!expected) return;

    const actual = clean(payment?.to_address);

    if (actual && actual !== expected) {
      throw new Error("PI_PAYMENT_RECIPIENT_MISMATCH");
    }
  }

  function validateCompletionTxid(payment, txid) {
    const supplied = clean(txid);
    if (!supplied) {
      throw new Error("PAYMENT_COMPLETION_FIELDS_REQUIRED");
    }

    const expected = clean(
      payment?.transaction?.txid ||
      payment?.transaction?.tx_hash ||
      payment?.txid
    );

    if (expected && expected !== supplied) {
      throw new Error("PI_PAYMENT_TXID_MISMATCH");
    }
  }

  async function getApprovedProject(projectId, projectCode) {
    const id = clean(projectId);
    const code = clean(projectCode);

    if (!id) throw new Error("PROJECT_ID_REQUIRED");
    if (!code) throw new Error("PROJECT_CODE_REQUIRED");

    const { data, error } = await supabase
      .from("projects")
      .select(
        "id,project_code,slug,name,status,network"
      )
      .eq("id", id)
      .eq("project_code", code)
      .eq("network", NETWORK)
      .eq("status", "approved")
      .maybeSingle();

    if (error) {
      throw new Error("PROJECT_READ_FAILED");
    }

    if (!data) {
      throw new Error("PROJECT_NOT_APPROVED");
    }

    return data;
  }

  async function getTreasury(projectId) {
    const { data, error } = await supabase
      .from("project_treasury")
      .select(
        "id,project_id,network,treasury_wallet,required_liquidity,verified_liquidity,status"
      )
      .eq("project_id", projectId)
      .eq("network", NETWORK)
      .maybeSingle();

    if (error) {
      throw new Error("TREASURY_READ_FAILED");
    }

    if (!data) {
      throw new Error("TREASURY_NOT_CONFIGURED");
    }

    if (clean(data.status).toLowerCase() !== "active") {
      throw new Error("TREASURY_NOT_ACTIVE");
    }

    if (!clean(data.treasury_wallet)) {
      throw new Error("TREASURY_WALLET_REQUIRED");
    }

    return data;
  }

  async function verifiedLiquidity(projectId) {
    const { data, error } = await supabase
      .from("project_liquidity_payments")
      .select("amount")
      .eq("project_id", projectId)
      .eq("network", NETWORK)
      .eq("verification_status", "verified")
      .eq("pi_status", "completed");

    if (error) {
      throw new Error("LIQUIDITY_READ_FAILED");
    }

    return (data || []).reduce(
      (sum, row) => sum + Number(row.amount || 0),
      0
    );
  }

  async function fundingState(projectId, treasury) {
    const verified = await verifiedLiquidity(projectId);
    const required = Math.max(
      MIN_LIQUIDITY,
      Number(treasury.required_liquidity || 0)
    );
    const due = Math.max(0, required - verified);

    return {
      verified,
      required,
      due,
    };
  }

  async function validateFunding(payment, projectId, treasury) {
    const state = await fundingState(projectId, treasury);
    const amount = paymentAmount(payment);

    if (state.due <= 0) {
      throw new Error("PROJECT_LIQUIDITY_ALREADY_READY");
    }

    if (amount < state.due) {
      throw new Error("LIQUIDITY_AMOUNT_BELOW_REMAINING_REQUIREMENT");
    }

    return state;
  }

  async function readExistingPayment(paymentIdentifier) {
    const { data, error } = await supabase
      .from("project_liquidity_payments")
      .select(
        "id,payment_id,project_id,payer_pi_uid,amount,recipient_wallet,network,action,pi_status,verification_status,verified_at,verification_reference,metadata"
      )
      .eq("payment_id", paymentIdentifier)
      .eq("network", NETWORK)
      .maybeSingle();

    if (error) {
      throw new Error("LIQUIDITY_PAYMENT_READ_FAILED");
    }

    return data || null;
  }

  async function upsertPaymentRecord({
    payment,
    project,
    treasury,
    piUser,
    session,
    piStatus,
    txid = null,
  }) {
    const identifier = paymentId(payment);
    const amount = paymentAmount(payment);

    if (!identifier) {
      throw new Error("PAYMENT_ID_REQUIRED");
    }

    if (amount === null || amount <= 0) {
      throw new Error("PI_PAYMENT_AMOUNT_INVALID");
    }

    const existing = await readExistingPayment(identifier);
    const currentMetadata = paymentMetadata(payment);

    const metadata = {
      ...currentMetadata,
      network: NETWORK,
      action: ACTION,
      project_id: project.id,
      project_code: project.project_code,
      testnet_pi_uid: clean(piUser?.uid || payment?.user_uid) || null,
      gateway_pi_uid: clean(session?.pi_uid) || null,
    };

    if (piUser?.username) {
      metadata.username = piUser.username;
    }

    if (txid) {
      metadata.txid = txid;
    }

    const payload = {
      payment_id: identifier,
      project_id: project.id,
      payer_pi_uid:
        clean(piUser?.uid || payment?.user_uid),
      amount,
      /*
       * Keep the existing schema meaning intact: this is the ALBUKHR
       * project treasury wallet configured in project_treasury.
       */
      recipient_wallet: treasury.treasury_wallet,
      network: NETWORK,
      action: ACTION,
      pi_status: piStatus,
      verification_status:
        existing?.verification_status || "pending",
      verified_at:
        existing?.verified_at || null,
      verification_reference:
        existing?.verification_reference || null,
      metadata,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("project_liquidity_payments")
      .upsert(payload, { onConflict: "payment_id" })
      .select(
        "id,payment_id,project_id,payer_pi_uid,amount,recipient_wallet,network,action,pi_status,verification_status,verified_at,verification_reference,metadata"
      )
      .maybeSingle();

    if (error || !data) {
      throw new Error("LIQUIDITY_PAYMENT_UPSERT_FAILED");
    }

    return data;
  }

  function paymentDeveloperApproved(payment) {
    return Boolean(
      payment?.status?.developer_approved === true ||
      payment?.status?.developerApproved === true
    );
  }

  function paymentDeveloperCompleted(payment) {
    return Boolean(
      payment?.status?.developer_completed === true ||
      payment?.status?.developerCompleted === true
    );
  }

  function transactionVerified(payment) {
    return Boolean(
      payment?.status?.transaction_verified === true ||
      payment?.status?.transactionVerified === true ||
      payment?.transaction?.verified === true
    );
  }

  async function validateSessionAndPiIdentity(req) {
    const session = await getTestnetSession(req);
    const piUser = await getPiUser(bearer(req));

    /*
     * Do NOT compare piUser.uid with session.pi_uid.
     *
     * The Testnet gateway session is established by the ALBUKHR
     * Mainnet security handoff. Pi's UID is app-local and can differ
     * between separately registered Testnet/Mainnet apps.
     */

    return { session, piUser };
  }

  router.post("/approve", async (req, res) => {
    try {
      const { session, piUser } =
        await validateSessionAndPiIdentity(req);

      const paymentIdentifier =
        clean(req.body?.paymentId);

      if (!paymentIdentifier) {
        throw new Error("PAYMENT_ID_REQUIRED");
      }

      const payment = await getPayment(paymentIdentifier);

      validatePaymentBasics(payment);
      validatePaymentUser(payment, piUser);
      validatePaymentDestination(payment);

      const identity =
        resolveProjectIdentity(payment, req.body);

      validateMetadata(
        payment,
        identity.projectId,
        identity.projectCode
      );

      const project = await getApprovedProject(
        identity.projectId,
        identity.projectCode
      );

      const treasury = await getTreasury(project.id);
      const funding = await validateFunding(
        payment,
        project.id,
        treasury
      );

      const approved =
        paymentDeveloperApproved(payment)
          ? payment
          : await approvePayment(paymentIdentifier);

      const record = await upsertPaymentRecord({
        payment,
        project,
        treasury,
        piUser,
        session,
        piStatus: "approved",
      });

      return res.json({
        success: true,
        network: NETWORK,
        payment_id: paymentIdentifier,
        project_code: project.project_code,
        required_liquidity: funding.required,
        verified_liquidity: funding.verified,
        remaining_before_payment: funding.due,
        payment_amount: paymentAmount(payment),
        approval: approved,
        record,
      });
    } catch (error) {
      console.error(
        "[TESTNET LIQUIDITY APPROVE]",
        error?.message || error
      );
      return sendError(res, error);
    }
  });

  router.post("/complete", async (req, res) => {
    try {
      const { session, piUser } =
        await validateSessionAndPiIdentity(req);

      const paymentIdentifier =
        clean(req.body?.paymentId);
      const txid = clean(req.body?.txid);

      if (!paymentIdentifier || !txid) {
        throw new Error("PAYMENT_COMPLETION_FIELDS_REQUIRED");
      }

      const payment = await getPayment(paymentIdentifier);

      validatePaymentBasics(payment);
      validatePaymentUser(payment, piUser);
      validatePaymentDestination(payment);
      validateCompletionTxid(payment, txid);

      if (!paymentDeveloperApproved(payment)) {
        throw new Error("PI_PAYMENT_NOT_APPROVED");
      }

      const identity =
        resolveProjectIdentity(payment, req.body);

      validateMetadata(
        payment,
        identity.projectId,
        identity.projectCode
      );

      const project = await getApprovedProject(
        identity.projectId,
        identity.projectCode
      );

      const treasury = await getTreasury(project.id);

      const completed =
        paymentDeveloperCompleted(payment)
          ? payment
          : await completePayment(
              paymentIdentifier,
              txid
            );

      /*
       * Fetch again after completion so that the stored payment state
       * comes from Pi's post-completion PaymentDTO rather than from
       * client claims alone.
       */
      const completedPayment = paymentDeveloperCompleted(payment)
        ? payment
        : await getPayment(paymentIdentifier);

      const record = await upsertPaymentRecord({
        payment: completedPayment,
        project,
        treasury,
        piUser,
        session,
        piStatus: "completed",
        txid,
      });

      return res.json({
        success: true,
        network: NETWORK,
        payment_id: paymentIdentifier,
        txid,
        project_code: project.project_code,
        payment: completed,
        record,
        verification_status: record.verification_status,
        transaction_verified: transactionVerified(completedPayment),
      });
    } catch (error) {
      console.error(
        "[TESTNET LIQUIDITY COMPLETE]",
        error?.message || error
      );
      return sendError(res, error);
    }
  });

  router.post("/incomplete", async (req, res) => {
    try {
      const { session, piUser } =
        await validateSessionAndPiIdentity(req);

      const paymentIdentifier =
        clean(req.body?.paymentId || req.body?.identifier);

      if (!paymentIdentifier) {
        throw new Error("PAYMENT_ID_REQUIRED");
      }

      const payment = await getPayment(paymentIdentifier);

      validatePaymentBasics(payment);
      validatePaymentUser(payment, piUser);
      validatePaymentDestination(payment);

      const identity =
        resolveProjectIdentity(payment, req.body);

      validateMetadata(
        payment,
        identity.projectId,
        identity.projectCode
      );

      const project = await getApprovedProject(
        identity.projectId,
        identity.projectCode
      );

      const treasury = await getTreasury(project.id);

      const txid = clean(
        req.body?.txid ||
        req.body?.transaction?.txid ||
        payment?.transaction?.txid
      );

      if (!txid) {
        return res.status(409).json({
          success: false,
          network: NETWORK,
          error: transactionVerified(payment)
            ? "PI_PAYMENT_TXID_REQUIRED"
            : "PI_PAYMENT_TRANSACTION_NOT_VERIFIED",
          payment_id: paymentIdentifier,
        });
      }

      validateCompletionTxid(payment, txid);

      if (!paymentDeveloperApproved(payment)) {
        await approvePayment(paymentIdentifier);
      }

      const completed =
        paymentDeveloperCompleted(payment)
          ? payment
          : await completePayment(
              paymentIdentifier,
              txid
            );

      const completedPayment = paymentDeveloperCompleted(payment)
        ? payment
        : await getPayment(paymentIdentifier);

      const record = await upsertPaymentRecord({
        payment: completedPayment,
        project,
        treasury,
        piUser,
        session,
        piStatus: "completed",
        txid,
      });

      return res.json({
        success: true,
        network: NETWORK,
        recovered: true,
        payment_id: paymentIdentifier,
        txid,
        payment: completed,
        record,
      });
    } catch (error) {
      console.error(
        "[TESTNET LIQUIDITY INCOMPLETE]",
        error?.message || error
      );
      return sendError(res, error);
    }
  });

  return router;
}

module.exports = createTestnetLiquidityPaymentRouter;
