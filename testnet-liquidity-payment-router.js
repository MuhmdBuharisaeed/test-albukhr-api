/* ALBUKHR TESTNET LIQUIDITY PAYMENT ROUTER
 *
 * User-to-App Test-Pi liquidity payment flow.
 * Designed for the existing Express Testnet API.
 *
 * Routes:
 *   POST /liquidity-payment/approve
 *   POST /liquidity-payment/complete
 *   POST /liquidity-payment/incomplete
 *
 * Security model:
 *   - Testnet only.
 *   - Pi access tokens are validated server-side through /v2/me.
 *   - Pi Platform API key is server-side only.
 *   - Project and treasury data are read from Supabase with network isolation.
 *   - Payment destination is checked against the project's Testnet treasury.
 *   - Completion txid is checked against the Pi PaymentDTO when available.
 *   - Approval and completion are idempotent.
 *   - Completion does not re-enforce the original funding threshold, so a
 *     previously valid payment is not blocked if the project threshold changes.
 */

const express = require("express");

function createTestnetLiquidityPaymentRouter({
  supabase,
  axios,
  piApiKey,
  piApiBase = "https://api.minepi.com/v2",
}) {
  if (!supabase) throw new Error("SUPABASE_CLIENT_REQUIRED");
  if (!axios) throw new Error("AXIOS_REQUIRED");
  if (!piApiKey) throw new Error("PI_API_KEY_REQUIRED");

  const router = express.Router();

  const NETWORK = "testnet";
  const ACTION = "add_liquidity";
  const MIN_LIQUIDITY = 100;
  const base = String(piApiBase).replace(/\/+$/, "");

  function clean(value) {
    return String(value == null ? "" : value).trim();
  }

  function bearer(req) {
    const value = clean(req.get("authorization"));

    return /^Bearer\s+/i.test(value)
      ? value.replace(/^Bearer\s+/i, "").trim()
      : "";
  }

  function piKeyHeaders(extra = {}) {
    return Object.assign(
      {
        Authorization: `Key ${piApiKey}`,
        Accept: "application/json",
      },
      extra
    );
  }

  function userAuthHeaders(token) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
  }

  function paymentIdentifier(payment) {
    return clean(
      payment?.identifier ||
      payment?.payment_id ||
      payment?.id
    );
  }

  function paymentMetadata(payment) {
    return payment?.metadata && typeof payment.metadata === "object"
      ? payment.metadata
      : {};
  }

  function paymentAmount(payment) {
    const amount = Number(payment?.amount);
    return Number.isFinite(amount) ? amount : 0;
  }

  async function getPiUser(accessToken) {
    const token = clean(accessToken);

    if (!token || token.length > 8192) {
      const error = new Error("PI_ACCESS_TOKEN_REQUIRED");
      error.status = 401;
      throw error;
    }

    try {
      const response = await axios.get(`${base}/me`, {
        headers: userAuthHeaders(token),
        timeout: 15000,
      });

      const body = response.data || {};
      const user =
        body.user && typeof body.user === "object"
          ? body.user
          : body;

      const uid = clean(user.uid);
      const username = clean(user.username);

      if (!uid || !username) {
        throw new Error("PI_IDENTITY_INCOMPLETE");
      }

      return {
        uid,
        username,
        token,
      };
    } catch (error) {
      const status = Number(error?.response?.status || 0);

      if (status === 401 || status === 403) {
        const authError = new Error("PI_TOKEN_INVALID");
        authError.status = 401;
        throw authError;
      }

      if (error?.message === "PI_IDENTITY_INCOMPLETE") {
        throw error;
      }

      const upstream = new Error("PI_API_UNREACHABLE");
      upstream.status = 502;
      upstream.cause = error;
      throw upstream;
    }
  }

  async function getPayment(paymentId) {
    const id = clean(paymentId);

    if (!id) {
      throw new Error("PAYMENT_ID_REQUIRED");
    }

    try {
      const response = await axios.get(
        `${base}/payments/${encodeURIComponent(id)}`,
        {
          headers: piKeyHeaders(),
          timeout: 15000,
        }
      );

      return response.data || null;
    } catch (error) {
      const status = Number(error?.response?.status || 0);

      const upstreamError = new Error(
        status === 404
          ? "PI_PAYMENT_NOT_FOUND"
          : "PI_PAYMENT_LOOKUP_FAILED"
      );

      upstreamError.status = status === 404 ? 404 : 502;
      upstreamError.cause = error;

      throw upstreamError;
    }
  }

  async function approvePayment(paymentId) {
    try {
      const response = await axios.post(
        `${base}/payments/${encodeURIComponent(paymentId)}/approve`,
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

      const upstreamError = new Error("PI_APPROVE_FAILED");
      upstreamError.status =
        status >= 400 && status < 600 ? status : 502;
      upstreamError.cause = error;

      throw upstreamError;
    }
  }

  async function completePayment(paymentId, txid) {
    const id = clean(paymentId);
    const transactionId = clean(txid);

    if (!id || !transactionId) {
      throw new Error("PAYMENT_COMPLETION_FIELDS_REQUIRED");
    }

    try {
      const response = await axios.post(
        `${base}/payments/${encodeURIComponent(id)}/complete`,
        { txid: transactionId },
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

      const upstreamError = new Error("PI_COMPLETE_FAILED");
      upstreamError.status =
        status >= 400 && status < 600 ? status : 502;
      upstreamError.cause = error;

      throw upstreamError;
    }
  }

  async function getApprovedProject(projectId) {
    const id = clean(projectId);

    if (!id) {
      throw new Error("PROJECT_ID_REQUIRED");
    }

    const { data, error } = await supabase
      .from("projects")
      .select(
        "id,project_code,slug,name,status,network"
      )
      .eq("id", id)
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

    if (
      String(data.status || "").toLowerCase() !==
      "active"
    ) {
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

  async function upsertPaymentRecord({
    payment,
    project,
    treasury,
    piUser,
    txid = null,
    piStatus = "pending",
  }) {
    const paymentId = paymentIdentifier(payment);

    if (!paymentId) {
      throw new Error("PAYMENT_ID_REQUIRED");
    }

    const amount = paymentAmount(payment);

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("PAYMENT_AMOUNT_INVALID");
    }

    const metadata = paymentMetadata(payment);

    const existingQuery = await supabase
      .from("project_liquidity_payments")
      .select(
        "id,payment_id,project_id,payer_pi_uid,amount,recipient_wallet,network,action,pi_status,verification_status,verified_at,verification_reference,metadata"
      )
      .eq("payment_id", paymentId)
      .eq("network", NETWORK)
      .maybeSingle();

    if (existingQuery.error) {
      throw new Error("LIQUIDITY_PAYMENT_READ_FAILED");
    }

    /*
     * Preserve an existing verified state.
     *
     * This prevents a later idempotent retry from downgrading a payment
     * that has already been verified by the backend/admin workflow.
     */
    const existing = existingQuery.data;

    const nextVerificationStatus =
      existing?.verification_status || "pending";

    const nextVerifiedAt =
      existing?.verified_at || null;

    const nextVerificationReference =
      existing?.verification_reference || null;

    const nextMetadata = Object.assign({}, metadata, {
      network: NETWORK,
      action: ACTION,
      project_id: project.id,
      project_code: project.project_code,
    });

    if (piUser?.username) {
      nextMetadata.username = piUser.username;
    }

    if (txid) {
      nextMetadata.txid = txid;
    }

    const payload = {
      payment_id: paymentId,
      project_id: project.id,
      payer_pi_uid:
        piUser?.uid || clean(payment.user_uid),
      amount,
      recipient_wallet: treasury.treasury_wallet,
      network: NETWORK,
      action: ACTION,
      pi_status: piStatus,
      verification_status: nextVerificationStatus,
      verified_at: nextVerifiedAt,
      verification_reference: nextVerificationReference,
      metadata: nextMetadata,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("project_liquidity_payments")
      .upsert(payload, {
        onConflict: "payment_id",
      })
      .select(
        "id,payment_id,project_id,payer_pi_uid,amount,recipient_wallet,network,action,pi_status,verification_status,verified_at,verification_reference,metadata"
      )
      .maybeSingle();

    if (error || !data) {
      throw new Error("LIQUIDITY_PAYMENT_UPSERT_FAILED");
    }

    return data;
  }

  function validatePaymentIdentity(payment, piUser) {
    if (!payment) {
      throw new Error("PI_PAYMENT_NOT_FOUND");
    }

    const networkValue = clean(payment.network).toLowerCase();

    if (
      networkValue &&
      networkValue !== "pi testnet" &&
      networkValue !== "testnet"
    ) {
      throw new Error("PI_PAYMENT_NETWORK_INVALID");
    }

    const direction = clean(payment.direction);

    if (
      direction &&
      direction !== "user_to_app"
    ) {
      throw new Error("PI_PAYMENT_DIRECTION_INVALID");
    }

    if (
      piUser &&
      clean(payment.user_uid) &&
      clean(payment.user_uid) !== clean(piUser.uid)
    ) {
      throw new Error("PI_PAYMENT_USER_MISMATCH");
    }

    const metadata = paymentMetadata(payment);

    if (
      clean(metadata.network) &&
      clean(metadata.network).toLowerCase() !== NETWORK
    ) {
      throw new Error(
        "PI_PAYMENT_METADATA_NETWORK_INVALID"
      );
    }

    if (
      clean(metadata.action) &&
      clean(metadata.action) !== ACTION
    ) {
      throw new Error(
        "PI_PAYMENT_METADATA_ACTION_INVALID"
      );
    }
  }

  function validatePaymentDestination(payment, treasury) {
    const destination = clean(payment?.to_address);
    const expected = clean(treasury?.treasury_wallet);

    if (
      destination &&
      expected &&
      destination !== expected
    ) {
      throw new Error(
        "PI_PAYMENT_RECIPIENT_MISMATCH"
      );
    }
  }

  function validateCompletionTxid(payment, txid) {
    const supplied = clean(txid);

    if (!supplied) {
      throw new Error(
        "PAYMENT_COMPLETION_FIELDS_REQUIRED"
      );
    }

    const expected = clean(
      payment?.transaction?.txid ||
      payment?.transaction?.tx_hash ||
      payment?.txid
    );

    /*
     * If Pi's PaymentDTO already exposes the transaction hash,
     * the client cannot substitute a different txid.
     */
    if (
      expected &&
      supplied &&
      expected !== supplied
    ) {
      throw new Error(
        "PI_PAYMENT_TXID_MISMATCH"
      );
    }
  }

  async function validateFunding(
    payment,
    projectId,
    { enforceRemaining = true } = {}
  ) {
    const project =
      await getApprovedProject(projectId);

    const treasury =
      await getTreasury(project.id);

    const verified =
      await verifiedLiquidity(project.id);

    const required = Math.max(
      MIN_LIQUIDITY,
      Number(treasury.required_liquidity || 0)
    );

    const due = Math.max(
      0,
      required - verified
    );

    const amount =
      paymentAmount(payment);

    if (enforceRemaining) {
      if (due <= 0) {
        throw new Error(
          "PROJECT_LIQUIDITY_ALREADY_READY"
        );
      }

      if (amount < due) {
        throw new Error(
          "LIQUIDITY_AMOUNT_BELOW_REMAINING_REQUIREMENT"
        );
      }
    }

    return {
      project,
      treasury,
      verified,
      required,
      due,
    };
  }

  function validateProjectMetadata(
    payment,
    project
  ) {
    const metadata =
      paymentMetadata(payment);

    if (
      clean(metadata.project_id) &&
      clean(metadata.project_id) !==
        clean(project.id)
    ) {
      throw new Error(
        "PI_PAYMENT_PROJECT_MISMATCH"
      );
    }

    if (
      clean(metadata.project_code) &&
      clean(metadata.project_code) !==
        clean(project.project_code)
    ) {
      throw new Error(
        "PI_PAYMENT_PROJECT_MISMATCH"
      );
    }
  }

  function paymentIsCancelled(payment) {
    return Boolean(
      payment?.status?.cancelled ||
      payment?.status?.user_cancelled ||
      payment?.status?.cancelled_by_user
    );
  }

  function paymentIsDeveloperApproved(payment) {
    return Boolean(
      payment?.status?.developer_approved === true ||
      payment?.status?.developerApproved === true
    );
  }

  function paymentIsDeveloperCompleted(payment) {
    return Boolean(
      payment?.status?.developer_completed === true ||
      payment?.status?.developerCompleted === true
    );
  }

  function transactionIsVerified(payment) {
    return Boolean(
      payment?.status?.transaction_verified === true ||
      payment?.status?.transactionVerified === true ||
      payment?.transaction?.verified === true
    );
  }

  function sendError(res, error) {
    const code =
      clean(error?.message) ||
      "LIQUIDITY_PAYMENT_ERROR";

    const statuses = {
      PI_ACCESS_TOKEN_REQUIRED: 401,
      PI_TOKEN_INVALID: 401,

      PROJECT_ID_REQUIRED: 400,
      PROJECT_NOT_APPROVED: 400,

      TREASURY_NOT_CONFIGURED: 400,
      TREASURY_NOT_ACTIVE: 400,
      TREASURY_WALLET_REQUIRED: 400,

      PROJECT_LIQUIDITY_ALREADY_READY: 409,
      LIQUIDITY_AMOUNT_BELOW_REMAINING_REQUIREMENT: 400,

      PAYMENT_ID_REQUIRED: 400,
      PAYMENT_AMOUNT_INVALID: 400,
      PAYMENT_COMPLETION_FIELDS_REQUIRED: 400,

      PI_PAYMENT_NOT_FOUND: 404,
      PI_PAYMENT_USER_MISMATCH: 403,

      PI_PAYMENT_NETWORK_INVALID: 400,
      PI_PAYMENT_DIRECTION_INVALID: 400,
      PI_PAYMENT_METADATA_NETWORK_INVALID: 400,
      PI_PAYMENT_METADATA_ACTION_INVALID: 400,

      PI_PAYMENT_PROJECT_REQUIRED: 400,
      PI_PAYMENT_PROJECT_MISMATCH: 400,
      PI_PAYMENT_RECIPIENT_MISMATCH: 400,
      PI_PAYMENT_TXID_MISMATCH: 400,
      PI_PAYMENT_CANCELLED: 409,
      PI_PAYMENT_TRANSACTION_NOT_VERIFIED: 409,
    };

    const status = Number(
      error?.status ||
      statuses[code] ||
      (
        String(code).startsWith("PI_")
          ? 502
          : 400
      )
    );

    return res
      .status(status)
      .json({
        success: false,
        network: NETWORK,
        error: code,
      });
  }

  /*
   * PHASE I
   *
   * Validate the authenticated Pi user, the PaymentDTO, the approved
   * Testnet project, the Testnet treasury and the funding requirement,
   * then approve the Pi payment.
   *
   * Approval is idempotent: if Pi already reports developer_approved,
   * the router does not submit another approval request.
   */
  router.post("/approve", async (req, res) => {
    try {
      const piUser =
        await getPiUser(bearer(req));

      const projectId =
        clean(req.body?.projectId);

      const paymentId =
        clean(req.body?.paymentId);

      if (!projectId || !paymentId) {
        throw new Error("PAYMENT_ID_REQUIRED");
      }

      const payment =
        await getPayment(paymentId);

      validatePaymentIdentity(
        payment,
        piUser
      );

      if (paymentIsCancelled(payment)) {
        throw new Error(
          "PI_PAYMENT_CANCELLED"
        );
      }

      const funding =
        await validateFunding(
          payment,
          projectId
        );

      validatePaymentDestination(
        payment,
        funding.treasury
      );

      validateProjectMetadata(
        payment,
        funding.project
      );

      const approved =
        paymentIsDeveloperApproved(payment)
          ? payment
          : await approvePayment(paymentId);

      const record =
        await upsertPaymentRecord({
          payment,
          project: funding.project,
          treasury: funding.treasury,
          piUser,
          piStatus: "approved",
        });

      return res.json({
        success: true,
        network: NETWORK,
        payment_id: paymentId,
        project_code:
          funding.project.project_code,
        required_liquidity:
          funding.required,
        verified_liquidity:
          funding.verified,
        remaining_before_payment:
          funding.due,
        payment_amount:
          paymentAmount(payment),
        approval: approved,
        record,
      });
    } catch (error) {
      console.error(
        "[TESTNET LIQUIDITY APPROVE]",
        error?.message || error
      );

      return sendError(
        res,
        error
      );
    }
  });

  /*
   * PHASE III
   *
   * Complete the payment using the real txid.
   *
   * IMPORTANT:
   * We intentionally do NOT re-enforce the remaining funding threshold
   * here. The payment was already validated at approval time. A later
   * change in the project's required_liquidity must not block completion
   * of an already approved payment.
   *
   * Completion is idempotent: if Pi already reports
   * developer_completed, no second completion request is submitted.
   */
  router.post("/complete", async (req, res) => {
    try {
      const piUser =
        await getPiUser(bearer(req));

      const projectId =
        clean(req.body?.projectId);

      const paymentId =
        clean(req.body?.paymentId);

      const txid =
        clean(req.body?.txid);

      if (
        !projectId ||
        !paymentId ||
        !txid
      ) {
        throw new Error(
          "PAYMENT_COMPLETION_FIELDS_REQUIRED"
        );
      }

      const payment =
        await getPayment(paymentId);

      validatePaymentIdentity(
        payment,
        piUser
      );

      if (paymentIsCancelled(payment)) {
        throw new Error(
          "PI_PAYMENT_CANCELLED"
        );
      }

      const funding =
        await validateFunding(
          payment,
          projectId,
          {
            enforceRemaining: false,
          }
        );

      validatePaymentDestination(
        payment,
        funding.treasury
      );

      validateProjectMetadata(
        payment,
        funding.project
      );

      validateCompletionTxid(
        payment,
        txid
      );

      const completed =
        paymentIsDeveloperCompleted(payment)
          ? payment
          : await completePayment(
              paymentId,
              txid
            );

      const record =
        await upsertPaymentRecord({
          payment,
          project: funding.project,
          treasury: funding.treasury,
          piUser,
          txid,
          piStatus: "completed",
        });

      return res.json({
        success: true,
        network: NETWORK,
        payment_id: paymentId,
        txid,
        project_code:
          funding.project.project_code,
        payment: completed,
        record,
        verification_status:
          record.verification_status,
      });
    } catch (error) {
      console.error(
        "[TESTNET LIQUIDITY COMPLETE]",
        error?.message || error
      );

      return sendError(
        res,
        error
      );
    }
  });

  /*
   * INCOMPLETE PAYMENT RECOVERY
   *
   * This callback may not have a browser Pi access token, so the
   * PaymentDTO returned by Pi is the identity/source for recovery.
   *
   * The project_id must be present in the payment metadata.
   */
  router.post("/incomplete", async (req, res) => {
    try {
      const paymentId =
        clean(
          req.body?.paymentId ||
          req.body?.identifier
        );

      const txid =
        clean(
          req.body?.txid ||
          req.body?.transaction?.txid
        );

      if (!paymentId) {
        throw new Error(
          "PAYMENT_ID_REQUIRED"
        );
      }

      const payment =
        await getPayment(paymentId);

      validatePaymentIdentity(
        payment,
        null
      );

      if (paymentIsCancelled(payment)) {
        throw new Error(
          "PI_PAYMENT_CANCELLED"
        );
      }

      const projectId =
        clean(
          paymentMetadata(payment).project_id
        );

      if (!projectId) {
        throw new Error(
          "PI_PAYMENT_PROJECT_REQUIRED"
        );
      }

      const funding =
        await validateFunding(
          payment,
          projectId,
          {
            enforceRemaining: false,
          }
        );

      validatePaymentDestination(
        payment,
        funding.treasury
      );

      validateProjectMetadata(
        payment,
        funding.project
      );

      if (txid) {
        validateCompletionTxid(
          payment,
          txid
        );
      }

      /*
       * If Pi has not yet exposed a transaction hash, do not invent one.
       * Return a recovery state so the caller can retry with the real txid.
       */
      if (!txid) {
        if (!transactionIsVerified(payment)) {
          throw new Error(
            "PI_PAYMENT_TRANSACTION_NOT_VERIFIED"
          );
        }

        return res.json({
          success: true,
          network: NETWORK,
          incomplete: true,
          needs_transaction: true,
          payment_id: paymentId,
        });
      }

      const completed =
        paymentIsDeveloperCompleted(payment)
          ? payment
          : await completePayment(
              paymentId,
              txid
            );

      const record =
        await upsertPaymentRecord({
          payment,
          project: funding.project,
          treasury: funding.treasury,
          piUser: null,
          txid,
          piStatus: "completed",
        });

      return res.json({
        success: true,
        network: NETWORK,
        payment_id: paymentId,
        txid,
        recovered: true,
        payment: completed,
        record,
      });
    } catch (error) {
      console.error(
        "[TESTNET LIQUIDITY INCOMPLETE]",
        error?.message || error
      );

      return sendError(
        res,
        error
      );
    }
  });

  return router;
}

module.exports =
  createTestnetLiquidityPaymentRouter;
