-- ALBUKHR Testnet project-level staking enablement v1
-- Additive only. Does not activate global Testnet staking or enable any project.
-- Scope: Testnet project vhvkwvngmrlgyzwemttt only.

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='project_staking_risk_controls'
      AND column_name='staking_enabled' AND data_type='boolean'
  ) THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: project_staking_risk_controls.staking_enabled is missing';
  END IF;

  IF to_regclass('public.testnet_admin_sessions') IS NULL
     OR to_regclass('public.mainnet_project_mirror_provenance') IS NULL
     OR to_regclass('public.testnet_project_staking_risk_control_audit') IS NULL THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: required Testnet admin, mirror provenance, or risk audit table is missing';
  END IF;

  IF to_regprocedure('public.guard_testnet_project_local_staking_policy()') IS NULL THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: existing Testnet risk-control guard function is missing';
  END IF;

  IF to_regprocedure('public.get_testnet_staking_coverage(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: Testnet staking coverage function is missing';
  END IF;
END;
$preflight$;

CREATE TABLE IF NOT EXISTS public.testnet_project_staking_enablement_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network text NOT NULL DEFAULT 'testnet',
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  project_code text NOT NULL,
  risk_control_id uuid NOT NULL REFERENCES public.project_staking_risk_controls(id) ON DELETE RESTRICT,
  admin_session_id uuid NOT NULL REFERENCES public.testnet_admin_sessions(id) ON DELETE RESTRICT,
  admin_actor_id uuid NOT NULL,
  action text NOT NULL,
  previous_enabled boolean NOT NULL,
  enabled boolean NOT NULL,
  reason text NOT NULL,
  previous_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT testnet_project_staking_enablement_audit_network_check
    CHECK (network = 'testnet'),
  CONSTRAINT testnet_project_staking_enablement_audit_action_check
    CHECK (action IN ('enabled', 'disabled')),
  CONSTRAINT testnet_project_staking_enablement_audit_state_check
    CHECK ((action = 'enabled' AND previous_enabled = false AND enabled = true)
        OR (action = 'disabled' AND previous_enabled = true AND enabled = false)),
  CONSTRAINT testnet_project_staking_enablement_audit_reason_check
    CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500)
);

CREATE INDEX IF NOT EXISTS testnet_project_staking_enablement_audit_project_created_idx
  ON public.testnet_project_staking_enablement_audit(project_id, created_at DESC);

ALTER TABLE public.testnet_project_staking_enablement_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.testnet_project_staking_enablement_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.testnet_project_staking_enablement_audit TO service_role;

DROP POLICY IF EXISTS testnet_project_staking_enablement_audit_no_direct_api_access
  ON public.testnet_project_staking_enablement_audit;
CREATE POLICY testnet_project_staking_enablement_audit_no_direct_api_access
  ON public.testnet_project_staking_enablement_audit
  FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

COMMENT ON TABLE public.testnet_project_staking_enablement_audit IS
  'Append-only record of Testnet Super Admin project-level staking enable/disable decisions. Global Testnet activation is controlled separately.';

-- Add a narrowly scoped trigger bypass for the trusted RPC only. The existing
-- policy, provisioning, and review guard branches remain untouched.
DO $guard_patch$
DECLARE
  v_oid oid;
  v_definition text;
  v_anchor text := $anchor$  IF TG_TABLE_NAME = 'project_staking_risk_controls'
     AND TG_OP = 'UPDATE'
     AND current_setting('albukhr.testnet_staking_risk_control_review', true) = 'on' THEN$anchor$;
  v_insert text := $insert$
  IF TG_TABLE_NAME = 'project_staking_risk_controls'
     AND TG_OP = 'UPDATE'
     AND current_setting('albukhr.testnet_staking_enablement', true) IN ('enable', 'disable') THEN
    IF OLD.network IS DISTINCT FROM 'testnet'
       OR NEW.network IS DISTINCT FROM 'testnet'
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.project_code IS DISTINCT FROM OLD.project_code
       OR NEW.approval_status IS DISTINCT FROM OLD.approval_status
       OR NEW.minimum_liquidity IS DISTINCT FROM OLD.minimum_liquidity
       OR NEW.capital_reserve_percent IS DISTINCT FROM OLD.capital_reserve_percent
       OR NEW.maximum_deployment_percent IS DISTINCT FROM OLD.maximum_deployment_percent
       OR NEW.max_reward_rate IS DISTINCT FROM OLD.max_reward_rate
       OR NEW.max_active_principal IS DISTINCT FROM OLD.max_active_principal
       OR NEW.reward_reserve_coverage_percent IS DISTINCT FROM OLD.reward_reserve_coverage_percent
       OR (to_jsonb(NEW) - 'staking_enabled' - 'updated_at')
          IS DISTINCT FROM (to_jsonb(OLD) - 'staking_enabled' - 'updated_at')
       OR NEW.staking_enabled IS DISTINCT FROM
          (current_setting('albukhr.testnet_staking_enablement', true) = 'enable') THEN
      RAISE EXCEPTION USING errcode='42501', message='TESTNET_STAKING_ENABLEMENT_GUARD_REJECTED';
    END IF;
    RETURN NEW;
  END IF;

$insert$;
BEGIN
  SELECT p.oid, pg_get_functiondef(p.oid)
    INTO v_oid, v_definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public'
    AND p.proname='guard_testnet_project_local_staking_policy'
    AND p.pronargs=0;

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: guard_testnet_project_local_staking_policy() was not found';
  END IF;

  IF position('albukhr.testnet_staking_enablement' IN v_definition) > 0 THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: enablement guard branch already exists; review migration state before continuing';
  END IF;

  IF ((length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor)) <> 1 THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: expected trigger-function anchor did not occur exactly once; no function was changed';
  END IF;

  v_definition := replace(v_definition, v_anchor, v_insert || v_anchor);
  EXECUTE v_definition;
END;
$guard_patch$;

CREATE OR REPLACE FUNCTION public.set_testnet_project_staking_enabled(
  p_project_id uuid,
  p_admin_session_id uuid,
  p_enabled boolean,
  p_reason text
)
RETURNS public.project_staking_risk_controls
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_admin public.testnet_admin_sessions%ROWTYPE;
  v_project public.projects%ROWTYPE;
  v_provenance public.mainnet_project_mirror_provenance%ROWTYPE;
  v_control public.project_staking_risk_controls%ROWTYPE;
  v_policy public.testnet_global_treasury_policy%ROWTYPE;
  v_treasury public.project_treasury%ROWTYPE;
  v_coverage record;
  v_previous_state jsonb;
  v_after_state jsonb;
  v_previous_guard text := current_setting('albukhr.testnet_staking_enablement', true);
  v_global_max_reward_rate numeric;
  v_required_liquidity numeric;
  v_valid_offer_count integer := 0;
  v_invalid_offer_count integer := 0;
  v_reason text := nullif(btrim(p_reason), '');
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING errcode='42501', message='SERVICE_ROLE_REQUIRED';
  END IF;

  IF p_project_id IS NULL OR p_admin_session_id IS NULL OR p_enabled IS NULL THEN
    RAISE EXCEPTION USING errcode='22023', message='TESTNET_STAKING_ENABLEMENT_FIELDS_REQUIRED';
  END IF;

  IF v_reason IS NULL OR char_length(v_reason) < 10 OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION USING errcode='22023', message='TESTNET_STAKING_ENABLEMENT_REASON_REQUIRED';
  END IF;

  SELECT * INTO v_admin
  FROM public.testnet_admin_sessions
  WHERE id=p_admin_session_id
    AND network='testnet'
    AND revoked_at IS NULL
    AND expires_at > now()
    AND 'super_admin' = ANY(roles)
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='42501', message='TESTNET_STAKING_ENABLEMENT_ADMIN_REQUIRED';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('albukhr:testnet:staking-enablement:' || p_project_id::text, 0)
  );

  SELECT * INTO v_project
  FROM public.projects
  WHERE id=p_project_id AND network='testnet'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='P0002', message='TESTNET_STAKING_ENABLEMENT_PROJECT_NOT_FOUND';
  END IF;

  SELECT * INTO v_control
  FROM public.project_staking_risk_controls
  WHERE project_id=p_project_id AND network='testnet'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='55000', message='TESTNET_STAKING_ENABLEMENT_RISK_CONTROLS_NOT_APPROVED';
  END IF;

  -- Disabling bypasses approval/treasury/coverage checks, but a project with
  -- unresolved stake-payment intents cannot be switched off until those intents
  -- are reconciled or cancelled. This avoids stranding a completed Pi payment.
  -- Enabling is subject to the complete preflight below.
  IF p_enabled IS TRUE THEN
    IF v_project.status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION USING errcode='55000', message='TESTNET_STAKING_ENABLEMENT_PROJECT_NOT_APPROVED';
    END IF;

    SELECT * INTO v_provenance
    FROM public.mainnet_project_mirror_provenance
    WHERE testnet_project_id=p_project_id
      AND network='testnet'
      AND project_code=v_project.project_code
      AND source_status='approved'
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING errcode='55000', message='TESTNET_STAKING_ENABLEMENT_MAINNET_APPROVAL_REQUIRED';
    END IF;

    IF v_control.approval_status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION USING errcode='55000', message='TESTNET_STAKING_ENABLEMENT_RISK_CONTROLS_NOT_APPROVED';
    END IF;

    SELECT * INTO v_policy
    FROM public.testnet_global_treasury_policy
    WHERE singleton_id=1 AND network='testnet'
    FOR SHARE;

    IF NOT FOUND
       OR v_policy.minimum_project_liquidity IS NULL
       OR v_policy.minimum_project_liquidity IS DISTINCT FROM 100::numeric
       OR v_policy.staking_minimum_stake_amount IS DISTINCT FROM 10::numeric
       OR v_policy.staking_reward_reserve_coverage_percent IS DISTINCT FROM 100::numeric
       OR nullif(btrim(v_policy.treasury_wallet), '') IS NULL
       OR v_policy.allowed_duration_days IS DISTINCT FROM ARRAY[30,90,180,365,730,1095]::integer[]
       OR v_policy.staking_reward_rates_by_duration IS DISTINCT FROM
          '{"30":0.01,"90":0.03,"180":0.06,"365":0.12,"730":0.24,"1095":0.36}'::jsonb THEN
      RAISE EXCEPTION USING errcode='55000', message='TESTNET_STAKING_ENABLEMENT_POLICY_NOT_CONFIGURED';
    END IF;

    SELECT max((j.value #>> '{}')::numeric)
      INTO v_global_max_reward_rate
    FROM jsonb_each(v_policy.staking_reward_rates_by_duration) j
    WHERE j.key ~ '^[0-9]+$'
      AND j.key::integer = ANY(v_policy.allowed_duration_days)
      AND jsonb_typeof(j.value)='number';

    IF v_global_max_reward_rate IS NULL
       OR v_global_max_reward_rate <= 0
       OR v_global_max_reward_rate > 1
       OR EXISTS (
         SELECT 1
         FROM unnest(v_policy.allowed_duration_days) d
         WHERE nullif(v_policy.staking_reward_rates_by_duration ->> d::text, '') IS NULL
            OR (v_policy.staking_reward_rates_by_duration ->> d::text)::numeric <= 0
            OR (v_policy.staking_reward_rates_by_duration ->> d::text)::numeric > 1
       ) THEN
      RAISE EXCEPTION USING errcode='55000', message='TESTNET_STAKING_ENABLEMENT_POLICY_NOT_CONFIGURED';
    END IF;

    IF v_control.minimum_liquidity IS NULL
       OR v_control.minimum_liquidity < v_policy.minimum_project_liquidity
       OR v_control.capital_reserve_percent IS NULL
       OR v_control.capital_reserve_percent IS DISTINCT FROM 50::numeric
       OR v_control.maximum_deployment_percent IS DISTINCT FROM 25::numeric
       OR v_control.capital_reserve_percent + v_control.maximum_deployment_percent > 100
       OR v_control.max_reward_rate IS DISTINCT FROM 0.36::numeric
       OR v_control.max_reward_rate IS DISTINCT FROM v_global_max_reward_rate
       OR v_control.max_active_principal IS DISTINCT FROM 100::numeric
       OR v_control.reward_reserve_coverage_percent IS DISTINCT FROM 100::numeric THEN
      RAISE EXCEPTION USING errcode='55000', message='TESTNET_STAKING_ENABLEMENT_LIMITS_INVALID';
    END IF;

    SELECT * INTO v_treasury
    FROM public.project_treasury
    WHERE project_id=p_project_id AND network='testnet'
    FOR SHARE;

    IF NOT FOUND
       OR v_treasury.status IS DISTINCT FROM 'active'
       OR nullif(btrim(v_treasury.treasury_wallet), '') IS NULL
       OR v_treasury.treasury_wallet IS DISTINCT FROM v_policy.treasury_wallet
       OR v_treasury.required_liquidity IS NULL
       OR v_treasury.required_liquidity < greatest(v_policy.minimum_project_liquidity, v_control.minimum_liquidity)
       OR v_control.minimum_liquidity < v_treasury.required_liquidity
       OR v_treasury.verified_liquidity IS NULL
       OR v_control.minimum_liquidity IS DISTINCT FROM
          greatest(v_policy.minimum_project_liquidity, v_treasury.required_liquidity)
       OR v_treasury.verified_liquidity < v_control.minimum_liquidity THEN
      RAISE EXCEPTION USING errcode='55000', message='TESTNET_STAKING_ENABLEMENT_TREASURY_NOT_READY';
    END IF;

    v_required_liquidity := v_control.minimum_liquidity;

    SELECT
      count(*) FILTER (
        WHERE t.duration_days = ANY(v_policy.allowed_duration_days)
          AND t.min_stake = v_policy.staking_minimum_stake_amount
          AND t.reward_rate > 0
          AND t.reward_rate <= v_control.max_reward_rate
          AND t.reward_rate <= coalesce(
            (v_policy.staking_reward_rates_by_duration ->> t.duration_days::text)::numeric,
            0
          )
      ),
      count(*) FILTER (
        WHERE NOT (t.duration_days = ANY(v_policy.allowed_duration_days))
           OR t.min_stake IS DISTINCT FROM v_policy.staking_minimum_stake_amount
           OR t.reward_rate IS NULL
           OR t.reward_rate <= 0
           OR t.reward_rate > v_control.max_reward_rate
           OR t.reward_rate > coalesce(
             (v_policy.staking_reward_rates_by_duration ->> t.duration_days::text)::numeric,
             0
           )
      )
    INTO v_valid_offer_count, v_invalid_offer_count
    FROM public.project_staking_terms t
    WHERE t.project_code=v_project.project_code
      AND t.network='testnet'
      AND t.active IS TRUE;

    IF coalesce(v_valid_offer_count,0) < 1 OR coalesce(v_invalid_offer_count,0) > 0 THEN
      RAISE EXCEPTION USING errcode='55000', message='TESTNET_STAKING_ENABLEMENT_OFFERS_NOT_READY';
    END IF;

    -- The coverage function is intentionally used for its numeric ledger and
    -- liability totals only. Its staking_eligible output includes the global
    -- switch and legacy stage policy; neither is required for project-level
    -- enablement because global activation is a separate later decision.
    SELECT * INTO v_coverage
    FROM public.get_testnet_staking_coverage(p_project_id);

    IF NOT FOUND
       OR coalesce(v_coverage.verified_liquidity_contributed,0) < v_required_liquidity
       OR coalesce(v_coverage.owner_liquidity_available,0) < v_required_liquidity
       OR coalesce(v_coverage.liquidity_buffer,0) < v_required_liquidity
       OR coalesce(v_coverage.total_tracked_assets,0) < coalesce(v_coverage.total_liability,0)
       OR coalesce(v_coverage.capital_reserve_balance,0) <
          coalesce(v_coverage.outstanding_principal,0) * v_control.capital_reserve_percent / 100
       OR coalesce(v_coverage.reward_reserve_balance,0) <
          coalesce(v_coverage.outstanding_rewards,0) * v_control.reward_reserve_coverage_percent / 100
       OR coalesce(v_coverage.outstanding_principal,0) > v_control.max_active_principal THEN
      RAISE EXCEPTION USING errcode='55000', message='TESTNET_STAKING_ENABLEMENT_COVERAGE_NOT_READY';
    END IF;
  END IF;

  IF v_control.staking_enabled IS NOT DISTINCT FROM p_enabled THEN
    RETURN v_control;
  END IF;

  IF p_enabled IS FALSE AND EXISTS (
    SELECT 1
    FROM public.testnet_stake_intents i
    WHERE i.project_id=p_project_id
      AND i.network='testnet'
      AND (
        i.status = 'pending_payment'
        OR (i.status = 'created' AND i.stake_id IS NULL)
      )
  ) THEN
    RAISE EXCEPTION USING errcode='55000', message='TESTNET_STAKING_ENABLEMENT_PENDING_INTENTS';
  END IF;

  v_previous_state := to_jsonb(v_control);
  PERFORM set_config(
    'albukhr.testnet_staking_enablement',
    CASE WHEN p_enabled THEN 'enable' ELSE 'disable' END,
    true
  );

  UPDATE public.project_staking_risk_controls
  SET staking_enabled=p_enabled, updated_at=now()
  WHERE id=v_control.id AND network='testnet'
  RETURNING * INTO v_control;

  PERFORM set_config(
    'albukhr.testnet_staking_enablement',
    coalesce(nullif(v_previous_guard,''),'off'),
    true
  );

  v_after_state := to_jsonb(v_control);

  INSERT INTO public.testnet_project_staking_enablement_audit (
    network, project_id, project_code, risk_control_id,
    admin_session_id, admin_actor_id, action,
    previous_enabled, enabled, reason, previous_state, after_state
  ) VALUES (
    'testnet', v_project.id, v_project.project_code, v_control.id,
    v_admin.id, v_admin.admin_user_id,
    CASE WHEN p_enabled THEN 'enabled' ELSE 'disabled' END,
    NOT p_enabled, p_enabled, v_reason, v_previous_state, v_after_state
  );

  RETURN v_control;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_testnet_project_staking_enabled(uuid, uuid, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_testnet_project_staking_enabled(uuid, uuid, boolean, text)
  TO service_role;

COMMENT ON FUNCTION public.set_testnet_project_staking_enabled(uuid, uuid, boolean, text) IS
  'Testnet Super Admin only. Enables or disables one project-level staking flag after server-side approval, Mainnet mirror, treasury, offer, and ledger coverage checks. Does not activate global staking.';

COMMIT;
