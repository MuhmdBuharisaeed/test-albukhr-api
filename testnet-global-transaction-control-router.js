const express = require("express");
const crypto = require("crypto");

/*
 * ALBUKHR TESTNET GLOBAL TRANSACTION CONTROL ROUTER v1
 * Testnet only. Super Admin only. All writes are delegated to one guarded
 * PostgreSQL RPC; the browser never writes directly to Supabase.
 */
function createTestnetGlobalTransactionControlRouter({
  supabase,
  piApiKey,
  piTestnetAppWallet = "",
  payoutWalletConfigured = false
}) {
  if (!supabase) throw new Error("SUPABASE_CLIENT_REQUIRED");

  const router = express.Router();
  const NETWORK = "testnet";
  const APP_WALLET = clean(piTestnetAppWallet);
  const PI_API_CONFIGURED = Boolean(clean(piApiKey));
  const PAYOUT_WALLET_CONFIGURED = payoutWalletConfigured === true;

  function clean(value) {
    return String(value == null ? "" : value).trim();
  }

  function numeric(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Use the database coverage function as the source of truth for eligibility.
   * In particular, do not require owner_liquidity_available alone to equal
   * the full minimum project liquidity: verified reward reserve may be part
   * of the liquidity buffer, as defined by get_testnet_staking_coverage().
   * Missing numeric fields fail closed.
   */
  function isStakingCoverageReady(
    coverage,
    minimumProjectLiquidity,
    requiredLiquidity,
    reserveCoveragePercent
  ) {
    if (!coverage || coverage.staking_eligible !== true) return false;

    function requiredNumber(value) {
      if (value === null || value === undefined || clean(value) === "") {
        return null;
      }
      return numeric(value);
    }

    const minimum = requiredNumber(minimumProjectLiquidity);
    const required = requiredNumber(requiredLiquidity);
    const buffer = requiredNumber(coverage.liquidity_buffer);
    const verified = requiredNumber(coverage.verified_liquidity_contributed);
    const assets = requiredNumber(coverage.total_tracked_assets);
    const liabilities = requiredNumber(coverage.total_liability);
    const reserve = requiredNumber(coverage.reward_reserve_balance);
    const outstandingRewards = requiredNumber(coverage.outstanding_rewards);
    const reservePercent = requiredNumber(reserveCoveragePercent);

    if ([
      minimum,
      required,
      buffer,
      verified,
      assets,
      liabilities,
      reserve,
      outstandingRewards,
      reservePercent
    ].some((value) => value === null)) {
      return false;
    }

    return (
      buffer >= minimum &&
      verified >= required &&
      assets >= liabilities &&
      reserve >= outstandingRewards * reservePercent / 100
    );
  }

  function hashToken(token) {
    return crypto.createHash("sha256").update(token, "utf8").digest("hex");
  }

  function sendError(res, error) {
    const code = clean(error && error.message) || "GLOBAL_TRANSACTION_CONTROL_FAILED";
    const statuses = {
      TESTNET_ADMIN_SESSION_REQUIRED: 401,
      TESTNET_ADMIN_SESSION_INVALID: 401,
      TESTNET_ADMIN_SESSION_REVOKED: 401,
      TESTNET_ADMIN_SESSION_EXPIRED: 401,
      TESTNET_ADMIN_SESSION_LOOKUP_FAILED: 500,
      GLOBAL_TRANSACTION_CONTROL_SUPER_ADMIN_REQUIRED: 403,
      GLOBAL_TRANSACTION_CONTROL_FIELDS_REQUIRED: 400,
      GLOBAL_TRANSACTION_CONTROL_REASON_REQUIRED: 400,
      GLOBAL_TREASURY_NOT_READY: 409,
      GLOBAL_STAKING_NOT_READY: 409,
      GLOBAL_STAKING_MUST_BE_PAUSED_BEFORE_TREASURY: 409,
      GLOBAL_TREASURY_OUTSTANDING_OBLIGATIONS: 409,
      GLOBAL_TREASURY_CONFIGURATION_INCOMPLETE: 409,
      GLOBAL_TREASURY_WALLET_MISMATCH: 409,
      GLOBAL_TREASURY_PAYMENT_RAILS_NOT_READY: 409,
      GLOBAL_TREASURY_PAYOUT_WALLET_NOT_READY: 409,
      GLOBAL_STAKING_POLICY_CONFIGURATION_INCOMPLETE: 409,
      GLOBAL_STAKING_PROJECT_NOT_READY: 409,
      GLOBAL_STAKING_PENDING_INTENTS_EXIST: 409,
      GLOBAL_STAKING_DEPLOYMENT_GUARD_MISSING: 409,
      TESTNET_STAKING_MAX_DEPLOYMENT_EXCEEDED: 409,
      GLOBAL_TRANSACTION_CONTROL_RPC_FAILED: 500,
      GLOBAL_TRANSACTION_CONTROL_STATUS_READ_FAILED: 500
    };
    const messages = {
      TESTNET_ADMIN_SESSION_REQUIRED: "A valid Testnet Super Admin session is required.",
      TESTNET_ADMIN_SESSION_INVALID: "The Testnet admin session is invalid.",
      TESTNET_ADMIN_SESSION_REVOKED: "The Testnet admin session has been revoked.",
      TESTNET_ADMIN_SESSION_EXPIRED: "The Testnet admin session has expired.",
      GLOBAL_TRANSACTION_CONTROL_SUPER_ADMIN_REQUIRED: "Only a Testnet Super Admin may change global transaction controls.",
      GLOBAL_TRANSACTION_CONTROL_REASON_REQUIRED: "Enter an audit reason between 10 and 500 characters.",
      GLOBAL_TREASURY_NOT_READY: "Global Treasury preflight checks have not passed.",
      GLOBAL_STAKING_NOT_READY: "Global Staking preflight checks have not passed. Activate Treasury first and resolve the listed blockers.",
      GLOBAL_STAKING_MUST_BE_PAUSED_BEFORE_TREASURY: "Pause Global Staking before deactivating Global Treasury.",
      GLOBAL_TREASURY_OUTSTANDING_OBLIGATIONS: "Global Treasury cannot be paused while stake principal, rewards, pending payment intents or withdrawals remain outstanding. Settle all Testnet obligations first.",
      GLOBAL_TREASURY_CONFIGURATION_INCOMPLETE: "Global Treasury configuration is incomplete.",
      GLOBAL_TREASURY_WALLET_MISMATCH: "The configured Testnet treasury wallet does not match the API Testnet app wallet.",
      GLOBAL_TREASURY_PAYMENT_RAILS_NOT_READY: "Pi API configuration or fee ledger tables are not ready.",
      GLOBAL_TREASURY_PAYOUT_WALLET_NOT_READY: "The Testnet payout keypair is missing, invalid, or does not match PI_TESTNET_APP_WALLET. Treasury activation is blocked.",
      GLOBAL_STAKING_POLICY_CONFIGURATION_INCOMPLETE: "The approved Universal Risk Policy or reward schedule is incomplete or inconsistent.",
      GLOBAL_STAKING_PROJECT_NOT_READY: "No approved, enabled Testnet project currently passes the staking offer and coverage preflight.",
      GLOBAL_STAKING_PENDING_INTENTS_EXIST: "Resolve pending Testnet stake-payment intents before activating Global Staking.",
      GLOBAL_STAKING_DEPLOYMENT_GUARD_MISSING: "The database maximum-deployment guard is missing or disabled. Global Staking remains blocked.",
      TESTNET_STAKING_MAX_DEPLOYMENT_EXCEEDED: "The requested stake would exceed the approved Universal Risk maximum-deployment percentage."
    };
    return res.status(statuses[code] || Number(error && error.status) || 500).json({
      success: false,
      network: NETWORK,
      error: code,
      message: messages[code] || "The global Testnet control request failed. Review the current configuration and try again."
    });
  }

  async function getSuperAdmin(req) {
    const token = clean(req.get("x-testnet-admin-session"));
    if (!token) throw new Error("TESTNET_ADMIN_SESSION_REQUIRED");

    const { data, error } = await supabase
      .from("testnet_admin_sessions")
      .select("id,admin_user_id,email,roles,network,expires_at,revoked_at")
      .eq("session_hash", hashToken(token))
      .eq("network", NETWORK)
      .maybeSingle();

    if (error) throw new Error("TESTNET_ADMIN_SESSION_LOOKUP_FAILED");
    if (!data) throw new Error("TESTNET_ADMIN_SESSION_INVALID");
    if (data.revoked_at) throw new Error("TESTNET_ADMIN_SESSION_REVOKED");
    if (!data.expires_at || new Date(data.expires_at).getTime() <= Date.now()) {
      throw new Error("TESTNET_ADMIN_SESSION_EXPIRED");
    }

    const roles = Array.isArray(data.roles) ? data.roles.map(clean) : [];
    if (!roles.includes("super_admin")) {
      throw new Error("GLOBAL_TRANSACTION_CONTROL_SUPER_ADMIN_REQUIRED");
    }
    return { ...data, roles };
  }

  function pushCheck(checks, key, label, ok, detail) {
    checks.push({ key, label, ready: Boolean(ok), detail: clean(detail) });
  }

  async function readStatus() {
    const { data: policy, error: policyError } = await supabase
      .from("testnet_global_treasury_policy")
      .select(
        "singleton_id,network,policy_version,active,minimum_project_liquidity," +
        "fee_tier_size,fee_per_tier,sub_tier_fee_free_count," +
        "sub_tier_fee_after_quota,minimum_staker_withdrawal,business_day_timezone," +
        "allowed_duration_days,staking_policy_version,staking_policy_active," +
        "staking_minimum_stake_amount,staking_reward_rates_by_duration," +
        "staking_reward_reserve_coverage_percent," +
        "staking_universal_risk_policy,treasury_wallet"
      )
      .eq("singleton_id", 1)
      .eq("network", NETWORK)
      .maybeSingle();

    if (policyError || !policy) throw new Error("GLOBAL_TRANSACTION_CONTROL_STATUS_READ_FAILED");

    const treasuryChecks = [];
    const treasuryWalletConfigured = Boolean(clean(policy.treasury_wallet));
    const treasuryWalletMatches = treasuryWalletConfigured && Boolean(APP_WALLET) && clean(policy.treasury_wallet) === APP_WALLET;
    const treasuryApiReady = PI_API_CONFIGURED && Boolean(APP_WALLET);
    const feeConfigReady =
      numeric(policy.minimum_project_liquidity) >= 100 &&
      numeric(policy.fee_tier_size) > 0 &&
      numeric(policy.fee_per_tier) >= 0 &&
      Number.isInteger(Number(policy.sub_tier_fee_free_count)) &&
      Number(policy.sub_tier_fee_free_count) >= 0 &&
      numeric(policy.sub_tier_fee_after_quota) >= 0 &&
      numeric(policy.minimum_staker_withdrawal) >= 0 &&
      clean(policy.business_day_timezone) === "Africa/Lagos";

    const [assessmentProbe, feeLedgerProbe, activeTreasuries] = await Promise.all([
      supabase.from("testnet_outflow_fee_assessments").select("id").limit(1),
      supabase.from("testnet_platform_fee_ledger").select("id").limit(1),
      supabase.from("project_treasury")
        .select("project_id,treasury_wallet,required_liquidity,verified_liquidity,status")
        .eq("network", NETWORK)
        .eq("status", "active")
    ]);

    const feeTablesReady = !assessmentProbe.error && !feeLedgerProbe.error;
    const activeRows = Array.isArray(activeTreasuries.data)
  ? activeTreasuries.data
  : [];

const activeProjectIds = [
  ...new Set(
    activeRows
      .map((row) => clean(row.project_id))
      .filter(Boolean)
  ),
];

const approvedProjectResult = activeProjectIds.length
  ? await supabase
      .from("projects")
      .select("id")
      .eq("network", NETWORK)
      .eq("status", "approved")
      .in("id", activeProjectIds)
  : { data: [], error: null };

if (approvedProjectResult.error) {
  throw new Error("GLOBAL_TRANSACTION_CONTROL_STATUS_READ_FAILED");
}

const approvedProjectIds = new Set(
  (approvedProjectResult.data || []).map((row) => clean(row.id))
);

const treasuryCoverageResults = await Promise.all(
  activeRows
    .filter((row) => approvedProjectIds.has(clean(row.project_id)))
    .map(async (row) => {
      const { data, error } = await supabase.rpc(
        "get_testnet_staking_coverage",
        { p_project_id: row.project_id }
      );

      if (error) {
        throw new Error("GLOBAL_TRANSACTION_CONTROL_STATUS_READ_FAILED");
      }

      const coverage = Array.isArray(data) ? data[0] : data;

      return { row, coverage };
    })
);

const activeTreasuriesReady =
  !activeTreasuries.error &&
  activeRows.length > 0 &&
  activeRows.every(
    (row) =>
      clean(row.treasury_wallet) === clean(policy.treasury_wallet)
  ) &&
  treasuryCoverageResults.some(({ row, coverage }) => {
    const required = numeric(row.required_liquidity);
    const summaryVerified = numeric(row.verified_liquidity);
    const ledgerVerified = numeric(
      coverage && coverage.verified_liquidity_contributed
    );

    return (
      required !== null &&
      summaryVerified !== null &&
      ledgerVerified !== null &&
      required >= numeric(policy.minimum_project_liquidity) &&
      summaryVerified >= required &&
      ledgerVerified >= required
    );
  });

    pushCheck(treasuryChecks, "pi_api", "Pi Testnet API and app wallet", treasuryApiReady,
      treasuryApiReady ? "API key and Testnet app wallet are configured." : "PI_API_KEY or PI_TESTNET_APP_WALLET is missing.");
    pushCheck(treasuryChecks, "payout_wallet", "Testnet payout wallet secret is configured and valid", PAYOUT_WALLET_CONFIGURED,
      PAYOUT_WALLET_CONFIGURED ? "The server validated the Testnet payout keypair without exposing its secret." : "WALLET_PRIVATE_SEED is missing, invalid, or does not match PI_TESTNET_APP_WALLET; withdrawals cannot be safely paid.");
    pushCheck(treasuryChecks, "wallet_match", "Global treasury wallet matches Testnet app wallet", treasuryWalletMatches,
      treasuryWalletMatches ? "Configured wallet matches." : "Wallet is missing or does not match the API destination.");
    pushCheck(treasuryChecks, "fee_config", "Global liquidity and fee configuration", feeConfigReady,
      feeConfigReady ? "Fee schedule and Lagos business-day settings are populated." : "One or more fee/liquidity settings are incomplete.");
    pushCheck(treasuryChecks, "fee_tables", "Outflow fee assessment and ledger tables", feeTablesReady,
      feeTablesReady ? "Both Testnet fee tables are accessible." : "A required Testnet fee table is unavailable.");
    pushCheck(treasuryChecks, "project_treasuries", "Active project treasuries match global wallet", activeTreasuriesReady,
      activeTreasuriesReady ? activeRows.length + " active Testnet treasury row(s) match." : "At least one active project treasury must match and meet its liquidity target.");

    const treasuryReady = treasuryChecks.every((item) => item.ready);

    const stakingChecks = [];
    const expectedRisk = { capital_reserve_percent: 50, maximum_deployment_percent: 25, max_active_principal: 100 };
    const actualRisk = policy.staking_universal_risk_policy || {};
    const riskConfigReady =
      Number(actualRisk.capital_reserve_percent) === expectedRisk.capital_reserve_percent &&
      Number(actualRisk.maximum_deployment_percent) === expectedRisk.maximum_deployment_percent &&
      Number(actualRisk.max_active_principal) === expectedRisk.max_active_principal;
    const expectedDurations = [30, 90, 180, 365, 730, 1095];
    const actualDurations = Array.isArray(policy.allowed_duration_days) ? policy.allowed_duration_days.map(Number) : [];
    const durationsReady = actualDurations.length === expectedDurations.length && expectedDurations.every((duration) => actualDurations.includes(duration));
    const rewardRates = policy.staking_reward_rates_by_duration || {};
    const expectedRates = { "30": 0.01, "90": 0.03, "180": 0.06, "365": 0.12, "730": 0.24, "1095": 0.36 };
    const ratesReady = Object.keys(expectedRates).every((duration) => Number(rewardRates[duration]) === expectedRates[duration]);
    const stagePolicyReady = policy.staking_stage_policies && typeof policy.staking_stage_policies === "object" && !Array.isArray(policy.staking_stage_policies) && Object.keys(policy.staking_stage_policies).length > 0;
    const stakingConfigReady =
  riskConfigReady &&
  durationsReady &&
  ratesReady &&
  numeric(policy.staking_minimum_stake_amount) >= 10 &&
  numeric(policy.staking_reward_reserve_coverage_percent) >= 100 &&
  numeric(policy.minimum_project_liquidity) >= 100;

    const [pendingIntentResult, deploymentGuardProbe] = await Promise.all([
      supabase.from("testnet_stake_intents")
        .select("id", { count: "exact", head: true })
        .eq("network", NETWORK)
        .eq("status", "pending_payment"),
      supabase.rpc("testnet_global_transaction_control_guard_status")
    ]);
    if (pendingIntentResult.error) throw new Error("GLOBAL_TRANSACTION_CONTROL_STATUS_READ_FAILED");
    const pendingIntentCount = pendingIntentResult.count;
    const deploymentGuardReady = !deploymentGuardProbe.error && deploymentGuardProbe.data === true;

    const { data: controls, error: controlsError } = await supabase
      .from("project_staking_risk_controls")
      .select("project_id,project_code,staking_enabled,approval_status,minimum_liquidity,capital_reserve_percent,maximum_deployment_percent,max_reward_rate,max_active_principal,reward_reserve_coverage_percent")
      .eq("network", NETWORK)
      .eq("staking_enabled", true)
      .eq("approval_status", "approved");
    if (controlsError) throw new Error("GLOBAL_TRANSACTION_CONTROL_STATUS_READ_FAILED");

    const controlRows = Array.isArray(controls) ? controls : [];
    const projectIds = controlRows.map((row) => clean(row.project_id)).filter(Boolean);
    const projectCodes = controlRows.map((row) => clean(row.project_code)).filter(Boolean);
    let projects = [];
    let treasuries = [];
    let offers = [];

    if (projectIds.length) {
      const [projectResult, treasuryResult, offerResult] = await Promise.all([
        supabase.from("projects").select("id,project_code,name,status,network").eq("network", NETWORK).eq("status", "approved").in("id", projectIds),
        supabase.from("project_treasury").select("project_id,status,required_liquidity,verified_liquidity,treasury_wallet").eq("network", NETWORK).in("project_id", projectIds),
        supabase.from("project_staking_terms").select("project_code,duration_days,min_stake,reward_rate,active,network").eq("network", NETWORK).eq("active", true).in("project_code", projectCodes)
      ]);
      if (projectResult.error || treasuryResult.error || offerResult.error) throw new Error("GLOBAL_TRANSACTION_CONTROL_STATUS_READ_FAILED");
      projects = projectResult.data || [];
      treasuries = treasuryResult.data || [];
      offers = offerResult.data || [];
    }

    const maxGlobalReward = Math.max.apply(null, Object.keys(expectedRates).map((key) => Number(rewardRates[key]) || 0));
    let readyProjectCount = 0;
    const readyProjects = [];
    for (const project of projects) {
      const control = controlRows.find((row) => clean(row.project_id) === clean(project.id));
      const treasury = treasuries.find((row) => clean(row.project_id) === clean(project.id));
      if (!control || !treasury) continue;

      const riskMatches =
        Number(control.minimum_liquidity) >= Number(policy.minimum_project_liquidity) &&
        Number(control.capital_reserve_percent) === 50 &&
        Number(control.maximum_deployment_percent) === 25 &&
        Number(control.max_active_principal) === 100 &&
        Number(control.max_reward_rate) === maxGlobalReward &&
        Number(control.reward_reserve_coverage_percent) >= Number(policy.staking_reward_reserve_coverage_percent);
      const treasuryMatches = treasury.status === "active" &&
        clean(treasury.treasury_wallet) === APP_WALLET &&
        numeric(treasury.required_liquidity) >= Number(policy.minimum_project_liquidity) &&
        numeric(treasury.verified_liquidity) >= numeric(treasury.required_liquidity);
      const hasOffer = offers.some((offer) =>
        clean(offer.project_code) === clean(project.project_code) &&
        expectedDurations.includes(Number(offer.duration_days)) &&
        Number(offer.min_stake) >= Number(policy.staking_minimum_stake_amount) &&
        Number(offer.reward_rate) > 0 &&
        Number(offer.reward_rate) <= Number(rewardRates[String(offer.duration_days)])
      );
      const { data: coverageData, error: coverageError } = await supabase.rpc(
        "get_testnet_staking_coverage",
        { p_project_id: project.id }
      );
      if (coverageError) throw new Error("GLOBAL_TRANSACTION_CONTROL_STATUS_READ_FAILED");
      const coverage = Array.isArray(coverageData) ? coverageData[0] : coverageData;
      const coverageReady = isStakingCoverageReady(
        coverage,
        policy.minimum_project_liquidity,
        treasury.required_liquidity,
        policy.staking_reward_reserve_coverage_percent
      );
      const noProjectPending = Number(pendingIntentCount || 0) === 0;

      if (riskMatches && treasuryMatches && hasOffer && coverageReady && noProjectPending) {
        readyProjectCount += 1;
        readyProjects.push({ project_code: project.project_code, name: project.name });
      }
    }

    pushCheck(stakingChecks, "treasury_active", "Global Treasury is active", policy.active === true,
      policy.active === true ? "Global Treasury is active." : "Activate Global Treasury first.");
    pushCheck(stakingChecks, "staking_config", "Universal Risk, durations and reward caps", stakingConfigReady,
      stakingConfigReady ? "Approved Universal Risk limits and reward schedule are configured." : "Universal Risk, duration, minimum stake or reward configuration needs review.");
    pushCheck(stakingChecks, "deployment_guard", "Database enforces the 25% maximum-deployment cap", deploymentGuardReady,
      deploymentGuardReady ? "The Testnet stake-intent database guard is installed and enabled." : "The database deployment guard is missing, disabled or not yet migrated.");
    pushCheck(stakingChecks, "ready_project", "At least one approved project passes staking readiness", readyProjectCount > 0,
      readyProjectCount > 0 ? readyProjectCount + " eligible project(s): " + readyProjects.map((p) => p.project_code).join(", ") : "No project currently passes risk, liquidity, offer and coverage checks.");
    pushCheck(stakingChecks, "pending_intents", "No unresolved stake-payment intents", Number(pendingIntentCount || 0) === 0,
      Number(pendingIntentCount || 0) === 0 ? "No pending Testnet stake intents." : Number(pendingIntentCount || 0) + " pending intent(s) need reconciliation.");

    const stakingReady = treasuryReady && policy.active === true && stakingConfigReady && deploymentGuardReady && readyProjectCount > 0 && Number(pendingIntentCount || 0) === 0;

    const { data: auditRows, error: auditError } = await supabase
      .from("testnet_global_transaction_control_audit")
      .select("id,control,action,previous_enabled,enabled,reason,admin_email,created_at")
      .eq("network", NETWORK)
      .order("created_at", { ascending: false })
      .limit(8);
    if (auditError) throw new Error("GLOBAL_TRANSACTION_CONTROL_STATUS_READ_FAILED");

    return {
      success: true,
      network: NETWORK,
      policy: {
        treasury_active: policy.active === true,
        staking_policy_active: policy.staking_policy_active === true,
        policy_version: policy.policy_version,
        staking_policy_version: policy.staking_policy_version
      },
      treasury: {
        ready: treasuryReady,
        can_enable: treasuryReady && policy.active !== true,
        can_disable: policy.active === true && policy.staking_policy_active !== true,
        checks: treasuryChecks
      },
      staking: {
        ready: stakingReady,
        can_enable: stakingReady && policy.staking_policy_active !== true,
        can_disable: policy.staking_policy_active === true,
        ready_project_count: readyProjectCount,
        checks: stakingChecks
      },
      audit: auditRows || []
    };
  }

  router.post("/admin/global-controls", async (req, res) => {
    try {
      await getSuperAdmin(req);
      return res.json(await readStatus());
    } catch (error) {
      console.error("[TESTNET GLOBAL CONTROL STATUS]", clean(error && error.message));
      return sendError(res, error);
    }
  });

  router.post("/admin/global-controls/enablement", async (req, res) => {
    try {
      const admin = await getSuperAdmin(req);
      const control = clean(req.body && req.body.control).toLowerCase();
      const enabled = req.body && req.body.enabled;
      const reason = clean(req.body && req.body.reason);

      if (!["treasury", "staking"].includes(control) || typeof enabled !== "boolean") {
        throw new Error("GLOBAL_TRANSACTION_CONTROL_FIELDS_REQUIRED");
      }
      if (reason.length < 10 || reason.length > 500) {
        throw new Error("GLOBAL_TRANSACTION_CONTROL_REASON_REQUIRED");
      }

      const status = await readStatus();
      if (enabled && control === "treasury" && !status.treasury.ready) {
        throw new Error("GLOBAL_TREASURY_NOT_READY");
      }
      if (enabled && control === "staking" && !status.staking.ready) {
        throw new Error("GLOBAL_STAKING_NOT_READY");
      }
      if (!enabled && control === "treasury" && status.policy.staking_policy_active) {
        throw new Error("GLOBAL_STAKING_MUST_BE_PAUSED_BEFORE_TREASURY");
      }

      const { data, error } = await supabase.rpc("set_testnet_global_transaction_control", {
        p_admin_session_id: admin.id,
        p_control: control,
        p_enabled: enabled,
        p_reason: reason,
        p_pi_testnet_app_wallet: APP_WALLET || null,
        p_pi_api_configured: PI_API_CONFIGURED,
        p_payout_wallet_configured: PAYOUT_WALLET_CONFIGURED
      });

      if (error || !data || data.success !== true) {
        console.error("[TESTNET GLOBAL CONTROL RPC]", clean(error && error.message));
        const message = clean(error && error.message);
        const known = [
          "GLOBAL_TREASURY_CONFIGURATION_INCOMPLETE",
          "GLOBAL_TREASURY_WALLET_MISMATCH",
          "GLOBAL_TREASURY_PAYMENT_RAILS_NOT_READY",
          "GLOBAL_TREASURY_PAYOUT_WALLET_NOT_READY",
          "GLOBAL_STAKING_POLICY_CONFIGURATION_INCOMPLETE",
          "GLOBAL_STAKING_PROJECT_NOT_READY",
          "GLOBAL_STAKING_PENDING_INTENTS_EXIST",
          "GLOBAL_STAKING_DEPLOYMENT_GUARD_MISSING",
          "TESTNET_STAKING_MAX_DEPLOYMENT_EXCEEDED",
          "GLOBAL_STAKING_MUST_BE_PAUSED_BEFORE_TREASURY",
          "GLOBAL_TREASURY_OUTSTANDING_OBLIGATIONS"
        ];
        const code = known.find((item) => message.includes(item));
        const wrapped = new Error(code || "GLOBAL_TRANSACTION_CONTROL_RPC_FAILED");
        return sendError(res, wrapped);
      }

      return res.json({
        success: true,
        network: NETWORK,
        result: data,
        status: await readStatus()
      });
    } catch (error) {
      console.error("[TESTNET GLOBAL CONTROL ENABLEMENT]", clean(error && error.message));
      return sendError(res, error);
    }
  });

  return router;
}

module.exports = createTestnetGlobalTransactionControlRouter;
