Testnet API Integration Patch — server.js
Target repository: MuhmdBuharisaeed/test-albukhr-api Target file: server.js (over 1,000 lines; patch only, do not replace the file) Reviewed source SHA: 2e79720f63abf28492233d6c33847947d3f5c573
This patch has not been committed to GitHub or deployed to Render. Apply only if a fresh fetch confirms the source anchors and SHA still match. The current GitHub integration returned HTTP 403 for branch creation; do not work around that by pushing to main.
Patch A — import the router
Find this exact block near the top of server.js:
const createTestnetStakingRouter =
  require("./testnet-staking-router");

const app = express();
Replace it with:
const createTestnetStakingRouter =
  require("./testnet-staking-router");

const createTestnetOutflowFeeRouter =
  require("./testnet-outflow-fee-router");

const app = express();
Copy test-albukhr-api/testnet-outflow-fee-router.js from this package to the root of the API repository beside server.js and testnet-staking-router.js.
Patch B — mount only on Testnet API
Find the existing /staking mount exactly:
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
Immediately after that block and before /* UTILITIES */, insert:
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
    markWithdrawalCompleted
  })
);
This mounts these endpoints (it does not enable the inactive Treasury policy):
POST /outflow-fee/withdrawal/prepare
POST /outflow-fee/withdrawal/assess
POST /outflow-fee/owner/prepare-payment
POST /outflow-fee/approve
POST /outflow-fee/complete
POST /outflow-fee/cancel
POST /outflow-fee/withdrawal/execute
Patch C — fee preflight before existing admin payout
In the existing app.post("/pay-withdraw", ...) route, find this exact anchor:
      // Atomic compare-and-set: among concurrent requests, only one can
      // change this row from approved to processing and proceed to Horizon.
      const claim = await supabase
Insert the following immediately before that anchor, after the withdrawal has been fetched and checked as approved:
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
Do not move this check after the claim call or after submitTestnetWithdrawalPayout(). Preserve the existing compare-and-set and deterministic memo reconciliation logic.
Preserve release locks
Keep the existing /withdraw route's HTTP 423 TESTNET_WITHDRAWALS_LOCKED return.
Do not set testnet_global_treasury_policy.active = true.
Do not load the new client into investor.html or change Dock Navigation.
Do not enable Render auto-deploy or trigger a deployment.
After reviewed integration, run from the API repository root:
node --check server.js
node --check testnet-outflow-fee-router.js
Also run the bundled mock test. These tests do not replace a controlled Pi Testnet end-to-end test.
