const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const StellarSdk = require("stellar-sdk");

const createTestnetLiquidityPaymentRouter =
  require("./testnet-liquidity-payment-router");

const createTestnetStakingRouter =
  require("./testnet-staking-router");

const createTestnetOutflowFeeRouter =
  require("./testnet-outflow-fee-router");

const app = express();

const PORT = Number(process.env.PORT || 8080);

const TESTNET_ORIGIN =
  process.env.TESTNET_ORIGIN ||
  "https://test.albukhr.com";

const SUPABASE_URL =
  process.env.SUPABASE_URL;

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const PI_API_KEY =
  process.env.PI_API_KEY;

const WALLET_PRIVATE_SEED =
  process.env.WALLET_PRIVATE_SEED;

const TESTNET_ADMIN_API_KEY =
  process.env.TESTNET_ADMIN_API_KEY;

const TESTNET_WITHDRAWAL_RECONCILE_LIMIT = Math.min(
  200,
  Math.max(
    20,
    Number(
      process.env.TESTNET_WITHDRAWAL_RECONCILE_LIMIT || 100
    )
  )
);

if (
  !SUPABASE_URL ||
  !SUPABASE_SERVICE_ROLE_KEY
) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required."
  );
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

const server =
  new StellarSdk.Horizon.Server(
    process.env.PI_HORIZON_URL ||
      "https://api.testnet.minepi.com"
  );

app.disable("x-powered-by");

/* ============================================================
   CORS
   ============================================================ */

app.use(
  cors({
    origin(origin, callback) {
      if (
        !origin ||
        origin === TESTNET_ORIGIN
      ) {
        return callback(null, true);
      }

      return callback(
        new Error("CORS_ORIGIN_NOT_ALLOWED")
      );
    },

    methods: [
      "GET",
      "POST",
      "OPTIONS"
    ],

    allowedHeaders: [
  "Authorization",
  "Content-Type",
  "X-Admin-Key",
  "X-Testnet-Session",
  "X-Testnet-Admin-Session"
],

    credentials: false
  })
);

/* ============================================================
   BODY PARSER
   ============================================================ */

app.use(
  express.json({
    limit: "100kb"
  })
);

/* ============================================================
   TESTNET LIQUIDITY PAYMENT ROUTER
   ------------------------------------------------------------
   This is an additive module.

   Existing:
   - withdrawals
   - investor data
   - admin routes
   - Pi payment admin routes
   - Stellar payout routes

   remain unchanged.
   ============================================================ */


app.use(
  "/liquidity-payment",
  createTestnetLiquidityPaymentRouter({
    supabase,
    axios,
    piApiKey: PI_API_KEY,
    piTestnetAppWallet: process.env.PI_TESTNET_APP_WALLET || ""
  })
);

/* Testnet-only staking and Pi payment verification. */
app.use(
  "/staking",
  createTestnetStakingRouter({
    supabase,
    axios,
    piApiKey: PI_API_KEY,
    piTestnetAppWallet:
      process.env.PI_TESTNET_APP_WALLET || ""
  })
);

/* Testnet-only Global Treasury outflow fee flow. */
app.use(
  "/outflow-fee",
  createTestnetOutflowFeeRouter({
    supabase,
    axios,
    piApiKey: PI_API_KEY,
    piTestnetAppWallet:
      process.env.PI_TESTNET_APP_WALLET || "",
    submitTestnetWithdrawalPayout,
    markWithdrawalCompleted,
    findTestnetWithdrawalPayoutByMemo,
    markOwnerWithdrawalCompleted,
  })
);

/* ============================================================
   UTILITIES
   ============================================================ */

function clean(value) {
  return String(
    value == null ? "" : value
  ).trim();
}

function jsonError(
  res,
  status,
  code,
  message
) {
  return res.status(status).json({
    success: false,
    error: code,
    message
  });
}

function sha256Hex(value) {
  return crypto
    .createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
}

function bearer(req) {
  const value =
    clean(req.get("authorization"));

  return /^Bearer\s+/i.test(value)
    ? value
        .replace(/^Bearer\s+/i, "")
        .trim()
    : "";
}

/* ============================================================
   ADMIN AUTH
   ============================================================ */

function requireAdmin(
  req,
  res,
  next
) {
  const supplied =
    clean(req.get("x-admin-key"));

  if (
    !TESTNET_ADMIN_API_KEY ||
    !supplied ||
    supplied !== TESTNET_ADMIN_API_KEY
  ) {
    return jsonError(
      res,
      401,
      "ADMIN_AUTH_REQUIRED",
      "Administrator authorization is required."
    );
  }

  return next();
}

/* ============================================================
   TESTNET SESSION
   ============================================================ */

async function getTestnetSession(req) {
  const token = bearer(req);

  if (!token) {
    return {
      error: "UNAUTHENTICATED"
    };
  }

  const sessionHash =
    sha256Hex(token);

  const {
    data,
    error
  } = await supabase
    .from("testnet_sessions")
    .select(
      "pi_uid,username,wallet_address,network,expires_at,revoked_at"
    )
    .eq(
      "session_hash",
      sessionHash
    )
    .eq(
      "network",
      "testnet"
    )
    .maybeSingle();

  if (error) {
    console.error(
      "[AUTH] session lookup failed:",
      error.message
    );

    return {
      error: "SESSION_LOOKUP_FAILED"
    };
  }

  if (!data) {
    return {
      error: "SESSION_INVALID"
    };
  }

  if (data.revoked_at) {
    return {
      error: "SESSION_REVOKED"
    };
  }

  if (
    !data.expires_at ||
    new Date(data.expires_at).getTime() <=
      Date.now()
  ) {
    return {
      error: "SESSION_EXPIRED"
    };
  }

  return {
    session: data
  };
}

async function requireSession(
  req,
  res,
  next
) {
  const result =
    await getTestnetSession(req);

  if (!result.session) {
    return jsonError(
      res,
      401,
      result.error ||
        "UNAUTHENTICATED",
      "A valid Testnet session is required."
    );
  }

  req.testnetSession =
    result.session;

  return next();
}

/* ============================================================
   PI CONFIGURATION
   ============================================================ */

function assertPiConfig() {
  if (!PI_API_KEY) {
    throw new Error(
      "PI_API_KEY is not configured."
    );
  }
}

function piHeaders() {
  assertPiConfig();

  return {
    Authorization:
      `Key ${PI_API_KEY}`
  };
}

function piApiError(error) {
  return (
    error?.response?.data ||
    error?.message ||
    "Pi API request failed."
  );
}

/* ============================================================
   NUMERIC UTILITY
   ============================================================ */

function numeric(value) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

/* ============================================================
   WITHDRAWAL MEMO
   ============================================================ */

/*
 * A withdrawal ID maps to one deterministic
 * 28-byte Stellar text memo.
 *
 * This lets reconciliation detect a payout
 * that reached Pi Testnet even when the
 * database update was interrupted afterwards.
 */

function withdrawalMemo(
  requestId
) {
  return (
    "ALB-" +
    sha256Hex(requestId).slice(
      0,
      24
    )
  );
}

/* ============================================================
   PAYOUT WALLET
   ============================================================ */

function payoutWalletKeypair() {
  if (!WALLET_PRIVATE_SEED) {
    throw new Error(
      "WALLET_NOT_CONFIGURED"
    );
  }

  return StellarSdk.Keypair.fromSecret(
    WALLET_PRIVATE_SEED
  );
}

/* ============================================================
   WITHDRAWAL DATABASE
   ============================================================ */

async function getWithdrawal(
  requestId
) {
  const {
    data,
    error
  } = await supabase
    .from("withdrawal_requests")
    .select("*")
    .eq("id", requestId)
    .eq("network", "testnet")
    .maybeSingle();

  if (error) {
    throw new Error(
      `WITHDRAW_READ_FAILED:${error.message}`
    );
  }

  return data || null;
}

/* ============================================================
   FIND TESTNET PAYOUT
   ============================================================ */

async function findTestnetPayoutByMemo(
  sourcePublicKey,
  memoText,
  expectedPayout
) {
  const expectedWallet = clean(
    expectedPayout && expectedPayout.wallet_address
  );
  const expectedAmount = numeric(
    expectedPayout && expectedPayout.amount
  );

  if (
    !clean(sourcePublicKey) ||
    !clean(memoText) ||
    !expectedWallet ||
    expectedAmount === null ||
    expectedAmount <= 0
  ) {
    throw new Error("TESTNET_PAYOUT_EXPECTED_DETAILS_REQUIRED");
  }

  const page = await server
    .transactions()
    .forAccount(sourcePublicKey)
    .order("desc")
    .limit(TESTNET_WITHDRAWAL_RECONCILE_LIMIT)
    .call();

  let memoMatchCouldNotBeVerified = false;

  for (const tx of page.records || []) {
    if (clean(tx.memo) !== memoText) {
      continue;
    }

    if (tx.memo_type !== "text") {
      memoMatchCouldNotBeVerified = true;
      continue;
    }

    // A failed transaction is not a completed payout.
    if (tx.successful !== true) {
      continue;
    }

    // The source must be the Testnet app payout wallet.
    if (clean(tx.source_account) !== clean(sourcePublicKey)) {
      memoMatchCouldNotBeVerified = true;
      continue;
    }

    let operationPage;

    try {
      operationPage = await server
        .operations()
        .forTransaction(tx.hash)
        .call();
    } catch (error) {
      const lookupError = new Error(
        "TESTNET_PAYOUT_OPERATION_LOOKUP_FAILED"
      );
      lookupError.status = 503;
      throw lookupError;
    }

    const validPaymentOperation = (
      operationPage.records || []
    ).some((operation) => {
      const operationAmount = numeric(operation.amount);

      return (
        operation.type === "payment" &&
        operation.transaction_successful === true &&
        operation.asset_type === "native" &&
        clean(operation.from) === clean(sourcePublicKey) &&
        clean(operation.to) === expectedWallet &&
        operationAmount !== null &&
        operationAmount.toFixed(7) === expectedAmount.toFixed(7)
      );
    });

    if (validPaymentOperation) {
      return tx;
    }

    // A transaction uses the memo but does not match the expected payout.
    // Do not treat it as settled, and do not automatically send another.
    memoMatchCouldNotBeVerified = true;
  }

  if (memoMatchCouldNotBeVerified) {
    throw new Error("TESTNET_PAYOUT_MEMO_MATCH_INVALID");
  }

  return null;
}

async function findTestnetWithdrawalPayoutByMemo(requestId) {
  if (!clean(requestId)) {
    throw new Error("REQUEST_ID_REQUIRED");
  }

  const sourcePublicKey = payoutWalletKeypair().publicKey();
  const memoText = withdrawalMemo(requestId);

  const existing = await findTestnetPayoutByMemo(
    sourcePublicKey,
    memoText
  );

  if (!existing) return null;

  return {
    txid: existing.hash,
    memo: memoText,
    reconciled: true,
  };
}

/* ============================================================
   MARK WITHDRAWAL COMPLETED
   ------------------------------------------------------------
   Uses the existing database RPC to settle the withdrawal
   and update its ledger atomically.

   TESTNET ONLY.
   ============================================================ */

async function markWithdrawalCompleted(
  requestId,
  txid
) {
  if (
    !clean(requestId) ||
    !clean(txid)
  ) {
    throw new Error(
      "PAYOUT_RECORDED_FAILED:Missing request ID or transaction ID."
    );
  }

  const settlement = await supabase.rpc(
    "complete_testnet_withdrawal_and_ledger",
    {
      p_request_id: requestId,
      p_txid: txid
    }
  );

  if (settlement.error) {
    throw new Error(
      `PAYOUT_RECORDED_FAILED:${settlement.error.message}`
    );
  }

  const result = Array.isArray(settlement.data)
    ? settlement.data[0]
    : settlement.data;

  if (!result) {
    throw new Error(
      "PAYOUT_RECORDED_FAILED:Database settlement returned no result."
    );
  }

  return result;
}

async function markOwnerWithdrawalCompleted(requestId, txid) {
  if (!clean(requestId) || !clean(txid)) {
    throw new Error(
      "OWNER_PAYOUT_RECORDED_FAILED:Missing request ID or transaction ID."
    );
  }

  const settlement = await supabase.rpc(
    "complete_testnet_project_owner_withdrawal",
    {
      p_withdrawal_id: requestId,
      p_txid: txid,
      p_reviewed_by: null,
    }
  );

  if (settlement.error) {
    throw new Error(
      `OWNER_PAYOUT_RECORDED_FAILED:${settlement.error.message}`
    );
  }

  const result = Array.isArray(settlement.data)
    ? settlement.data[0]
    : settlement.data;

  if (!result) {
    throw new Error(
      "OWNER_PAYOUT_RECORDED_FAILED:Database settlement returned no result."
    );
  }

  return result;
      }

/* ============================================================
   SUBMIT TESTNET WITHDRAWAL PAYOUT
   ============================================================ */

async function submitTestnetWithdrawalPayout(
  requestRow
) {
  if (!requestRow) {
    throw new Error(
      "REQUEST_NOT_FOUND"
    );
  }

  if (
    !clean(requestRow.wallet_address)
  ) {
    throw new Error(
      "MISSING_WALLET"
    );
  }

  const amount =
    numeric(
      requestRow.net_amount ??
        requestRow.requested_amount
    );

  if (
    amount === null ||
    amount <= 0
  ) {
    throw new Error(
      "INVALID_AMOUNT"
    );
  }

  const sourceKeypair =
    payoutWalletKeypair();

  const sourcePublicKey =
    sourceKeypair.publicKey();

  const memoText =
    withdrawalMemo(
      requestRow.id
    );

  const existing =
    await findTestnetPayoutByMemo(
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

  const sourceAccount =
    await server.loadAccount(
      sourcePublicKey
    );

  const baseFee =
    await server.fetchBaseFee();

  const transaction =
    new StellarSdk.TransactionBuilder(
      sourceAccount,
      {
        fee: baseFee.toString(),
        networkPassphrase:
          "Pi Testnet"
      }
    )
      .addOperation(
        StellarSdk.Operation.payment({
          destination:
            requestRow.wallet_address,

          asset:
            StellarSdk.Asset.native(),

          amount:
            amount.toFixed(7)
        })
      )
      .addMemo(
        StellarSdk.Memo.text(
          memoText
        )
      )
      .setTimeout(180)
      .build();

  transaction.sign(
    sourceKeypair
  );

  const result =
    await server.submitTransaction(
      transaction
    );

  return {
    txid: result.hash,
    reconciled: false,
    memo: memoText
  };
}

/* ============================================================
   CREATE + CLAIM WITHDRAWAL
   ============================================================ */

async function createAndClaimWithdrawal({
  piUid,
  stakeId,
  withdrawalType,
  requestedAmount,
  walletAddress
}) {
  const create =
    await supabase.rpc(
      "create_testnet_withdrawal",
      {
        p_pi_uid: piUid,
        p_stake_id: stakeId,
        p_withdrawal_type:
          withdrawalType,
        p_requested_amount:
          requestedAmount,
        p_wallet_address:
          walletAddress
      }
    );

  if (create.error) {
    console.error(
      "[WITHDRAW CREATE]",
      create.error.message
    );

    throw new Error(
      `WITHDRAW_CREATE_FAILED:${create.error.message}`
    );
  }

  const created =
    Array.isArray(create.data)
      ? create.data[0]
      : create.data;

  if (!created?.id) {
    throw new Error(
      "WITHDRAW_CREATE_FAILED:No withdrawal request was returned."
    );
  }

  const claim =
    await supabase.rpc(
      "claim_testnet_withdrawal",
      {
        p_request_id:
          created.id,

        p_pi_uid:
          piUid
      }
    );

  if (claim.error) {
    console.error(
      "[WITHDRAW CLAIM]",
      claim.error.message
    );

    return {
      request: created,
      claimed: false,
      claimError:
        claim.error.message
    };
  }

  const claimed =
    Array.isArray(claim.data)
      ? claim.data[0]
      : claim.data;

  return {
    request:
      claimed || created,

    claimed: true
  };
}

/* ============================================================
   TESTNET HEALTH
   ============================================================ */

app.get(
  "/",
  (req, res) => {
    return res.status(200).json({
      status: "OK",
      service:
        "ALBUKHR TESTNET API",
      network: "testnet"
    });
  }
);

/* ============================================================
   PROTECTED TESTNET INVESTOR DATA
   ============================================================ */

app.get(
  "/investor-data",
  requireSession,
  async (req, res) => {
    try {
      const uid =
        req.testnetSession.pi_uid;

      const [
        stakesQ,
        withdrawalsQ
      ] = await Promise.all([
        supabase
          .from("stakes")
          .select(
            "id,project_id,project_code,amount,duration_days,reward_rate,reward_amount,status,start_at,unlock_at,created_at"
          )
          .eq(
            "network",
            "testnet"
          )
          .eq(
            "pi_uid",
            uid
          )
          .order(
            "created_at",
            {
              ascending: false
            }
          ),

        supabase
          .from(
            "withdrawal_requests"
          )
          .select(
            "id,stake_id,project_id,project_code,withdrawal_type,requested_amount,fee_rate,fee_amount,net_amount,status,txid,created_at,reviewed_at"
          )
          .eq(
            "network",
            "testnet"
          )
          .eq(
            "pi_uid",
            uid
          )
          .order(
            "created_at",
            {
              ascending: false
            }
          )
      ]);

      if (stakesQ.error) {
        console.error(
          "[INVESTOR] stakes:",
          stakesQ.error.message
        );

        return jsonError(
          res,
          500,
          "STAKES_READ_FAILED",
          "Unable to load Testnet stakes."
        );
      }

      if (withdrawalsQ.error) {
        console.error(
          "[INVESTOR] withdrawals:",
          withdrawalsQ.error.message
        );

        return jsonError(
          res,
          500,
          "WITHDRAWALS_READ_FAILED",
          "Unable to load Testnet withdrawals."
        );
      }

      const stakes =
        stakesQ.data || [];

      const withdrawals =
        withdrawalsQ.data || [];

      const invested =
        stakes.reduce(
          (sum, row) =>
            sum +
            Number(
              row.amount || 0
            ),
          0
        );

      const earnings =
        stakes.reduce(
          (sum, row) =>
            sum +
            Number(
              row.reward_amount ||
                0
            ),
          0
        );

      const active =
        stakes.filter(
          (row) =>
            row.status ===
            "active"
        );

      const projectCodes = [
        ...new Set(
          stakes
            .map((row) =>
              clean(
                row.project_code
              )
            )
            .filter(Boolean)
        )
      ];

      let projects = [];

      if (
        projectCodes.length
      ) {
        const projectsQ =
          await supabase
            .from("projects")
            .select(
              "id,project_code,slug,name,project_type,status,description,core_slot,network,logo_url"
            )
            .eq(
              "network",
              "testnet"
            )
            .in(
              "project_code",
              projectCodes
            );

        if (projectsQ.error) {
          console.error(
            "[INVESTOR] projects:",
            projectsQ.error.message
          );

          return jsonError(
            res,
            500,
            "PROJECT_READ_FAILED",
            "Unable to load Testnet project metadata."
          );
        }

        projects =
          projectsQ.data || [];
      }

      return res.json({
        success: true,
        ok: true,
        network: "testnet",

        user: {
          pi_uid: uid,

          username:
            req.testnetSession
              .username ||
            null,

          wallet_address:
            req.testnetSession
              .wallet_address ||
            null
        },

        summary: {
          portfolio:
            invested +
            earnings,

          invested,

          earnings,

          active_projects:
            new Set(
              active
                .map((row) =>
                  clean(
                    row.project_code
                  )
                )
                .filter(Boolean)
            ).size,

          stake_count:
            stakes.length
        },

        stakes,

        withdrawals,

        projects
      });
    } catch (error) {
      console.error(
        "[INVESTOR]",
        error
      );

      return jsonError(
        res,
        500,
        "INVESTOR_DATA_ERROR",
        "Unable to load Testnet investor data."
      );
    }
  }
);

/* ============================================================
   EXISTING PI ADMIN APPROVAL
   ------------------------------------------------------------
   PRESERVED.
   ============================================================ */

app.post(
  "/approve",
  requireAdmin,
  async (req, res) => {
    try {
      const paymentId =
        clean(
          req.body?.paymentId
        );

      if (!paymentId) {
        return jsonError(
          res,
          400,
          "MISSING_PAYMENT_ID",
          "paymentId is required."
        );
      }

      const response =
        await axios.post(
          `https://api.minepi.com/v2/payments/${encodeURIComponent(
            paymentId
          )}/approve`,
          {},
          {
            headers:
              piHeaders(),
            timeout: 15000
          }
        );

      return res.json({
        success: true,
        data:
          response.data
      });
    } catch (error) {
      console.error(
        "[PI APPROVE]",
        piApiError(error)
      );

      return jsonError(
        res,
        502,
        "PI_APPROVE_FAILED",
        "Pi payment approval failed."
      );
    }
  }
);

/* ============================================================
   EXISTING PI ADMIN COMPLETION
   ------------------------------------------------------------
   PRESERVED.
   ============================================================ */

app.post(
  "/complete",
  requireAdmin,
  async (req, res) => {
    try {
      const paymentId =
        clean(
          req.body?.paymentId
        );

      const txid =
        clean(
          req.body?.txid
        );

      if (
        !paymentId ||
        !txid
      ) {
        return jsonError(
          res,
          400,
          "MISSING_PAYMENT_FIELDS",
          "paymentId and txid are required."
        );
      }

      const response =
        await axios.post(
          `https://api.minepi.com/v2/payments/${encodeURIComponent(
            paymentId
          )}/complete`,
          { txid },
          {
            headers:
              piHeaders(),
            timeout: 15000
          }
        );

      return res.json({
        success: true,
        data:
          response.data
      });
    } catch (error) {
      console.error(
        "[PI COMPLETE]",
        piApiError(error)
      );

      return jsonError(
        res,
        502,
        "PI_COMPLETE_FAILED",
        "Pi payment completion failed."
      );
    }
  }
);

/* ============================================================
   USER TESTNET WITHDRAWAL
   ============================================================ */

app.post(
  "/withdraw",
  requireSession,
  async (req, res) => {
    try {

            // SAFETY LOCK: Keep Testnet withdrawals disabled until
      // the separate U2A fee-payment flow is fully verified.
      return res.status(423).json({
        success: false,
        network: "testnet",
        error: "TESTNET_WITHDRAWALS_LOCKED",
        message:
          "Testnet withdrawals remain locked until fee payment verification, payout preflight, and idempotent reconciliation have passed end-to-end tests."
      });

      const piUid =
        clean(
          req.testnetSession
            .pi_uid
        );

      const stakeId =
        clean(
          req.body?.stakeId
        );

      const withdrawalType =
        clean(
          req.body?.withdrawalType
        ).toLowerCase();

      const walletAddress =
        clean(
          req.body?.walletAddress ||
          req.testnetSession
            .wallet_address
        );

      const requestedAmount =
        numeric(
          req.body?.requestedAmount
        );

      if (
        !stakeId ||
        ![
          "reward",
          "capital"
        ].includes(
          withdrawalType
        )
      ) {
        return jsonError(
          res,
          400,
          "INVALID_WITHDRAWAL_REQUEST",
          "stakeId and withdrawalType (reward or capital) are required."
        );
      }

      if (
        requestedAmount ===
          null ||
        requestedAmount < 0.5
      ) {
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

      const created =
        await createAndClaimWithdrawal({
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

      const payout =
        await submitTestnetWithdrawalPayout(
          created.request
        );

      let completed;

      try {
        completed =
          await markWithdrawalCompleted(
            created.request.id,
            payout.txid
          );
      } catch (
        recordError
      ) {
        console.error(
          "[WITHDRAW] payout succeeded but DB update failed:",
          recordError
        );

        return res
          .status(502)
          .json({
            success: false,

            error:
              "PAYOUT_RECORDED_FAILED",

            message:
              "The Testnet payout was submitted, but its database status could not be recorded. Reconciliation is required.",

            network:
              "testnet",

            txid:
              payout.txid,

            request_id:
              created.request.id
          });
      }

      return res.json({
        success: true,
        network: "testnet",
        payout:
          "completed",

        reconciled:
          !!payout.reconciled,

        txid:
          payout.txid,

        request:
          completed ||
          created.request
      });
    } catch (error) {
      const message =
        clean(
          error?.message
        );

      console.error(
        "[WITHDRAW]",
        error?.stack ||
          error
      );

      if (
        message.startsWith(
          "WITHDRAW_CREATE_FAILED:"
        )
      ) {
        return jsonError(
          res,
          400,
          "WITHDRAWAL_REJECTED",
          message.slice(
            "WITHDRAW_CREATE_FAILED:"
              .length
          )
        );
      }

      if (
        message ===
        "WALLET_NOT_CONFIGURED"
      ) {
        return jsonError(
          res,
          503,
          "WALLET_NOT_CONFIGURED",
          "Testnet payout wallet is not configured."
        );
      }

      if (
        message ===
        "MISSING_WALLET"
      ) {
        return jsonError(
          res,
          400,
          "MISSING_WALLET",
          "A Testnet wallet address is required."
        );
      }

      if (
        message ===
        "INVALID_AMOUNT"
      ) {
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
  }
);

/* ============================================================
   ADMIN WITHDRAWAL LOOKUP
   ============================================================ */

app.post(
  "/withdraw/lookup",
  requireAdmin,
  async (req, res) => {
    try {
      const requestId =
        clean(
          req.body?.requestId
        );

      if (!requestId) {
        return jsonError(
          res,
          400,
          "MISSING_REQUEST_ID",
          "requestId is required."
        );
      }

      const data =
        await getWithdrawal(
          requestId
        );

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
      console.error(
        "[WITHDRAW LOOKUP]",
        error
      );

      return jsonError(
        res,
        500,
        "WITHDRAW_LOOKUP_FAILED",
        "Unable to load the withdrawal request."
      );
    }
  }
);

/* ============================================================
   ADMIN MANUAL PAYOUT — ATOMIC TESTNET CLAIM
   ------------------------------------------------------------
   Replace the existing app.post("/pay-withdraw", ...) route in
   test-albukhr-api/server.js with this complete route.

   Safety behavior:
   - Only an approved request can be newly claimed for payout.
   - The DB update from approved -> processing is atomic.
   - Only the request that successfully claims the row submits payout.
   - An already-processing request is not paid again; reconcile it.
   - All database reads/writes remain scoped to network=testnet.
   ============================================================ */

app.post(
  "/pay-withdraw",
  requireAdmin,
  async (req, res) => {
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

      if (requestRow.status !== "approved") {
        if (requestRow.status === "processing") {
          return jsonError(
            res,
            409,
            "PAYOUT_ALREADY_CLAIMED",
            "This withdrawal is already processing or has an uncertain payout outcome. Reconcile it before any retry."
          );
        }

        return jsonError(
          res,
          400,
          "REQUEST_NOT_PAYABLE",
          "Only an approved Testnet withdrawal can be claimed for a new manual payout."
        );
      }
      // Global Treasury fee preflight MUST run before claiming or sending a payout.
      const feeCheck = await supabase.rpc(
        "assert_testnet_outflow_fee_ready",
        {
          p_source_type: "staker_withdrawal",
          p_source_id: requestId
        }
      );

      const feeAssessment = Array.isArray(feeCheck.data)
        ? feeCheck.data[0]
        : feeCheck.data;

      if (
        feeCheck.error ||
        !feeAssessment ||
        (
          Number(feeAssessment.fee_amount) > 0 &&
          feeAssessment.fee_status !== "paid"
        )
      ) {
        console.warn(
          "[PAY WITHDRAW] blocked by Global Treasury fee preflight",
          requestId,
          feeCheck.error ? feeCheck.error.message : "fee not confirmed"
        );

        return jsonError(
          res,
          409,
          "OUTFLOW_FEE_PAYMENT_REQUIRED",
          "A valid fee assessment and confirmed fee payment (or an approved zero-fee assessment) are required before a Testnet payout."
        );
      }

      // Atomic compare-and-set: among concurrent requests, only one can
      // change this row from approved to processing and proceed to Horizon.
      const claim = await supabase
        .from("withdrawal_requests")
        .update({
          status: "processing",
          updated_at: new Date().toISOString()
        })
        .eq("id", requestId)
        .eq("network", "testnet")
        .eq("status", "approved")
        .select(
          "id,status,txid,requested_amount,fee_amount,net_amount,wallet_address,stake_id,project_id,project_code,withdrawal_type,pi_uid,created_at,updated_at"
        )
        .maybeSingle();

      if (claim.error) {
        console.error(
          "[PAY WITHDRAW] atomic claim failed:",
          claim.error.message
        );

        return jsonError(
          res,
          500,
          "PAYOUT_CLAIM_FAILED",
          "The withdrawal could not be claimed safely. Reconcile the request before retrying."
        );
      }

      if (!claim.data) {
        // Another request may have claimed/completed it after our first read.
        const latest = await getWithdrawal(requestId);

        if (latest?.status === "completed") {
          return res.json({
            success: true,
            network: "testnet",
            payout: "already_completed",
            txid: latest.txid,
            request: latest
          });
        }

        return jsonError(
          res,
          409,
          "PAYOUT_ALREADY_CLAIMED",
          "Another operation claimed this withdrawal. Reconcile it before retrying."
        );
      }

      // Do not revert a claimed request automatically if payout outcome is
      // uncertain. Horizon reconciliation must establish whether it was sent.
      const payout = await submitTestnetWithdrawalPayout(claim.data);

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
          request: completed || claim.data
        });
      } catch (recordError) {
        console.error(
          "[PAY WITHDRAW] payout succeeded but DB settlement failed:",
          recordError
        );

        return res.status(502).json({
          success: false,
          error: "PAYOUT_RECORDED_FAILED",
          network: "testnet",
          message: "The Testnet payout may have succeeded, but database settlement failed. Reconcile before retrying.",
          txid: payout.txid,
          request_id: requestId
        });
      }
    } catch (error) {
      console.error(
        "[PAY WITHDRAW]",
        error?.stack || error
      );

      return jsonError(
        res,
        502,
        "TESTNET_PAYOUT_FAILED",
        "Testnet payout failed or its outcome is uncertain. Reconcile before retrying."
      );
    }
  }
);

/* ============================================================
   ADMIN WITHDRAWAL RECONCILIATION
   ============================================================ */

app.post(
  "/reconcile-withdraw",
  requireAdmin,
  async (req, res) => {
    try {
      const requestId =
        clean(
          req.body?.requestId
        );

      if (!requestId) {
        return jsonError(
          res,
          400,
          "MISSING_REQUEST_ID",
          "requestId is required."
        );
      }

      const requestRow =
        await getWithdrawal(
          requestId
        );

      if (!requestRow) {
        return jsonError(
          res,
          404,
          "REQUEST_NOT_FOUND",
          "Withdrawal request not found."
        );
      }

      if (
        requestRow.status ===
        "completed"
      ) {
        return res.json({
          success: true,
          network: "testnet",
          reconciled: true,
          payoutFound: true,

          txid:
            requestRow.txid,

          request:
            requestRow
        });
      }

      if (
        ![
          "processing",
          "approved"
        ].includes(
          requestRow.status
        )
      ) {
        return jsonError(
          res,
          400,
          "REQUEST_NOT_RECONCILABLE",
          "Withdrawal request is not processing or approved."
        );
      }

      const sourceKeypair =
        payoutWalletKeypair();

      const memoText =
        withdrawalMemo(
          requestId
        );

      const existing =
        await findTestnetPayoutByMemo(
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
          request:
            requestRow
        });
      }

      const completed =
        await markWithdrawalCompleted(
          requestId,
          existing.hash
        );

      return res.json({
        success: true,
        network: "testnet",
        reconciled: true,
        payoutFound: true,

        txid:
          existing.hash,

        request:
          completed ||
          requestRow
      });
    } catch (error) {
      console.error(
        "[RECONCILE WITHDRAW]",
        error?.stack ||
          error
      );

      return jsonError(
        res,
        502,
        "WITHDRAW_RECONCILIATION_FAILED",
        "Unable to reconcile the Testnet withdrawal safely."
      );
    }
  }
);

/* ============================================================
   OPERATIONAL DIAGNOSTICS
   ============================================================ */

app.get(
  "/test-supabase",
  requireAdmin,
  async (req, res) => {
    try {
      const {
        data,
        error
      } = await supabase
        .from("projects")
        .select(
          "id,project_code,name,network,status"
        )
        .eq(
          "network",
          "testnet"
        )
        .limit(1);

      if (error) {
        return jsonError(
          res,
          500,
          "SUPABASE_TEST_FAILED",
          error.message
        );
      }

      return res.json({
        success: true,
        network: "testnet",
        rows:
          data || []
      });
    } catch (error) {
      return jsonError(
        res,
        500,
        "SUPABASE_TEST_FAILED",
        error.message
      );
    }
  }
);

app.get(
  "/test-stellar",
  requireAdmin,
  async (req, res) => {
    try {
      const publicKey =
        clean(
          process.env
            .TESTNET_WALLET_PUBLIC_KEY
        );

      if (!publicKey) {
        return jsonError(
          res,
          500,
          "WALLET_PUBLIC_KEY_NOT_CONFIGURED",
          "TESTNET_WALLET_PUBLIC_KEY is required."
        );
      }

      const account =
        await server.loadAccount(
          publicKey
        );

      return res.json({
        success: true,
        network: "testnet",
        publicKey,
        sequence:
          account.sequence
      });
    } catch (error) {
      return jsonError(
        res,
        502,
        "STELLAR_TEST_FAILED",
        error.message
      );
    }
  }
);

app.get(
  "/test-wallet",
  requireAdmin,
  (req, res) => {
    try {
      const keypair =
        payoutWalletKeypair();

      return res.json({
        success: true,
        network: "testnet",

        publicKey:
          keypair.publicKey()
      });
    } catch (error) {
      return jsonError(
        res,
        500,
        "WALLET_TEST_FAILED",
        "Testnet payout wallet is not configured or is invalid."
      );
    }
  }
);

/* ============================================================
   404
   ============================================================ */

app.use(
  (req, res) => {
    return res
      .status(404)
      .json({
        success: false,
        error: "NOT_FOUND"
      });
  }
);

/* ============================================================
   GLOBAL ERROR HANDLER
   ============================================================ */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "[API]",
      error
    );

    if (
      error?.message ===
      "CORS_ORIGIN_NOT_ALLOWED"
    ) {
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
  }
);

/* ============================================================
   START
   ============================================================ */

app.listen(
  PORT,
  () => {
    console.log(
      `ALBUKHR TESTNET API running on port ${PORT}`
    );
  }
);
