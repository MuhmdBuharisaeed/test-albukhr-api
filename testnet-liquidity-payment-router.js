/* ALBUKHR TESTNET LIQUIDITY PAYMENT ROUTER v1
 *
 * User-to-App Test-Pi liquidity payment flow.
 * Designed for the existing Express Testnet API.
 * No server secrets are exposed to the browser.
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
    return /^Bearer\\s+/i.test(value)
      ? value.replace(/^Bearer\\s+/i, "").trim()
      : "";
  }

  function piKeyHeaders(extra = {}) {
    return Object.assign(
      { Authorization: `Key ${piApiKey}`, Accept: "application/json" },
      extra
    );
  }

  function userAuthHeaders(token) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
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
      const uid = clean(response.data?.uid);
      const username = clean(response.data?.username);
      if (!uid || !username) throw new Error("PI_IDENTITY_INCOMPLETE");
      return { uid, username, token };
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      if (status === 401 || status === 403) {
        const authError = new Error("PI_TOKEN_INVALID");
        authError.status = 401;
        throw authError;
      }
      if (error?.message === "PI_IDENTITY_INCOMPLETE") throw error;
      const upstream = new Error("PI_API_UNREACHABLE");
      upstream.status = 502;
      upstream.cause = error;
      throw upstream;
    }
  }

  async function getPayment(paymentId) {
    const id = clean(paymentId);
    if (!id) throw new Error("PAYMENT_ID_REQUIRED");
    try {
      const response = await axios.get(
        `${base}/payments/${encodeURIComponent(id)}`,
        { headers: piKeyHeaders(), timeout: 15000 }
      );
      return response.data || null;
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      const e = new Error(status === 404 ? "PI_PAYMENT_NOT_FOUND" : "PI_PAYMENT_LOOKUP_FAILED");
      e.status = status === 404 ? 404 : 502;
      e.cause = error;
      throw e;
    }
  }

  async function approvePayment(paymentId) {
    try {
      const response = await axios.post(
        `${base}/payments/${encodeURIComponent(paymentId)}/approve`,
        {},
        { headers: piKeyHeaders({ "Content-Type": "application/json" }), timeout: 15000 }
      );
      return response.data || null;
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      const e = new Error("PI_APPROVE_FAILED");
      e.status = status >= 400 && status < 600 ? status : 502;
      e.cause = error;
      throw e;
    }
  }

  async function completePayment(paymentId, txid) {
    const id = clean(paymentId);
    const transactionId = clean(txid);
    if (!id || !transactionId) throw new Error("PAYMENT_COMPLETION_FIELDS_REQUIRED");
    try {
      const response = await axios.post(
        `${base}/payments/${encodeURIComponent(id)}/complete`,
        { txid: transactionId },
        { headers: piKeyHeaders({ "Content-Type": "application/json" }), timeout: 15000 }
      );
      return response.data || null;
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      const e = new Error("PI_COMPLETE_FAILED");
      e.status = status >= 400 && status < 600 ? status : 502;
      e.cause = error;
      throw e;
    }
  }

  async function getApprovedProject(projectId) {
    const id = clean(projectId);
    if (!id) throw new Error("PROJECT_ID_REQUIRED");

    const { data, error } = await supabase
      .from("projects")
      .select("id,project_code,slug,name,status,network")
      .eq("id", id)
      .eq("network", NETWORK)
      .eq("status", "approved")
      .maybeSingle();

    if (error) throw new Error("PROJECT_READ_FAILED");
    if (!data) throw new Error("PROJECT_NOT_APPROVED");
    return data;
  }

  async function getTreasury(projectId) {
    const { data, error } = await supabase
      .from("project_treasury")
      .select("id,project_id,network,treasury_wallet,required_liquidity,verified_liquidity,status")
      .eq("project_id", projectId)
      .eq("network", NETWORK)
      .maybeSingle();

    if (error) throw new Error("TREASURY_READ_FAILED");
    if (!data) throw new Error("TREASURY_NOT_CONFIGURED");
    if (String(data.status || "").toLowerCase() !== "active") throw new Error("TREASURY_NOT_ACTIVE");
    if (!clean(data.treasury_wallet)) throw new Error("TREASURY_WALLET_REQUIRED");
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

    if (error) throw new Error("LIQUIDITY_READ_FAILED");
    return (data || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
  }

  async function upsertPaymentRecord({
    payment,
    project,
    treasury,
    piUser,
    txid = null,
    piStatus = "pending",
  }) {
    const paymentId = clean(payment.identifier || payment.payment_id || payment.id);
    if (!paymentId) throw new Error("PAYMENT_ID_REQUIRED");

    const amount = Number(payment.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("PAYMENT_AMOUNT_INVALID");

    const metadata = payment.metadata && typeof payment.metadata === "object"
      ? payment.metadata
      : {};

    const existingQuery = await supabase
      .from("project_liquidity_payments")
      .select("id,payment_id,project_id,payer_pi_uid,amount,recipient_wallet,network,action,pi_status,verification_status,verified_at,verification_reference,metadata")
      .eq("payment_id", paymentId)
      .eq("network", NETWORK)
      .maybeSingle();

    if (existingQuery.error) throw new Error("LIQUIDITY_PAYMENT_READ_FAILED");

    const patch = {
      payment_id: paymentId,
      project_id: project.id,
      payer_pi_uid: piUser ? piUser.uid : clean(payment.user_uid),
      amount,
      recipient_wallet: treasury.treasury_wallet,
      network: NETWORK,
      action: ACTION,
      pi_status: piStatus,
      metadata: Object.assign({}, metadata, {
        network: NETWORK,
        action: ACTION,
        project_id: project.id,
        project_code: project.project_code,
        username: piUser ? piUser.username : undefined,
        txid: txid || undefined,
      }),
      updated_at: new Date().toISOString(),
    };

    const payload = Object.assign({ verification_status: "pending" }, patch);
    const { data, error } = await supabase
      .from("project_liquidity_payments")
      .upsert(payload, { onConflict: "payment_id" })
      .select("id,payment_id,project_id,payer_pi_uid,amount,recipient_wallet,network,action,pi_status,verification_status,verified_at,verification_reference,metadata")
      .maybeSingle();

    if (error || !data) throw new Error("LIQUIDITY_PAYMENT_UPSERT_FAILED");
    return data;
  }

  function amountFromPayment(payment) {
    const amount = Number(payment?.amount);
    return Number.isFinite(amount) ? amount : 0;
  }

  function validatePaymentIdentity(payment, piUser) {
    if (!payment) throw new Error("PI_PAYMENT_NOT_FOUND");
    if (clean(payment.network).toLowerCase() !== "pi testnet") {
      throw new Error("PI_PAYMENT_NETWORK_INVALID");
    }
    if (clean(payment.direction) && clean(payment.direction) !== "user_to_app") {
      throw new Error("PI_PAYMENT_DIRECTION_INVALID");
    }
    if (piUser && clean(payment.user_uid) && clean(payment.user_uid) !== clean(piUser.uid)) {
      throw new Error("PI_PAYMENT_USER_MISMATCH");
    }
    if (payment.metadata && typeof payment.metadata === "object") {
      if (clean(payment.metadata.network) && clean(payment.metadata.network).toLowerCase() !== NETWORK) {
        throw new Error("PI_PAYMENT_METADATA_NETWORK_INVALID");
      }
      if (clean(payment.metadata.action) && clean(payment.metadata.action) !== ACTION) {
        throw new Error("PI_PAYMENT_METADATA_ACTION_INVALID");
      }
    }
  }

  async function validateFunding(payment, projectId) {
    const project = await getApprovedProject(projectId);
    const treasury = await getTreasury(project.id);
    const verified = await verifiedLiquidity(project.id);
    const required = Math.max(MIN_LIQUIDITY, Number(treasury.required_liquidity || 0));
    const due = Math.max(0, required - verified);
    const amount = amountFromPayment(payment);

    if (due <= 0) throw new Error("PROJECT_LIQUIDITY_ALREADY_READY");
    if (amount < due) throw new Error("LIQUIDITY_AMOUNT_BELOW_REMAINING_REQUIREMENT");

    return { project, treasury, verified, required, due };
  }

  function sendError(res, error) {
    const code = clean(error?.message) || "LIQUIDITY_PAYMENT_ERROR";
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
      PAYMENT_COMPLETION_FIELDS_REQUIRED: 400,
      PI_PAYMENT_NOT_FOUND: 404,
      PI_PAYMENT_USER_MISMATCH: 403,
      PI_PAYMENT_NETWORK_INVALID: 400,
      PI_PAYMENT_DIRECTION_INVALID: 400,
      PI_PAYMENT_METADATA_NETWORK_INVALID: 400,
      PI_PAYMENT_METADATA_ACTION_INVALID: 400,
      PI_PAYMENT_TRANSACTION_NOT_VERIFIED: 409,
    };
    const status = Number(error?.status || statuses[code] || (String(code).startsWith("PI_") ? 502 : 400));
    return res.status(status).json({ success: false, network: NETWORK, error: code });
  }

  /*
   * Phase I: verify payer, verify project/amount, then approve with Pi.
   */
  router.post("/approve", async (req, res) => {
    try {
      const piUser = await getPiUser(bearer(req));
      const projectId = clean(req.body?.projectId);
      const paymentId = clean(req.body?.paymentId);
      if (!projectId || !paymentId) throw new Error("PAYMENT_ID_REQUIRED");

      const payment = await getPayment(paymentId);
      validatePaymentIdentity(payment, piUser);
      const funding = await validateFunding(payment, projectId);

      if (clean(payment.metadata?.project_id) && clean(payment.metadata.project_id) !== funding.project.id) {
        throw new Error("PI_PAYMENT_PROJECT_MISMATCH");
      }
      if (clean(payment.metadata?.project_code) && clean(payment.metadata.project_code) !== funding.project.project_code) {
        throw new Error("PI_PAYMENT_PROJECT_MISMATCH");
      }

      const approved = await approvePayment(paymentId);
      const record = await upsertPaymentRecord({
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
        project_code: funding.project.project_code,
        required_liquidity: funding.required,
        verified_liquidity: funding.verified,
        remaining_before_payment: funding.due,
        payment_amount: amountFromPayment(payment),
        approval: approved,
        record,
      });
    } catch (error) {
      console.error("[TESTNET LIQUIDITY APPROVE]", error?.message || error);
      return sendError(res, error);
    }
  });

  /*
   * Phase III: complete with the real txid, then record Pi completion.
   */
  router.post("/complete", async (req, res) => {
    try {
      const piUser = await getPiUser(bearer(req));
      const projectId = clean(req.body?.projectId);
      const paymentId = clean(req.body?.paymentId);
      const txid = clean(req.body?.txid);
      if (!projectId || !paymentId || !txid) throw new Error("PAYMENT_COMPLETION_FIELDS_REQUIRED");

      const payment = await getPayment(paymentId);
      validatePaymentIdentity(payment, piUser);
      const funding = await validateFunding(payment, projectId);

      if (clean(payment.metadata?.project_id) && clean(payment.metadata.project_id) !== funding.project.id) {
        throw new Error("PI_PAYMENT_PROJECT_MISMATCH");
      }

      const completed = await completePayment(paymentId, txid);
      const record = await upsertPaymentRecord({
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
        project_code: funding.project.project_code,
        payment: completed,
        record,
        verification_status: record.verification_status,
      });
    } catch (error) {
      console.error("[TESTNET LIQUIDITY COMPLETE]", error?.message || error);
      return sendError(res, error);
    }
  });

  /*
   * Incomplete-payment callback does not have the Pi user access token yet.
   * We authorize the payment itself with Pi's server-side PaymentDTO.
   */
  router.post("/incomplete", async (req, res) => {
    try {
      const paymentId = clean(req.body?.paymentId || req.body?.identifier);
      const txid = clean(req.body?.txid || req.body?.transaction?.txid);
      if (!paymentId) throw new Error("PAYMENT_ID_REQUIRED");

      const payment = await getPayment(paymentId);
      validatePaymentIdentity(payment, null);
      if (payment.status?.transaction_verified !== true && !payment.transaction?.verified) {
        throw new Error("PI_PAYMENT_TRANSACTION_NOT_VERIFIED");
      }

      const projectId = clean(payment.metadata?.project_id);
      if (!projectId) throw new Error("PI_PAYMENT_PROJECT_REQUIRED");
      const funding = await validateFunding(payment, projectId);

      if (!txid) {
        return res.json({
          success: true,
          network: NETWORK,
          incomplete: true,
          needs_transaction: true,
          payment_id: paymentId,
        });
      }

      const completed = payment.status?.developer_completed
        ? payment
        : await completePayment(paymentId, txid);

      const record = await upsertPaymentRecord({
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
      console.error("[TESTNET LIQUIDITY INCOMPLETE]", error?.message || error);
      return sendError(res, error);
    }
  });

  return router;
}

module.exports = createTestnetLiquidityPaymentRouter;

diff --git a/server.js b/server.js
index e3c72f0..PENDING 100644
--- a/server.js
+++ b/server.js
@@ -4,6 +4,7 @@ const axios = require("axios");
 const crypto = require("crypto");
 const { createClient } = require("@supabase/supabase-js");
 const StellarSdk = require("stellar-sdk");
+const createTestnetLiquidityPaymentRouter = require("./testnet-liquidity-payment-router");

 const app = express();
@@ -47,6 +48,14 @@ app.use(cors({

 app.use(express.json({ limit: "100kb" }));

+/*
+ * Testnet User-to-App liquidity funding.
+ * Kept under a dedicated namespace so the existing admin-only /approve and
+ * /complete withdrawal/payment endpoints are not replaced or collided with.
+ */
+app.use(
+  "/liquidity-payment",
+  createTestnetLiquidityPaymentRouter({
+    supabase,
+    axios,
+    piApiKey: PI_API_KEY
+  })
+);
+
 function clean(value) {
   return String(value == null ? "" : value).trim();
 }
diff --git a/testnet-liquidity-payment-router.js b/testnet-liquidity-payment-router.js
index 2131a44..PENDING 100644
--- a/testnet-liquidity-payment-router.js
+++ b/testnet-liquidity-payment-router.js
@@ -24,8 +24,8 @@ function createTestnetLiquidityPaymentRouter({

   function bearer(req) {
     const value = clean(req.get("authorization"));
-    return /^Bearer\\s+/i.test(value)
-      ? value.replace(/^Bearer\\s+/i, "").trim()
+    return /^Bearer\s+/i.test(value)
+      ? value.replace(/^Bearer\s+/i, "").trim()
       : "";
   }
@@ -185,6 +185,11 @@ function validatePaymentIdentity(payment, piUser) {
       }
     }
   }

-  async function validateFunding(payment, projectId) {
+  function validatePaymentDestination(payment, treasury) {
+    const destination = clean(payment?.to_address);
+    if (destination && destination !== clean(treasury?.treasury_wallet)) {
+      throw new Error("PI_PAYMENT_RECIPIENT_MISMATCH");
+    }
+  }
+
+  async function validateFunding(payment, projectId, { enforceRemaining = true } = {}) {
     const project = await getApprovedProject(projectId);
     const treasury = await getTreasury(project.id);
     const verified = await verifiedLiquidity(project.id);
@@ -193,8 +198,10 @@ function validateFunding(payment, projectId) {
     const due = Math.max(0, required - verified);
     const amount = amountFromPayment(payment);

-    if (due <= 0) throw new Error("PROJECT_LIQUIDITY_ALREADY_READY");
-    if (amount < due) throw new Error("LIQUIDITY_AMOUNT_BELOW_REMAINING_REQUIREMENT");
+    if (enforceRemaining) {
+      if (due <= 0) throw new Error("PROJECT_LIQUIDITY_ALREADY_READY");
+      if (amount < due) throw new Error("LIQUIDITY_AMOUNT_BELOW_REMAINING_REQUIREMENT");
+    }

     return { project, treasury, verified, required, due };
   }
@@ -215,6 +222,7 @@ function sendError(res, error) {
       PI_PAYMENT_DIRECTION_INVALID: 400,
       PI_PAYMENT_METADATA_NETWORK_INVALID: 400,
       PI_PAYMENT_METADATA_ACTION_INVALID: 400,
+      PI_PAYMENT_RECIPIENT_MISMATCH: 400,
       PI_PAYMENT_TRANSACTION_NOT_VERIFIED: 409,
     };
@@ -229,19 +237,31 @@ router.post("/approve", async (req, res) => {

       const payment = await getPayment(paymentId);
       validatePaymentIdentity(payment, piUser);
       const funding = await validateFunding(payment, projectId);
+      validatePaymentDestination(payment, funding.treasury);

       if (clean(payment.metadata?.project_id) && clean(payment.metadata.project_id) !== funding.project.id) {
         throw new Error("PI_PAYMENT_PROJECT_MISMATCH");
       }
       if (clean(payment.metadata?.project_code) && clean(payment.metadata.project_code) !== funding.project.project_code) {
         throw new Error("PI_PAYMENT_PROJECT_MISMATCH");
       }
+      if (payment.status?.cancelled || payment.status?.user_cancelled) {
+        throw new Error("PI_PAYMENT_CANCELLED");
+      }

-      const approved = await approvePayment(paymentId);
+      const approved = payment.status?.developer_approved
+        ? payment
+        : await approvePayment(paymentId);
       const record = await upsertPaymentRecord({
         payment,
         project: funding.project,
@@ -272,20 +292,31 @@ router.post("/complete", async (req, res) => {

       const payment = await getPayment(paymentId);
       validatePaymentIdentity(payment, piUser);
-      const funding = await validateFunding(payment, projectId);
+      const funding = await validateFunding(payment, projectId, {
+        enforceRemaining: false
+      });
+      validatePaymentDestination(payment, funding.treasury);

       if (clean(payment.metadata?.project_id) && clean(payment.metadata.project_id) !== funding.project.id) {
         throw new Error("PI_PAYMENT_PROJECT_MISMATCH");
       }

-      const completed = await completePayment(paymentId, txid);
+      const completed = payment.status?.developer_completed
+        ? payment
+        : await completePayment(paymentId, txid);
       const record = await upsertPaymentRecord({
         payment,
         project: funding.project,
@@ -313,7 +344,7 @@ router.post("/incomplete", async (req, res) => {
       const projectId = clean(payment.metadata?.project_id);
       if (!projectId) throw new Error("PI_PAYMENT_PROJECT_REQUIRED");
-      const funding = await validateFunding(payment, projectId);
+      const funding = await validateFunding(payment, projectId, {
+        enforceRemaining: false
+      });
+      validatePaymentDestination(payment, funding.treasury);

       if (!txid) {
         return res.json({
