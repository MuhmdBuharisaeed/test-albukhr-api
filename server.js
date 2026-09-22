const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const StellarSdk = require("stellar-sdk");

const app = express();

const PORT = Number(process.env.PORT || 8080);
const TESTNET_ORIGIN = process.env.TESTNET_ORIGIN || "https://test.albukhr.com";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PI_API_KEY = process.env.PI_API_KEY;
const WALLET_PRIVATE_SEED = process.env.WALLET_PRIVATE_SEED;
const TESTNET_ADMIN_API_KEY = process.env.TESTNET_ADMIN_API_KEY;
const TESTNET_WITHDRAWAL_RECONCILE_LIMIT = Math.min(
  200,
  Math.max(20, Number(process.env.TESTNET_WITHDRAWAL_RECONCILE_LIMIT || 100))
);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const server = new StellarSdk.Horizon.Server(
  process.env.PI_HORIZON_URL || "https://api.testnet.minepi.com"
);

app.disable("x-powered-by");

app.use(cors({
  origin(origin, callback) {
    if (!origin || origin === TESTNET_ORIGIN) return callback(null, true);
    return callback(new Error("CORS_ORIGIN_NOT_ALLOWED"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "X-Admin-Key"],
  credentials: false
}));

app.use(express.json({ limit: "100kb" }));

function clean(value) {
  return String(value == null ? "" : value).trim();
}

function jsonError(res, status, code, message) {
  return res.status(status).json({ success: false, error: code, message });
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function bearer(req) {
  const value = clean(req.get("authorization"));
  return /^Bearer\s+/i.test(value)
    ? value.replace(/^Bearer\s+/i, "").trim()
    : "";
}

function requireAdmin(req, res, next) {
  const supplied = clean(req.get("x-admin-key"));
  if (!TESTNET_ADMIN_API_KEY || !supplied || supplied !== TESTNET_ADMIN_API_KEY) {
    return jsonError(
      res,
      401,
      "ADMIN_AUTH_REQUIRED",
      "Administrator authorization is required."
    );
  }
  return next();
}

async function getTestnetSession(req) {
  const token = bearer(req);
  if (!token) return { error: "UNAUTHENTICATED" };

  const sessionHash = sha256Hex(token);
  const { data, error } = await supabase
    .from("testnet_sessions")
    .select("pi_uid,username,wallet_address,network,expires_at,revoked_at")
    .eq("session_hash", sessionHash)
    .eq("network", "testnet")
    .maybeSingle();

  if (error) {
    console.error("[AUTH] session lookup failed:", error.message);
    return { error: "SESSION_LOOKUP_FAILED" };
  }
  if (!data) return { error: "SESSION_INVALID" };
  if (data.revoked_at) return { error: "SESSION_REVOKED" };
  if (!data.expires_at || new Date(data.expires_at).getTime() <= Date.now()) {
    return { error: "SESSION_EXPIRED" };
  }

  return { session: data };
}

async function requireSession(req, res, next) {
  const result = await getTestnetSession(req);
  if (!result.session) {
    return jsonError(
      res,
      401,
      result.error || "UNAUTHENTICATED",
      "A valid Testnet session is required."
    );
  }
  req.testnetSession = result.session;
  next();
}

function assertPiConfig() {
  if (!PI_API_KEY) throw new Error("PI_API_KEY is not configured.");
}

function piHeaders() {
  assertPiConfig();
  return { Authorization: `Key ${PI_API_KEY}` };
}

function piApiError(error) {
  return error?.response?.data || error?.message || "Pi API request failed.";
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/*
 * A withdrawal ID maps to one deterministic 28-byte Stellar text memo.
 * This lets reconciliation detect a payout that reached the Pi Testnet
 * even when the database update was interrupted afterwards.
 */
function withdrawalMemo(requestId) {
  return "ALB-" + sha256Hex(requestId).slice(0, 24);
}

function payoutWalletKeypair() {
  if (!WALLET_PRIVATE_SEED) throw new Error("WALLET_NOT_CONFIGURED");
  return StellarSdk.Keypair.fromSecret(WALLET_PRIVATE_SEED);
}

async function getWithdrawal(requestId) {
  const { data, error } = await supabase
    .from("withdrawal_requests")
    .select("*")
    .eq("id", requestId)
    .eq("network", "testnet")
    .maybeSingle();

  if (error) throw new Error(`WITHDRAW_READ_FAILED:${error.message}`);
  return data || null;
}

async function findTestnetPayoutByMemo(sourcePublicKey, memoText) {
  const page = await server
    .transactions()
    .forAccount(sourcePublicKey)
    .order("desc")
    .limit(TESTNET_WITHDRAWAL_RECONCILE_LIMIT)
    .call();

  for (const tx of page.records || []) {
    if (clean(tx.memo) !== memoText) continue;
    if (tx.memo_type !== "text") continue;
    return tx;
  }

  return null;
}

async function markWithdrawalCompleted(requestId, txid) {
  const processedAt = new Date().toISOString();

  const update = await supabase
    .from("withdrawal_requests")
    .update({
      status: "completed",
      txid,
      reviewed_at: processedAt
    })
    .eq("id", requestId)
    .eq("network", "testnet")
    .in("status", ["processing", "approved"])
    .select("id,status,txid,requested_amount,fee_amount,net_amount,wallet_address")
    .maybeSingle();

  if (update.error) {
    throw new Error(`PAYOUT_RECORDED_FAILED:${update.error.message}`);
  }

  return update.data;
}

async function submitTestnetWithdrawalPayout(requestRow) {
  if (!requestRow) throw new Error("REQUEST_NOT_FOUND");
  if (!clean(requestRow.wallet_address)) throw new Error("MISSING_WALLET");

  const amount = numeric(
    requestRow.net_amount ?? requestRow.requested_amount
  );
  if (amount === null || amount <= 0) throw new Error("INVALID_AMOUNT");

  const sourceKeypair = payoutWalletKeypair();
  const sourcePublicKey = sourceKeypair.publicKey();
  const memoText = withdrawalMemo(requestRow.id);

  const existing = await findTestnetPayoutByMemo(
    sourcePublicKey,
    memoText
  );

  if (existing) {
    return {
      txid: existing.hash,
      reconciled: true,
      memo: memoText
    };
  }

  const sourceAccount = await server.loadAccount(sourcePublicKey);
  const baseFee = await server.fetchBaseFee();

  const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: baseFee.toString(),
    networkPassphrase: "Pi Testnet"
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: requestRow.wallet_address,
        asset: StellarSdk.Asset.native(),
        amount: amount.toFixed(7)
      })
    )
    .addMemo(StellarSdk.Memo.text(memoText))
    .setTimeout(180)
    .build();

  transaction.sign(sourceKeypair);

  const result = await server.submitTransaction(transaction);

  return {
    txid: result.hash,
    reconciled: false,
    memo: memoText
  };
}

async function createAndClaimWithdrawal({
  piUid,
  stakeId,
  withdrawalType,
  requestedAmount,
  walletAddress
}) {
  const create = await supabase.rpc("create_testnet_withdrawal", {
    p_pi_uid: piUid,
    p_stake_id: stakeId,
    p_withdrawal_type: withdrawalType,
    p_requested_amount: requestedAmount,
    p_wallet_address: walletAddress
  });

  if (create.error) {
    console.error("[WITHDRAW CREATE]", create.error.message);
    throw new Error(`WITHDRAW_CREATE_FAILED:${create.error.message}`);
  }

  const created = Array.isArray(create.data) ? create.data[0] : create.data;

  if (!created?.id) {
    throw new Error(
      "WITHDRAW_CREATE_FAILED:No withdrawal request was returned."
    );
  }

  const claim = await supabase.rpc("claim_testnet_withdrawal", {
    p_request_id: created.id,
    p_pi_uid: piUid
  });

  if (claim.error) {
    console.error("[WITHDRAW CLAIM]", claim.error.message);
    return {
      request: created,
      claimed: false,
      claimError: claim.error.message
    };
  }

  const claimed = Array.isArray(claim.data) ? claim.data[0] : claim.data;

  return {
    request: claimed || created,
    claimed: true
  };
}

/* Testnet-only health. */
app.get("/", (req, res) => {
  res.status(200).json({
    status: "OK",
    service: "ALBUKHR TESTNET API",
    network: "testnet"
  });
});

/* Protected Testnet investor data. */
app.get("/investor-data", requireSession, async (req, res) => {
  try {
    const uid = req.testnetSession.pi_uid;

    const [stakesQ, withdrawalsQ] = await Promise.all([
      supabase
        .from("stakes")
        .select(
          "id,project_id,project_code,amount,duration_days,reward_rate,reward_amount,status,start_at,unlock_at,created_at"
        )
        .eq("network", "testnet")
        .eq("pi_uid", uid)
        .order("created_at", { ascending: false }),

      supabase
        .from("withdrawal_requests")
        .select(
          "id,stake_id,project_id,project_code,withdrawal_type,requested_amount,fee_rate,fee_amount,net_amount,status,txid,created_at,reviewed_at"
        )
        .eq("network", "testnet")
        .eq("pi_uid", uid)
        .order("created_at", { ascending: false })
    ]);

    if (stakesQ.error) {
      console.error("[INVESTOR] stakes:", stakesQ.error.message);
      return jsonError(
        res,
        500,
        "STAKES_READ_FAILED",
        "Unable to load Testnet stakes."
      );
    }

    if (withdrawalsQ.error) {
      console.error("[INVESTOR] withdrawals:", withdrawalsQ.error.message);
      return jsonError(
        res,
        500,
        "WITHDRAWALS_READ_FAILED",
        "Unable to load Testnet withdrawals."
      );
    }

    const stakes = stakesQ.data || [];
    const withdrawals = withdrawalsQ.data || [];

    const invested = stakes.reduce(
      (sum, row) => sum + Number(row.amount || 0),
      0
    );
    const earnings = stakes.reduce(
      (sum, row) => sum + Number(row.reward_amount || 0),
      0
    );
    const active = stakes.filter((row) => row.status === "active");

    const projectCodes = [
      ...new Set(
        stakes.map((row) => clean(row.project_code)).filter(Boolean)
      )
    ];

    let projects = [];

    if (projectCodes.length) {
      const projectsQ = await supabase
        .from("projects")
        .select(
          "id,project_code,slug,name,project_type,status,description,core_slot,network,logo_url"
        )
        .eq("network", "testnet")
        .in("project_code", projectCodes);

      if (projectsQ.error) {
        console.error("[INVESTOR] projects:", projectsQ.error.message);
        return jsonError(
          res,
          500,
          "PROJECT_READ_FAILED",
          "Unable to load Testnet project metadata."
        );
      }

      projects = projectsQ.data || [];
    }

    return res.json({
      success: true,
      ok: true,
      network: "testnet",
      user: {
        pi_uid: uid,
        username: req.testnetSession.username || null,
        wallet_address: req.testnetSession.wallet_address || null
      },
      summary: {
        portfolio: invested + earnings,
        invested,
        earnings,
        active_projects: new Set(
          active.map((row) => clean(row.project_code)).filter(Boolean)
        ).size,
        stake_count: stakes.length
      },
      stakes,
      withdrawals,
      projects
    });
  } catch (error) {
    console.error("[INVESTOR]", error);
    return jsonError(
      res,
      500,
      "INVESTOR_DATA_ERROR",
      "Unable to load Testnet investor data."
    );
  }
});

/*
 * Pi payment approval/completion remain admin-only because the Pi API key
 * remains server-side.
 */
app.post("/approve", requireAdmin, async (req, res) => {
  try {
    const paymentId = clean(req.body?.paymentId);

    if (!paymentId) {
      return jsonError(
        res,
        400,
        "MISSING_PAYMENT_ID",
        "paymentId is required."
      );
    }

    const response = await axios.post(
      `https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}/approve`,
      {},
      { headers: piHeaders(), timeout: 15000 }
    );

    return res.json({ success: true, data: response.data });
  } catch (error) {
    console.error("[PI APPROVE]", piApiError(error));
    return jsonError(
      res,
      502,
      "PI_APPROVE_FAILED",
      "Pi payment approval failed."
    );
  }
});

app.post("/complete", requireAdmin, async (req, res) => {
  try {
    const paymentId = clean(req.body?.paymentId);
    const txid = clean(req.body?.txid);

    if (!paymentId || !txid) {
      return jsonError(
        res,
        400,
        "MISSING_PAYMENT_FIELDS",
        "paymentId and txid are required."
      );
    }

    const response = await axios.post(
      `https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}/complete`,
      { txid },
      { headers: piHeaders(), timeout: 15000 }
    );

    return res.json({ success: true, data: response.data });
  } catch (error) {
    console.error("[PI COMPLETE]", piApiError(error));
    return jsonError(
      res,
      502,
      "PI_COMPLETE_FAILED",
      "Pi payment completion failed."
    );
  }
});

/*
 * USER TESTNET WITHDRAWAL
 *
 * The database RPC is authoritative for:
 * - minimum 0.50 Pi
 * - 1% fee with 0.01 Pi minimum
 * - reward/capital availability
 * - unlock_at
 * - available balance and duplicate withdrawal accounting
 */
app.post("/withdraw", requireSession, async (req, res) => {
  try {
    const piUid = clean(req.testnetSession.pi_uid);
    const stakeId = clean(req.body?.stakeId);
    const withdrawalType = clean(req.body?.withdrawalType).toLowerCase();
    const walletAddress = clean(
      req.body?.walletAddress || req.testnetSession.wallet_address
    );
    const requestedAmount = numeric(req.body?.requestedAmount);

    if (
      !stakeId ||
      !["reward", "capital"].includes(withdrawalType)
    ) {
      return jsonError(
        res,
        400,
        "INVALID_WITHDRAWAL_REQUEST",
        "stakeId and withdrawalType (reward or capital) are required."
      );
    }

    if (requestedAmount === null || requestedAmount < 0.5) {
      return jsonError(
        res,
        400,
        "MINIMUM_WITHDRAWAL",
        "Minimum Testnet wallet receive amount is 0.50 Pi."
      );
    }

    if (!walletAddress) {
      return jsonError(
        res,
        400,
        "MISSING_WALLET",
        "A Testnet wallet address is required."
      );
    }

    const created = await createAndClaimWithdrawal({
      piUid,
      stakeId,
      withdrawalType,
      requestedAmount,
      walletAddress
    });

    if (!created.claimed) {
      return jsonError(
        res,
        409,
        "WITHDRAWAL_CLAIM_FAILED",
        "The withdrawal request was created but could not be claimed for payout. Reconciliation is required before retrying."
      );
    }

    const payout = await submitTestnetWithdrawalPayout(created.request);

    let completed;

    try {
      completed = await markWithdrawalCompleted(
        created.request.id,
        payout.txid
      );
    } catch (recordError) {
      console.error("[WITHDRAW] payout succeeded but DB update failed:", recordError);
      return res.status(502).json({
        success: false,
        error: "PAYOUT_RECORDED_FAILED",
        message:
          "The Testnet payout was submitted, but its database status could not be recorded. Reconciliation is required.",
        network: "testnet",
        txid: payout.txid,
        request_id: created.request.id
      });
    }

    return res.json({
      success: true,
      network: "testnet",
      payout: "completed",
      reconciled: !!payout.reconciled,
      txid: payout.txid,
      request: completed || created.request
    });
  } catch (error) {
    const message = clean(error?.message);

    console.error("[WITHDRAW]", error?.stack || error);

    if (message.startsWith("WITHDRAW_CREATE_FAILED:")) {
      return jsonError(
        res,
        400,
        "WITHDRAWAL_REJECTED",
        message.slice("WITHDRAW_CREATE_FAILED:".length)
      );
    }

    if (message === "WALLET_NOT_CONFIGURED") {
      return jsonError(
        res,
        503,
        "WALLET_NOT_CONFIGURED",
        "Testnet payout wallet is not configured."
      );
    }

    if (message === "MISSING_WALLET") {
      return jsonError(
        res,
        400,
        "MISSING_WALLET",
        "A Testnet wallet address is required."
      );
    }

    if (message === "INVALID_AMOUNT") {
      return jsonError(
        res,
        400,
        "INVALID_AMOUNT",
        "Withdrawal amount is invalid."
      );
    }

    return jsonError(
      res,
      502,
      "TESTNET_WITHDRAWAL_FAILED",
      "Testnet withdrawal payout failed. The request may remain in processing and can be reconciled safely."
    );
  }
});

/* Admin lookup. */
app.post("/withdraw/lookup", requireAdmin, async (req, res) => {
  try {
    const requestId = clean(req.body?.requestId);

    if (!requestId) {
      return jsonError(
        res,
        400,
        "MISSING_REQUEST_ID",
        "requestId is required."
      );
    }

    const data = await getWithdrawal(requestId);

    if (!data) {
      return jsonError(
        res,
        404,
        "REQUEST_NOT_FOUND",
        "Withdrawal request not found."
      );
    }

    return res.json({
      success: true,
      network: "testnet",
      request: data
    });
  } catch (error) {
    console.error("[WITHDRAW LOOKUP]", error);
    return jsonError(
      res,
      500,
      "WITHDRAW_LOOKUP_FAILED",
      "Unable to load the withdrawal request."
    );
  }
});

/*
 * Admin/manual payout endpoint.
 * Supports approved or processing rows and always checks the deterministic
 * memo before creating a new payment.
 */
app.post("/pay-withdraw", requireAdmin, async (req, res) => {
  try {
    const requestId = clean(req.body?.requestId);

    if (!requestId) {
      return jsonError(
        res,
        400,
        "MISSING_REQUEST_ID",
        "requestId is required."
      );
    }

    const requestRow = await getWithdrawal(requestId);

    if (!requestRow) {
      return jsonError(
        res,
        404,
        "REQUEST_NOT_FOUND",
        "Withdrawal request not found."
      );
    }

    if (requestRow.status === "completed") {
      return res.json({
        success: true,
        network: "testnet",
        payout: "already_completed",
        txid: requestRow.txid,
        request: requestRow
      });
    }

    if (!["approved", "processing"].includes(requestRow.status)) {
      return jsonError(
        res,
        400,
        "REQUEST_NOT_PAYABLE",
        "Withdrawal request must be approved or processing."
      );
    }

    const payout = await submitTestnetWithdrawalPayout(requestRow);

    try {
      const completed = await markWithdrawalCompleted(
        requestId,
        payout.txid
      );

      return res.json({
        success: true,
        network: "testnet",
        payout: "completed",
        reconciled: !!payout.reconciled,
        txid: payout.txid,
        request: completed || requestRow
      });
    } catch (recordError) {
      console.error("[PAY WITHDRAW] DB update:", recordError);
      return res.status(502).json({
        success: false,
        error: "PAYOUT_RECORDED_FAILED",
        txid: payout.txid,
        request_id: requestId
      });
    }
  } catch (error) {
    console.error("[PAY WITHDRAW]", error?.stack || error);

    return jsonError(
      res,
      502,
      "TESTNET_PAYOUT_FAILED",
      "Testnet withdrawal payout failed or could not be reconciled safely."
    );
  }
});

/*
 * Admin reconciliation:
 * if the payout reached Pi Testnet but the DB stayed in processing/approved,
 * the memo identifies the already-submitted transaction.
 */
app.post("/reconcile-withdraw", requireAdmin, async (req, res) => {
  try {
    const requestId = clean(req.body?.requestId);

    if (!requestId) {
      return jsonError(
        res,
        400,
        "MISSING_REQUEST_ID",
        "requestId is required."
      );
    }

    const requestRow = await getWithdrawal(requestId);

    if (!requestRow) {
      return jsonError(
        res,
        404,
        "REQUEST_NOT_FOUND",
        "Withdrawal request not found."
      );
    }

    if (requestRow.status === "completed") {
      return res.json({
        success: true,
        network: "testnet",
        reconciled: true,
        payoutFound: true,
        txid: requestRow.txid,
        request: requestRow
      });
    }

    if (!["processing", "approved"].includes(requestRow.status)) {
      return jsonError(
        res,
        400,
        "REQUEST_NOT_RECONCILABLE",
        "Withdrawal request is not processing or approved."
      );
    }

    const sourceKeypair = payoutWalletKeypair();
    const memoText = withdrawalMemo(requestId);

    const existing = await findTestnetPayoutByMemo(
      sourceKeypair.publicKey(),
      memoText
    );

    if (!existing) {
      return res.json({
        success: true,
        network: "testnet",
        reconciled: false,
        payoutFound: false,
        memo: memoText,
        request: requestRow
      });
    }

    const completed = await markWithdrawalCompleted(
      requestId,
      existing.hash
    );

    return res.json({
      success: true,
      network: "testnet",
      reconciled: true,
      payoutFound: true,
      txid: existing.hash,
      request: completed || requestRow
    });
  } catch (error) {
    console.error("[RECONCILE WITHDRAW]", error?.stack || error);

    return jsonError(
      res,
      502,
      "WITHDRAW_RECONCILIATION_FAILED",
      "Unable to reconcile the Testnet withdrawal safely."
    );
  }
});

/* Operational diagnostics remain admin-only. */
app.get("/test-supabase", requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("projects")
      .select("id,project_code,name,network,status")
      .eq("network", "testnet")
      .limit(1);

    if (error) {
      return jsonError(res, 500, "SUPABASE_TEST_FAILED", error.message);
    }

    return res.json({
      success: true,
      network: "testnet",
      rows: data || []
    });
  } catch (error) {
    return jsonError(res, 500, "SUPABASE_TEST_FAILED", error.message);
  }
});

app.get("/test-stellar", requireAdmin, async (req, res) => {
  try {
    const publicKey = clean(process.env.TESTNET_WALLET_PUBLIC_KEY);

    if (!publicKey) {
      return jsonError(
        res,
        500,
        "WALLET_PUBLIC_KEY_NOT_CONFIGURED",
        "TESTNET_WALLET_PUBLIC_KEY is required."
      );
    }

    const account = await server.loadAccount(publicKey);

    return res.json({
      success: true,
      network: "testnet",
      publicKey,
      sequence: account.sequence
    });
  } catch (error) {
    return jsonError(res, 502, "STELLAR_TEST_FAILED", error.message);
  }
});

app.get("/test-wallet", requireAdmin, (req, res) => {
  try {
    const keypair = payoutWalletKeypair();

    return res.json({
      success: true,
      network: "testnet",
      publicKey: keypair.publicKey()
    });
  } catch (error) {
    return jsonError(
      res,
      500,
      "WALLET_TEST_FAILED",
      "Testnet payout wallet is not configured or is invalid."
    );
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "NOT_FOUND"
  });
});

app.use((error, req, res, next) => {
  console.error("[API]", error);

  if (error?.message === "CORS_ORIGIN_NOT_ALLOWED") {
    return jsonError(
      res,
      403,
      "CORS_ORIGIN_NOT_ALLOWED",
      "Origin is not allowed."
    );
  }

  return jsonError(
    res,
    500,
    "INTERNAL_SERVER_ERROR",
    "Internal server error."
  );
});

app.listen(PORT, () => {
  console.log(`ALBUKHR TESTNET API running on port ${PORT}`);
});

diff --git a/server.js b/server.js
--- a/server.js
+++ b/server.js
@@
 const crypto = require("crypto");
 const { createClient } = require("@supabase/supabase-js");
 const StellarSdk = require("stellar-sdk");
+const createTestnetLiquidityPaymentRouter = require("./testnet-liquidity-payment-router");
@@
 app.use(express.json({ limit: "100kb" }));
+
+/*
+ * Dedicated Testnet User-to-App liquidity payment routes.
+ * These do not replace the existing admin-only /approve and /complete
+ * endpoints already used elsewhere by the Testnet API.
+ */
+app.use(
+  "/liquidity-payment",
+  createTestnetLiquidityPaymentRouter({
+    supabase,
+    axios,
+    piApiKey: PI_API_KEY
+  })
+);

 function clean(value) {
   return String(value == null ? "" : value).trim();
 }
diff --git a/testnet-liquidity-payment-router.js b/testnet-liquidity-payment-router.js
--- a/testnet-liquidity-payment-router.js
+++ b/testnet-liquidity-payment-router.js
@@
   function bearer(req) {
     const value = clean(req.get("authorization"));
-    return /^Bearer\\s+/i.test(value)
-      ? value.replace(/^Bearer\\s+/i, "").trim()
+    return /^Bearer\s+/i.test(value)
+      ? value.replace(/^Bearer\s+/i, "").trim()
       : "";
   }
@@
   async function getPiUser(accessToken) {
@@
-      const uid = clean(response.data?.uid);
-      const username = clean(response.data?.username);
+      /*
+       * Accept the current UserDTO shape and the nested form used by
+       * earlier Platform API examples. In both cases the server remains
+       * the source of truth; the browser-supplied uid is never trusted.
+       */
+      const body = response.data || {};
+      const user = body.user && typeof body.user === "object"
+        ? body.user
+        : body;
+      const uid = clean(user.uid);
+      const username = clean(user.username);
       if (!uid || !username) throw new Error("PI_IDENTITY_INCOMPLETE");
       return { uid, username, token };
@@
   function validatePaymentIdentity(payment, piUser) {
@@
   }

-  async function validateFunding(payment, projectId) {
+  function validatePaymentDestination(payment, treasury) {
+    const destination = clean(payment?.to_address);
+    const expected = clean(treasury?.treasury_wallet);
+
+    if (destination && expected && destination !== expected) {
+      throw new Error("PI_PAYMENT_RECIPIENT_MISMATCH");
+    }
+  }
+
+  function validateCompletionTxid(payment, txid) {
+    const expected = clean(payment?.transaction?.txid);
+    const supplied = clean(txid);
+
+    if (expected && supplied && expected !== supplied) {
+      throw new Error("PI_PAYMENT_TXID_MISMATCH");
+    }
+  }
+
+  async function validateFunding(
+    payment,
+    projectId,
+    { enforceRemaining = true } = {}
+  ) {
     const project = await getApprovedProject(projectId);
     const treasury = await getTreasury(project.id);
     const verified = await verifiedLiquidity(project.id);
     const required = Math.max(MIN_LIQUIDITY, Number(treasury.required_liquidity || 0));
     const due = Math.max(0, required - verified);
     const amount = amountFromPayment(payment);

-    if (due <= 0) throw new Error("PROJECT_LIQUIDITY_ALREADY_READY");
-    if (amount < due) throw new Error("LIQUIDITY_AMOUNT_BELOW_REMAINING_REQUIREMENT");
+    if (enforceRemaining) {
+      if (due <= 0) throw new Error("PROJECT_LIQUIDITY_ALREADY_READY");
+      if (amount < due) {
+        throw new Error("LIQUIDITY_AMOUNT_BELOW_REMAINING_REQUIREMENT");
+      }
+    }

     return { project, treasury, verified, required, due };
   }
@@
       PI_PAYMENT_NETWORK_INVALID: 400,
       PI_PAYMENT_DIRECTION_INVALID: 400,
       PI_PAYMENT_METADATA_NETWORK_INVALID: 400,
       PI_PAYMENT_METADATA_ACTION_INVALID: 400,
+      PI_PAYMENT_RECIPIENT_MISMATCH: 400,
+      PI_PAYMENT_TXID_MISMATCH: 400,
+      PI_PAYMENT_CANCELLED: 409,
       PI_PAYMENT_TRANSACTION_NOT_VERIFIED: 409,
     };
@@
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

-      const approved = await approvePayment(paymentId);
+      if (payment.status?.cancelled || payment.status?.user_cancelled) {
+        throw new Error("PI_PAYMENT_CANCELLED");
+      }
+
+      const approved = payment.status?.developer_approved
+        ? payment
+        : await approvePayment(paymentId);
+
       const record = await upsertPaymentRecord({
         payment,
@@
       const payment = await getPayment(paymentId);
       validatePaymentIdentity(payment, piUser);
-      const funding = await validateFunding(payment, projectId);
+      const funding = await validateFunding(payment, projectId, {
+        enforceRemaining: false
+      });
+      validatePaymentDestination(payment, funding.treasury);
+      validateCompletionTxid(payment, txid);

       if (clean(payment.metadata?.project_id) && clean(payment.metadata.project_id) !== funding.project.id) {
         throw new Error("PI_PAYMENT_PROJECT_MISMATCH");
       }

-      const completed = await completePayment(paymentId, txid);
+      const completed = payment.status?.developer_completed
+        ? payment
+        : await completePayment(paymentId, txid);
+
       const record = await upsertPaymentRecord({
         payment,
@@
       const projectId = clean(payment.metadata?.project_id);
       if (!projectId) throw new Error("PI_PAYMENT_PROJECT_REQUIRED");
-      const funding = await validateFunding(payment, projectId);
+      const funding = await validateFunding(payment, projectId, {
+        enforceRemaining: false
+      });
+      validatePaymentDestination(payment, funding.treasury);
+      if (txid) validateCompletionTxid(payment, txid);

       if (!txid) {
         return res.json({
