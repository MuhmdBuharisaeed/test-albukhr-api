BEGIN;

-- Testnet-only audit trail for global treasury/staking activation changes.

-- Enforce the Universal Risk maximum-deployment percentage at the database boundary.
-- The existing intent RPC records this percentage but did not enforce it against
-- tracked assets. This trigger also protects service-role inserts that bypass the
-- application-level route. It intentionally does not allocate or move funds.
CREATE OR REPLACE FUNCTION public.guard_testnet_stake_intent_universal_deployment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_project public.projects%ROWTYPE;
  v_policy public.testnet_global_treasury_policy%ROWTYPE;
  v_controls public.project_staking_risk_controls%ROWTYPE;
  v_coverage record;
  v_reserve_percent numeric;
  v_deployment_percent numeric;
  v_max_principal numeric;
  v_deployment_limit numeric;
  v_reward_cap numeric;
  v_treasury public.project_treasury%ROWTYPE;
  v_existing_principal numeric;
  v_existing_liability numeric;
  v_new_amount numeric := round(coalesce(NEW.amount, 0)::numeric, 7);
  v_new_reward numeric := round(coalesce(NEW.reward_amount, 0)::numeric, 7);
  v_old_amount numeric := 0;
  v_old_reward numeric := 0;
BEGIN
  IF NEW.network IS DISTINCT FROM 'testnet' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'TESTNET_STAKE_INTENT_NETWORK_INVALID';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.project_code IS DISTINCT FROM NEW.project_code
    OR OLD.network IS DISTINCT FROM NEW.network
  ) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'TESTNET_STAKE_INTENT_IDENTITY_IMMUTABLE';
  END IF;

  IF NEW.project_id IS NULL OR v_new_amount <= 0 OR v_new_reward < 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'TESTNET_STAKE_INTENT_AMOUNT_INVALID';
  END IF;

  -- Serialize all intent writes for one project, including direct service-role inserts.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('albukhr:testnet:staking:' || NEW.project_id::text, 0)
  );

  SELECT * INTO v_project
  FROM public.projects
  WHERE id = NEW.project_id
    AND project_code = NEW.project_code
    AND network = 'testnet'
    AND status = 'approved'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'PROJECT_NOT_APPROVED_FOR_TESTNET_STAKING';
  END IF;

  SELECT * INTO v_policy
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1 AND network = 'testnet'
  FOR SHARE;

  IF NOT FOUND OR v_policy.active IS DISTINCT FROM true
     OR v_policy.staking_policy_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_STAKING_POLICY_INACTIVE';
  END IF;

  IF NEW.duration_days IS NULL
     OR coalesce(NEW.duration_days = ANY(v_policy.allowed_duration_days), false) IS NOT TRUE
     OR coalesce(v_new_amount, 0) < coalesce(v_policy.staking_minimum_stake_amount, 0) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKING_DURATION_OR_MINIMUM_NOT_ALLOWED';
  END IF;

  v_reward_cap := nullif(v_policy.staking_reward_rates_by_duration ->> NEW.duration_days::text, '')::numeric;
  IF v_reward_cap IS NULL OR NEW.reward_rate IS NULL
     OR NEW.reward_rate <= 0
     OR NEW.reward_rate > v_reward_cap THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKING_REWARD_RATE_EXCEEDS_ALBUKHR_LIMIT';
  END IF;

  SELECT * INTO v_controls
  FROM public.project_staking_risk_controls
  WHERE project_id = NEW.project_id AND network = 'testnet'
  FOR SHARE;

  IF NOT FOUND
     OR v_controls.staking_enabled IS DISTINCT FROM true
     OR v_controls.approval_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'STAKING_NOT_ENABLED_OR_NOT_APPROVED';
  END IF;

  IF v_controls.minimum_liquidity IS NULL
     OR v_controls.capital_reserve_percent IS NULL
     OR v_controls.maximum_deployment_percent IS NULL
     OR v_controls.max_reward_rate IS NULL
     OR v_controls.max_active_principal IS NULL
     OR v_controls.reward_reserve_coverage_percent IS NULL THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'PROJECT_STAKING_RISK_LIMITS_NOT_CONFIGURED';
  END IF;

  IF NEW.reward_rate > coalesce(v_controls.max_reward_rate, 0)
     OR round(v_new_amount * NEW.reward_rate, 7) IS DISTINCT FROM v_new_reward THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKING_REWARD_RATE_OR_AMOUNT_INVALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.project_staking_terms o
    WHERE o.project_code = NEW.project_code
      AND o.network = 'testnet'
      AND o.duration_days = NEW.duration_days
      AND o.active IS TRUE
      AND NEW.amount >= o.min_stake
      AND NEW.reward_rate = o.reward_rate
  ) THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'STAKING_OFFER_NOT_CONFIGURED';
  END IF;

  SELECT * INTO v_treasury
  FROM public.project_treasury
  WHERE project_id = NEW.project_id AND network = 'testnet'
  FOR SHARE;
  IF NOT FOUND OR v_treasury.status IS DISTINCT FROM 'active'
     OR nullif(trim(coalesce(v_treasury.treasury_wallet, '')), '') IS NULL
     OR trim(v_treasury.treasury_wallet) IS DISTINCT FROM trim(v_policy.treasury_wallet)
     OR v_treasury.required_liquidity IS NULL
     OR v_treasury.verified_liquidity IS NULL
     OR v_treasury.required_liquidity < greatest(v_policy.minimum_project_liquidity, v_controls.minimum_liquidity)
     OR v_treasury.verified_liquidity < greatest(v_policy.minimum_project_liquidity, v_controls.minimum_liquidity, v_treasury.required_liquidity) THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'PROJECT_LIQUIDITY_REQUIREMENT_NOT_MET';
  END IF;

  SELECT * INTO v_coverage
  FROM public.get_testnet_staking_coverage(NEW.project_id);

  IF NOT FOUND OR coalesce(v_coverage.staking_eligible, false) IS NOT TRUE THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'STAKING_LIQUIDITY_COVERAGE_NOT_ELIGIBLE';
  END IF;

  v_reserve_percent := greatest(
    coalesce((v_policy.staking_universal_risk_policy ->> 'capital_reserve_percent')::numeric, 0),
    coalesce(v_controls.capital_reserve_percent, 0)
  );
  v_deployment_percent := least(
    coalesce((v_policy.staking_universal_risk_policy ->> 'maximum_deployment_percent')::numeric, 0),
    coalesce(v_controls.maximum_deployment_percent, 0),
    100 - v_reserve_percent
  );
  v_max_principal := least(
    coalesce((v_policy.staking_universal_risk_policy ->> 'max_active_principal')::numeric, 0),
    coalesce(v_controls.max_active_principal, 0)
  );

  IF v_reserve_percent < 0 OR v_reserve_percent > 100
     OR v_deployment_percent <= 0 OR v_deployment_percent > 100
     OR v_reserve_percent + v_deployment_percent > 100
     OR v_max_principal <= 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'GLOBAL_UNIVERSAL_RISK_POLICY_INVALID';
  END IF;

  v_existing_principal := coalesce(v_coverage.outstanding_principal, 0);
  v_existing_liability := coalesce(v_coverage.total_liability, 0);

  IF TG_OP = 'UPDATE' THEN
    IF OLD.network = 'testnet' AND OLD.status = 'pending_payment' THEN
      v_old_amount := coalesce(OLD.amount, 0);
      v_old_reward := coalesce(OLD.reward_amount, 0);
      v_existing_principal := greatest(v_existing_principal - v_old_amount, 0);
      v_existing_liability := greatest(v_existing_liability - v_old_amount - v_old_reward, 0);
    END IF;
  END IF;

  IF v_existing_principal + v_new_amount > v_max_principal THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'PROJECT_ACTIVE_STAKING_CAP_REACHED';
  END IF;

  v_deployment_limit := pg_catalog.trunc(
    coalesce(v_coverage.total_tracked_assets, 0) * v_deployment_percent / 100,
    7
  );

  IF v_existing_principal + v_new_amount > v_deployment_limit THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'TESTNET_STAKING_MAX_DEPLOYMENT_EXCEEDED';
  END IF;

  IF coalesce(v_coverage.total_tracked_assets, 0) <
       v_existing_liability + v_new_amount + v_new_reward THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'STAKING_COVERAGE_INSUFFICIENT';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS testnet_stake_intent_universal_deployment_guard
  ON public.testnet_stake_intents;
CREATE TRIGGER testnet_stake_intent_universal_deployment_guard
BEFORE INSERT OR UPDATE OF project_id, project_code, network, amount, reward_amount, duration_days, reward_rate
ON public.testnet_stake_intents
FOR EACH ROW
EXECUTE FUNCTION public.guard_testnet_stake_intent_universal_deployment();

REVOKE ALL ON FUNCTION public.guard_testnet_stake_intent_universal_deployment()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_testnet_stake_intent_universal_deployment()
  TO service_role;

-- The API uses this read-only RPC to show the Staking control as blocked if the
-- database enforcement trigger is missing or disabled.
CREATE OR REPLACE FUNCTION public.testnet_global_transaction_control_guard_status()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'testnet_stake_intents'
      AND t.tgname = 'testnet_stake_intent_universal_deployment_guard'
      AND NOT t.tgisinternal
      AND t.tgenabled IN ('O', 'A')
      AND t.tgtype = 23
  );
$function$;

REVOKE ALL ON FUNCTION public.testnet_global_transaction_control_guard_status()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.testnet_global_transaction_control_guard_status()
  TO service_role;

CREATE TABLE IF NOT EXISTS public.testnet_global_transaction_control_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network text NOT NULL DEFAULT 'testnet' CHECK (network = 'testnet'),
  singleton_id smallint NOT NULL DEFAULT 1 CHECK (singleton_id = 1),
  control text NOT NULL CHECK (control IN ('treasury', 'staking')),
  action text NOT NULL CHECK (action IN ('enabled', 'disabled')),
  previous_enabled boolean NOT NULL,
  enabled boolean NOT NULL,
  admin_session_id uuid NOT NULL,
  admin_actor_id uuid,
  admin_email text,
  reason text NOT NULL CHECK (char_length(trim(reason)) BETWEEN 10 AND 500),
  previous_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS testnet_global_transaction_control_audit_created_idx
  ON public.testnet_global_transaction_control_audit (network, created_at DESC);

ALTER TABLE public.testnet_global_transaction_control_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.testnet_global_transaction_control_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.testnet_global_transaction_control_audit TO service_role;

COMMENT ON TABLE public.testnet_global_transaction_control_audit IS
  'Testnet-only immutable audit log for Super Admin global treasury and staking activation controls.';

CREATE OR REPLACE FUNCTION public.set_testnet_global_transaction_control(
  p_admin_session_id uuid,
  p_control text,
  p_enabled boolean,
  p_reason text,
  p_pi_testnet_app_wallet text,
  p_pi_api_configured boolean,
  p_payout_wallet_configured boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_admin public.testnet_admin_sessions%ROWTYPE;
  v_policy public.testnet_global_treasury_policy%ROWTYPE;
  v_previous boolean;
  v_max_reward_rate numeric;
  v_has_ready_project boolean;
  v_expected_durations integer[] := ARRAY[30, 90, 180, 365, 730, 1095];
  v_expected_rates jsonb := '{"30":0.01,"90":0.03,"180":0.06,"365":0.12,"730":0.24,"1095":0.36}'::jsonb;
  v_expected_risk jsonb := '{"capital_reserve_percent":50,"maximum_deployment_percent":25,"max_active_principal":100}'::jsonb;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  END IF;

  IF p_admin_session_id IS NULL
     OR p_control IS NULL
     OR p_control NOT IN ('treasury', 'staking')
     OR p_enabled IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'GLOBAL_TRANSACTION_CONTROL_FIELDS_REQUIRED';
  END IF;

  IF nullif(trim(coalesce(p_reason, '')), '') IS NULL
     OR char_length(trim(p_reason)) < 10
     OR char_length(trim(p_reason)) > 500 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'GLOBAL_TRANSACTION_CONTROL_REASON_REQUIRED';
  END IF;

  SELECT * INTO v_admin
  FROM public.testnet_admin_sessions
  WHERE id = p_admin_session_id
    AND network = 'testnet'
    AND revoked_at IS NULL
    AND expires_at > now()
    AND 'super_admin' = ANY(roles)
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'GLOBAL_TRANSACTION_CONTROL_SUPER_ADMIN_REQUIRED';
  END IF;

  -- Serialize global activation changes and preserve the one-row Testnet policy.
  PERFORM pg_advisory_xact_lock(hashtextextended('albukhr:testnet:global-transaction-control', 0));

  SELECT * INTO v_policy
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1 AND network = 'testnet'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_TESTNET_POLICY_NOT_CONFIGURED';
  END IF;

  IF p_control = 'treasury' THEN
    v_previous := v_policy.active;

    IF p_enabled THEN
      IF p_pi_api_configured IS DISTINCT FROM true THEN
        RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_TREASURY_PAYMENT_RAILS_NOT_READY';
      END IF;
      IF p_payout_wallet_configured IS DISTINCT FROM true THEN
        RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_TREASURY_PAYOUT_WALLET_NOT_READY';
      END IF;

      IF nullif(trim(coalesce(v_policy.treasury_wallet, '')), '') IS NULL THEN
        RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_TREASURY_CONFIGURATION_INCOMPLETE';
      END IF;

      IF nullif(trim(coalesce(p_pi_testnet_app_wallet, '')), '') IS NULL
         OR trim(v_policy.treasury_wallet) IS DISTINCT FROM trim(p_pi_testnet_app_wallet) THEN
        RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_TREASURY_WALLET_MISMATCH';
      END IF;

      IF coalesce(v_policy.minimum_project_liquidity, 0) < 100
         OR coalesce(v_policy.fee_tier_size, 0) <= 0
         OR coalesce(v_policy.fee_per_tier, -1) < 0
         OR coalesce(v_policy.sub_tier_fee_free_count, -1) < 0
         OR coalesce(v_policy.sub_tier_fee_after_quota, -1) < 0
         OR coalesce(v_policy.minimum_staker_withdrawal, -1) < 0
         OR v_policy.business_day_timezone IS DISTINCT FROM 'Africa/Lagos' THEN
        RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_TREASURY_CONFIGURATION_INCOMPLETE';
      END IF;

      IF to_regclass('public.testnet_outflow_fee_assessments') IS NULL
         OR to_regclass('public.testnet_platform_fee_ledger') IS NULL THEN
        RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_TREASURY_PAYMENT_RAILS_NOT_READY';
      END IF;

            -- At least one approved Testnet project must have independently
      -- verified ledger liquidity meeting its required liquidity.
      -- Cached project_treasury summaries alone are not sufficient.
      IF NOT EXISTS (
        SELECT 1
        FROM public.project_treasury t
        JOIN public.projects p
          ON p.id = t.project_id
         AND p.network = 'testnet'
         AND p.status = 'approved'
        CROSS JOIN LATERAL public.get_testnet_staking_coverage(p.id) cv
        WHERE t.network = 'testnet'
          AND t.status = 'active'
          AND trim(coalesce(t.treasury_wallet, '')) = trim(v_policy.treasury_wallet)
          AND t.required_liquidity IS NOT NULL
          AND t.verified_liquidity IS NOT NULL
          AND t.required_liquidity >= v_policy.minimum_project_liquidity
          AND t.verified_liquidity >= t.required_liquidity
          AND coalesce(cv.verified_liquidity_contributed, 0) >= t.required_liquidity
      ) THEN
        RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_TREASURY_PAYMENT_RAILS_NOT_READY';
      END IF;

      IF EXISTS (
        SELECT 1 FROM public.project_treasury t
        WHERE t.network = 'testnet'
          AND t.status = 'active'
          AND trim(coalesce(t.treasury_wallet, '')) IS DISTINCT FROM trim(v_policy.treasury_wallet)
      ) THEN
        RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_TREASURY_WALLET_MISMATCH';
      END IF;
    ELSE
      IF v_policy.staking_policy_active IS TRUE THEN
        RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_STAKING_MUST_BE_PAUSED_BEFORE_TREASURY';
      END IF;

      -- Do not disable the shared treasury while any stake principal/reward
      -- remains outstanding, any stake-payment intent is pending, or any
      -- withdrawal is still in flight. This preserves the ability to settle
      -- existing user obligations after new staking has been paused.
      IF EXISTS (
        SELECT 1 FROM public.testnet_stake_intents i
        WHERE i.network = 'testnet' AND i.status = 'pending_payment'
      ) OR EXISTS (
        SELECT 1
        FROM public.projects p
        CROSS JOIN LATERAL public.get_testnet_staking_coverage(p.id) cv
        WHERE p.network = 'testnet'
          AND (coalesce(cv.outstanding_principal, 0) > 0
            OR coalesce(cv.outstanding_rewards, 0) > 0)
      ) OR EXISTS (
        SELECT 1 FROM public.withdrawal_requests w
        WHERE w.network = 'testnet'
          AND coalesce(w.status, '') NOT IN ('completed', 'rejected', 'cancelled', 'failed')
      ) OR EXISTS (
        SELECT 1 FROM public.project_owner_withdrawals w
        WHERE w.network = 'testnet'
          AND coalesce(w.status, '') NOT IN ('completed', 'rejected', 'cancelled', 'failed')
      ) THEN
        RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_TREASURY_OUTSTANDING_OBLIGATIONS';
      END IF;
    END IF;

    IF v_previous IS DISTINCT FROM p_enabled THEN
      UPDATE public.testnet_global_treasury_policy
      SET active = p_enabled,
          updated_at = now()
      WHERE singleton_id = 1 AND network = 'testnet';

      INSERT INTO public.testnet_global_transaction_control_audit (
        network, singleton_id, control, action, previous_enabled, enabled,
        admin_session_id, admin_actor_id, admin_email, reason,
        previous_state, after_state
      ) VALUES (
        'testnet', 1, 'treasury', CASE WHEN p_enabled THEN 'enabled' ELSE 'disabled' END,
        coalesce(v_previous, false), p_enabled,
        v_admin.id, v_admin.admin_user_id, v_admin.email, trim(p_reason),
        jsonb_build_object('active', coalesce(v_previous, false), 'staking_policy_active', v_policy.staking_policy_active),
        jsonb_build_object('active', p_enabled, 'staking_policy_active', v_policy.staking_policy_active)
      );
    END IF;

    RETURN jsonb_build_object(
      'success', true, 'network', 'testnet', 'control', 'treasury',
      'previous_enabled', coalesce(v_previous, false), 'enabled', p_enabled,
      'changed', v_previous IS DISTINCT FROM p_enabled
    );
  END IF;

  v_previous := v_policy.staking_policy_active;

  IF p_enabled THEN
    IF public.testnet_global_transaction_control_guard_status() IS DISTINCT FROM true THEN
      RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_STAKING_DEPLOYMENT_GUARD_MISSING';
    END IF;

    IF v_policy.active IS DISTINCT FROM true THEN
      RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_TREASURY_NOT_READY';
    END IF;

    IF p_pi_api_configured IS DISTINCT FROM true
       OR p_payout_wallet_configured IS DISTINCT FROM true THEN
      RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_TREASURY_PAYOUT_WALLET_NOT_READY';
    END IF;

    IF nullif(trim(coalesce(p_pi_testnet_app_wallet, '')), '') IS NULL
       OR trim(v_policy.treasury_wallet) IS DISTINCT FROM trim(p_pi_testnet_app_wallet) THEN
      RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_TREASURY_WALLET_MISMATCH';
    END IF;

    IF coalesce(v_policy.minimum_project_liquidity, 0) < 100
       OR coalesce(v_policy.staking_minimum_stake_amount, 0) < 10
       OR coalesce(v_policy.staking_reward_reserve_coverage_percent, 0) < 100
       OR v_policy.allowed_duration_days IS DISTINCT FROM v_expected_durations
       OR v_policy.staking_reward_rates_by_duration IS DISTINCT FROM v_expected_rates
       OR v_policy.staking_universal_risk_policy IS DISTINCT FROM v_expected_risk THEN
      RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_STAKING_POLICY_CONFIGURATION_INCOMPLETE';
    END IF;

    IF jsonb_typeof(v_policy.staking_stage_policies) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_STAKING_POLICY_CONFIGURATION_INCOMPLETE';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM jsonb_object_keys(v_policy.staking_stage_policies)) THEN
      RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_STAKING_POLICY_CONFIGURATION_INCOMPLETE';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.testnet_stake_intents i
      WHERE i.network = 'testnet' AND i.status = 'pending_payment'
    ) THEN
      RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_STAKING_PENDING_INTENTS_EXIST';
    END IF;

    SELECT max((value #>> '{}')::numeric)
    INTO v_max_reward_rate
    FROM jsonb_each(v_policy.staking_reward_rates_by_duration);

    -- get_testnet_staking_coverage.staking_eligible is intentionally not used here:
    -- it is false until this policy flag is turned on. Recheck every other predicate.
    SELECT EXISTS (
      SELECT 1
      FROM public.projects p
      JOIN public.project_staking_risk_controls c
        ON c.project_id = p.id AND c.network = 'testnet'
      JOIN public.project_treasury t
        ON t.project_id = p.id AND t.network = 'testnet'
      JOIN public.project_staking_terms o
        ON o.project_code = p.project_code AND o.network = 'testnet' AND o.active IS TRUE
      CROSS JOIN LATERAL public.get_testnet_staking_coverage(p.id) cv
      WHERE p.network = 'testnet'
        AND p.status = 'approved'
        AND c.staking_enabled IS TRUE
        AND c.approval_status = 'approved'
        AND c.minimum_liquidity >= v_policy.minimum_project_liquidity
        AND c.capital_reserve_percent = 50
        AND c.maximum_deployment_percent = 25
        AND c.max_active_principal = 100
        AND c.max_reward_rate = v_max_reward_rate
        AND c.reward_reserve_coverage_percent >= v_policy.staking_reward_reserve_coverage_percent
        AND t.status = 'active'
        AND trim(coalesce(t.treasury_wallet, '')) = trim(v_policy.treasury_wallet)
        AND t.required_liquidity >= v_policy.minimum_project_liquidity
        AND t.verified_liquidity >= t.required_liquidity
        AND o.duration_days = ANY(v_policy.allowed_duration_days)
        AND o.min_stake >= v_policy.staking_minimum_stake_amount
        AND o.reward_rate > 0
        AND o.reward_rate <= (v_policy.staking_reward_rates_by_duration ->> o.duration_days::text)::numeric
        AND cv.owner_liquidity_available >= v_policy.minimum_project_liquidity
        AND cv.liquidity_buffer >= v_policy.minimum_project_liquidity
        AND cv.total_tracked_assets >= cv.total_liability
        AND cv.reward_reserve_balance >=
            cv.outstanding_rewards * v_policy.staking_reward_reserve_coverage_percent / 100
        AND NOT EXISTS (
          SELECT 1 FROM public.testnet_stake_intents i
          WHERE i.project_id = p.id AND i.network = 'testnet' AND i.status = 'pending_payment'
        )
    ) INTO v_has_ready_project;

    IF v_has_ready_project IS DISTINCT FROM true THEN
      RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_STAKING_PROJECT_NOT_READY';
    END IF;
  ELSE
    -- Staking can always be paused without pausing the treasury.
    NULL;
  END IF;

  IF v_previous IS DISTINCT FROM p_enabled THEN
    UPDATE public.testnet_global_treasury_policy
    SET staking_policy_active = p_enabled,
        updated_at = now()
    WHERE singleton_id = 1 AND network = 'testnet';

    INSERT INTO public.testnet_global_transaction_control_audit (
      network, singleton_id, control, action, previous_enabled, enabled,
      admin_session_id, admin_actor_id, admin_email, reason,
      previous_state, after_state
    ) VALUES (
      'testnet', 1, 'staking', CASE WHEN p_enabled THEN 'enabled' ELSE 'disabled' END,
      coalesce(v_previous, false), p_enabled,
      v_admin.id, v_admin.admin_user_id, v_admin.email, trim(p_reason),
      jsonb_build_object('active', v_policy.active, 'staking_policy_active', coalesce(v_previous, false)),
      jsonb_build_object('active', v_policy.active, 'staking_policy_active', p_enabled)
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'network', 'testnet', 'control', 'staking',
    'previous_enabled', coalesce(v_previous, false), 'enabled', p_enabled,
    'changed', v_previous IS DISTINCT FROM p_enabled
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.set_testnet_global_transaction_control(
  uuid, text, boolean, text, text, boolean, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_testnet_global_transaction_control(
  uuid, text, boolean, text, text, boolean, boolean
) TO service_role;

COMMENT ON FUNCTION public.set_testnet_global_transaction_control(
  uuid, text, boolean, text, text, boolean, boolean
) IS 'Testnet Super Admin only. Performs server-backed preflight checks, activates or pauses the global Testnet treasury/staking flags, and writes an immutable audit event. Does not touch Mainnet.';

COMMIT;
