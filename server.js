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

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || origin === TESTNET_ORIGIN) return callback(null, true);
      return callback(new Error("CORS_ORIGIN_NOT_ALLOWED"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Admin-Key"],
    credentials: false
  })
);
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
  return /^Bearer\s+/i.test(value) ? value.replace(/^Bearer\s+/i, "").trim() : "";
}

function requireAdmin(req, res, next) {
  const supplied = clean(req.get("x-admin-key"));
  if (!TESTNET_ADMIN_API_KEY || !supplied || supplied !== TESTNET_ADMIN_API_KEY) {
    return jsonError(res, 401, "ADMIN_AUTH_REQUIRED", "Administrator authorization is required.");
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
    return jsonError(res, 401, result.error || "UNAUTHENTICATED", "A valid Testnet session is required.");
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

/*
 * Testnet-only health endpoint.
 */
app.get("/", (req, res) => {
  res.status(200).json({
    status: "OK",
    service: "ALBUKHR TESTNET API",
    network: "testnet"
  });
});

/*
 * Investor data.
 * Browser sends only the opaque Testnet session token.
 * Service role key never leaves this server.
 */
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
      return jsonError(res, 500, "STAKES_READ_FAILED", "Unable to load Testnet stakes.");
    }
    if (withdrawalsQ.error) {
      console.error("[INVESTOR] withdrawals:", withdrawalsQ.error.message);
      return jsonError(res, 500, "WITHDRAWALS_READ_FAILED", "Unable to load Testnet withdrawals.");
    }

    const stakes = stakesQ.data || [];
    const withdrawals = withdrawalsQ.data || [];

    const invested = stakes.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const earnings = stakes.reduce((sum, row) => sum + Number(row.reward_amount || 0), 0);
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
        return jsonError(res, 500, "PROJECT_READ_FAILED", "Unable to load Testnet project metadata.");
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
    return jsonError(res, 500, "INVESTOR_DATA_ERROR", "Unable to load Testnet investor data.");
  }
});

/*
 * Pi payment approval.
 * Protected by an admin key because the Pi API key is server-side.
 */
app.post("/approve", requireAdmin, async (req, res) => {
  try {
    const paymentId = clean(req.body?.paymentId);
    if (!paymentId) {
      return jsonError(res, 400, "MISSING_PAYMENT_ID", "paymentId is required.");
    }

    const response = await axios.post(
      `https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}/approve`,
      {},
      { headers: piHeaders(), timeout: 15000 }
    );

    return res.json({ success: true, data: response.data });
  } catch (error) {
    console.error("[PI APPROVE]", piApiError(error));
    return jsonError(res, 502, "PI_APPROVE_FAILED", "Pi payment approval failed.");
  }
});

/*
 * Pi payment completion.
 */
app.post("/complete", requireAdmin, async (req, res) => {
  try {
    const paymentId = clean(req.body?.paymentId);
    const txid = clean(req.body?.txid);

    if (!paymentId || !txid) {
      return jsonError(res, 400, "MISSING_PAYMENT_FIELDS", "paymentId and txid are required.");
    }

    const response = await axios.post(
      `https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}/complete`,
      { txid },
      { headers: piHeaders(), timeout: 15000 }
    );

    return res.json({ success: true, data: response.data });
  } catch (error) {
    console.error("[PI COMPLETE]", piApiError(error));
    return jsonError(res, 502, "PI_COMPLETE_FAILED", "Pi payment completion failed.");
  }
});

/*
 * Fetch an approved withdrawal request.
 * This endpoint is for server/admin workflows, not the investor UI.
 */
app.post("/withdraw", requireAdmin, async (req, res) => {
  try {
    const requestId = clean(req.body?.requestId);
    if (!requestId) {
      return jsonError(res, 400, "MISSING_REQUEST_ID", "requestId is required.");
    }

    const { data, error } = await supabase
      .from("withdrawal_requests")
      .select("*")
      .eq("id", requestId)
      .eq("network", "testnet")
      .maybeSingle();

    if (error) {
      console.error("[WITHDRAW LOOKUP]", error.message);
      return jsonError(res, 500, "WITHDRAW_READ_FAILED", "Unable to read the withdrawal request.");
    }
    if (!data) {
      return jsonError(res, 404, "REQUEST_NOT_FOUND", "Withdrawal request not found.");
    }
    if (data.status !== "approved") {
      return jsonError(res, 400, "REQUEST_NOT_APPROVED", "Withdrawal request is not approved.");
    }

    return res.json({ success: true, request: data });
  } catch (error) {
    console.error("[WITHDRAW LOOKUP]", error);
    return jsonError(res, 500, "WITHDRAW_LOOKUP_FAILED", "Unable to load the withdrawal request.");
  }
});

/*
 * Testnet withdrawal payout.
 * This is deliberately admin-only and uses the Testnet network.
 * No browser-facing session can invoke it.
 */
app.post("/pay-withdraw", requireAdmin, async (req, res) => {
  try {
    if (!WALLET_PRIVATE_SEED) {
      return jsonError(res, 500, "WALLET_NOT_CONFIGURED", "Testnet payout wallet is not configured.");
    }

    const requestId = clean(req.body?.requestId);
    if (!requestId) {
      return jsonError(res, 400, "MISSING_REQUEST_ID", "requestId is required.");
    }

    const { data, error } = await supabase
      .from("withdrawal_requests")
      .select(
        "id,pi_uid,project_id,project_code,network,requested_amount,fee_amount,net_amount,wallet_address,status,txid"
      )
      .eq("id", requestId)
      .eq("network", "testnet")
      .maybeSingle();

    if (error) {
      console.error("[PAY WITHDRAW] read:", error.message);
      return jsonError(res, 500, "WITHDRAW_READ_FAILED", "Unable to read the withdrawal request.");
    }
    if (!data) {
      return jsonError(res, 404, "REQUEST_NOT_FOUND", "Withdrawal request not found.");
    }
    if (data.status !== "approved") {
      return jsonError(res, 400, "REQUEST_NOT_APPROVED", "Withdrawal request must be approved first.");
    }
    if (!clean(data.wallet_address)) {
      return jsonError(res, 400, "MISSING_WALLET", "Withdrawal wallet address is missing.");
    }

    const amount = Number(data.net_amount ?? data.requested_amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return jsonError(res, 400, "INVALID_AMOUNT", "Withdrawal amount is invalid.");
    }

    const sourceKeypair = StellarSdk.Keypair.fromSecret(WALLET_PRIVATE_SEED);
    const sourceAccount = await server.loadAccount(sourceKeypair.publicKey());
    const baseFee = await server.fetchBaseFee();

    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: baseFee.toString(),
      networkPassphrase: "Pi Testnet"
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: data.wallet_address,
          asset: StellarSdk.Asset.native(),
          amount: amount.toFixed(7)
        })
      )
      .setTimeout(180)
      .build();

    transaction.sign(sourceKeypair);

    const result = await server.submitTransaction(transaction);
    const txHash = result.hash;
    const processedAt = new Date().toISOString();

    const update = await supabase
      .from("withdrawal_requests")
      .update({
        status: "completed",
        txid: txHash,
        reviewed_at: processedAt
      })
      .eq("id", requestId)
      .eq("network", "testnet")
      .eq("status", "approved")
      .select("id,status,txid")
      .maybeSingle();

    if (update.error) {
      console.error("[PAY WITHDRAW] DB update:", update.error.message);
      return res.status(502).json({
        success: false,
        error: "PAYOUT_RECORDED_FAILED",
        txid: txHash
      });
    }

    return res.json({
      success: true,
      network: "testnet",
      txid: txHash,
      request: update.data
    });
  } catch (error) {
    console.error("[PAY WITHDRAW]", error?.response?.data || error);
    return jsonError(res, 502, "TESTNET_PAYOUT_FAILED", "Testnet withdrawal payout failed.");
  }
});

/*
 * Operational diagnostics are admin-only.
 * Private wallet seed is never returned.
 */
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

    return res.json({ success: true, network: "testnet", rows: data || [] });
  } catch (error) {
    return jsonError(res, 500, "SUPABASE_TEST_FAILED", error.message);
  }
});

app.get("/test-stellar", requireAdmin, async (req, res) => {
  try {
    const publicKey = clean(process.env.TESTNET_WALLET_PUBLIC_KEY);
    if (!publicKey) {
      return jsonError(res, 500, "WALLET_PUBLIC_KEY_NOT_CONFIGURED", "TESTNET_WALLET_PUBLIC_KEY is required.");
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
    if (!WALLET_PRIVATE_SEED) {
      return jsonError(res, 500, "WALLET_NOT_CONFIGURED", "Testnet payout wallet is not configured.");
    }

    const keypair = StellarSdk.Keypair.fromSecret(WALLET_PRIVATE_SEED);
    return res.json({
      success: true,
      network: "testnet",
      publicKey: keypair.publicKey()
    });
  } catch (error) {
    return jsonError(res, 500, "WALLET_TEST_FAILED", error.message);
  }
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: "NOT_FOUND" });
});

app.use((error, req, res, next) => {
  console.error("[API]", error);
  if (error?.message === "CORS_ORIGIN_NOT_ALLOWED") {
    return jsonError(res, 403, "CORS_ORIGIN_NOT_ALLOWED", "Origin is not allowed.");
  }
  return jsonError(res, 500, "INTERNAL_SERVER_ERROR", "Internal server error.");
});

app.listen(PORT, () => {
  console.log(`ALBUKHR TESTNET API running on port ${PORT}`);
});
