/*
ALBUKHR TESTNET API — Withdrawal Integration Patch v1

Target repository:
MuhmdBuharisaeed/test-albukhr-api

Apply this patch to server.js. It is intentionally separated from the existing
API so the current payment approval/completion and diagnostic endpoints remain
unchanged.

1) Add these constants after TESTNET_ADMIN_API_KEY:
*/
const TESTNET_WITHDRAWAL_MEMO_PREFIX = "ALB-";
const TESTNET_WITHDRAWAL_RECONCILE_LIMIT = Math.min(
  200,
  Math.max(20, Number(process.env.TESTNET_WITHDRAWAL_RECONCILE_LIMIT || 100))
);

/*
2) Add these helpers before function assertPiConfig():
*/
function withdrawalMemo(requestId) {
  return TESTNET_WITHDRAWAL_MEMO_PREFIX + sha256Hex(requestId).slice(0, 24);
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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

  const amount = numeric(requestRow.net_amount ?? requestRow.requested_amount);
  if (amount === null || amount <= 0) throw new Error("INVALID_AMOUNT");

  const sourceKeypair = payoutWalletKeypair();
  const sourcePublicKey = sourceKeypair.publicKey();
  const memoText = withdrawalMemo(requestRow.id);

  /*
   * Reconcile before submitting. If a previous attempt reached the Pi
   * Testnet but the API failed before saving txid, the same request is
   * recognized and a second payment is not created.
   */
  const existing = await findTestnetPayoutByMemo(sourcePublicKey, memoText);

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
    throw new Error("WITHDRAW_CREATE_FAILED:No withdrawal request was returned.");
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

/*
3) Replace the old admin-only POST /withdraw endpoint with this
session-authenticated investor endpoint:
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

    if (!stakeId || !["reward", "capital"].includes(withdrawalType)) {
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
        "The withdrawal request was created but could not be claimed for payout. Use reconciliation before retrying."
      );
    }

    const payout = await submitTestnetWithdrawalPayout(created.request);
    const completed = await markWithdrawalCompleted(
      created.request.id,
      payout.txid
    );

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

    if (message.startsWith("PAYOUT_RECORDED_FAILED:")) {
      return jsonError(
        res,
        502,
        "PAYOUT_RECORDED_FAILED",
        "The Testnet payout was submitted, but its database status could not be recorded. Reconciliation is required."
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

/*
4) Add this admin lookup endpoint:
*/
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
5) Replace the old /pay-withdraw body with this reconciliation-safe version:
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

    if (!["approved", "processing"].includes(requestRow.status)) {
      if (requestRow.status === "completed") {
        return res.json({
          success: true,
          network: "testnet",
          payout: "already_completed",
          txid: requestRow.txid,
          request: requestRow
        });
      }

      return jsonError(
        res,
        400,
        "REQUEST_NOT_PAYABLE",
        "Withdrawal request must be approved or processing."
      );
    }

    const payout = await submitTestnetWithdrawalPayout(requestRow);
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
6) Add this admin reconciliation endpoint:
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
