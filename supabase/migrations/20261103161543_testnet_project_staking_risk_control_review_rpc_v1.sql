
CREATE TABLE IF NOT EXISTS public.testnet_project_staking_risk_control_review_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network text NOT NULL CHECK (network='testnet'),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  project_code text NOT NULL,
  admin_session_id uuid NOT NULL REFERENCES public.testnet_admin_sessions(id) ON DELETE RESTRICT,
  admin_actor_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected','suspended')),
  previous_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.testnet_project_staking_risk_control_review_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.testnet_project_staking_risk_control_review_audit FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_testnet_project_local_staking_policy()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_policy public.testnet_global_treasury_policy%ROWTYPE;
  v_cap numeric;
  v_project public.projects%ROWTYPE;
  v_treasury public.project_treasury%ROWTYPE;
  v_stage_rule jsonb;
BEGIN
  IF TG_TABLE_NAME = 'project_staking_risk_controls'
     AND TG_OP = 'INSERT'
     AND current_setting('albukhr.testnet_staking_risk_control_provision', true) = 'on' THEN
    SELECT * INTO v_project FROM public.projects
    WHERE id=NEW.project_id AND project_code=NEW.project_code
      AND network='testnet' AND status='approved' FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING errcode='42501', message='TESTNET_APPROVED_PROJECT_REQUIRED';
    END IF;

    SELECT * INTO v_policy FROM public.testnet_global_treasury_policy
    WHERE singleton_id=1 AND network='testnet' FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING errcode='55000', message='GLOBAL_TESTNET_POLICY_NOT_CONFIGURED';
    END IF;

    SELECT * INTO v_treasury FROM public.project_treasury
    WHERE project_id=NEW.project_id AND network='testnet' FOR SHARE;
    IF NOT FOUND OR v_treasury.status <> 'active'
       OR v_treasury.required_liquidity < v_policy.minimum_project_liquidity THEN
      RAISE EXCEPTION USING errcode='55000', message='PROJECT_TREASURY_OR_TARGET_NOT_CONFIGURED';
    END IF;

    v_stage_rule := v_policy.staking_stage_policies -> v_project.staking_stage;
    IF jsonb_typeof(v_stage_rule) IS DISTINCT FROM 'object'
       OR nullif(v_stage_rule->>'capital_reserve_percent','') IS NULL
       OR nullif(v_stage_rule->>'maximum_deployment_percent','') IS NULL
       OR nullif(v_stage_rule->>'max_active_principal','') IS NULL THEN
      RAISE EXCEPTION USING errcode='55000', message='PROJECT_STAKING_STAGE_REQUIRED';
    END IF;

    SELECT max((value #>> '{}')::numeric) INTO v_cap
    FROM jsonb_each(v_policy.staking_reward_rates_by_duration);
    IF v_cap IS NULL OR v_cap <= 0 OR v_cap > 1 THEN
      RAISE EXCEPTION USING errcode='55000', message='GLOBAL_STAKING_REWARD_LIMIT_INVALID';
    END IF;

    IF NEW.network IS DISTINCT FROM 'testnet'
       OR NEW.staking_enabled IS DISTINCT FROM false
       OR NEW.approval_status IS DISTINCT FROM 'pending'
       OR NEW.minimum_liquidity IS DISTINCT FROM greatest(v_policy.minimum_project_liquidity, v_treasury.required_liquidity)
       OR NEW.capital_reserve_percent IS DISTINCT FROM (v_stage_rule->>'capital_reserve_percent')::numeric
       OR NEW.maximum_deployment_percent IS DISTINCT FROM (v_stage_rule->>'maximum_deployment_percent')::numeric
       OR NEW.max_reward_rate IS DISTINCT FROM v_cap
       OR NEW.max_active_principal IS DISTINCT FROM (v_stage_rule->>'max_active_principal')::numeric
       OR NEW.reward_reserve_coverage_percent IS DISTINCT FROM v_policy.staking_reward_reserve_coverage_percent THEN
      RAISE EXCEPTION USING errcode='42501', message='TESTNET_PENDING_RISK_CONTROL_MUST_MATCH_GLOBAL_POLICY';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'project_staking_terms'
     AND TG_OP IN ('INSERT','UPDATE')
     AND current_setting('albukhr.testnet_staking_offer_write', true) = 'on' THEN
    IF NEW.network <> 'testnet' OR (TG_OP='UPDATE' AND OLD.network <> 'testnet') THEN
      RAISE EXCEPTION USING errcode='42501',message='TESTNET_OWNER_OFFER_ONLY';
    END IF;
    IF TG_OP='UPDATE' AND
       (NEW.project_code IS DISTINCT FROM OLD.project_code OR NEW.network IS DISTINCT FROM OLD.network OR NEW.duration_days IS DISTINCT FROM OLD.duration_days) THEN
      RAISE EXCEPTION USING errcode='42501',message='TESTNET_OWNER_OFFER_IDENTITY_IMMUTABLE';
    END IF;
    SELECT * INTO v_policy FROM public.testnet_global_treasury_policy WHERE singleton_id=1 AND network='testnet';
    IF NOT FOUND
       OR NOT (NEW.duration_days = ANY(v_policy.allowed_duration_days))
       OR NEW.min_stake IS DISTINCT FROM v_policy.staking_minimum_stake_amount
       OR NEW.active IS DISTINCT FROM true
       OR jsonb_typeof(v_policy.staking_reward_rates_by_duration) <> 'object'
       OR nullif(v_policy.staking_reward_rates_by_duration ->> NEW.duration_days::text,'') IS NULL
       OR NEW.reward_rate IS NULL OR NEW.reward_rate<=0 OR NEW.reward_rate>1
       OR NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.project_code=NEW.project_code AND p.network='testnet' AND p.status='approved') THEN
      RAISE EXCEPTION USING errcode='42501',message='TESTNET_OWNER_OFFER_POLICY_INVALID';
    END IF;
    v_cap := (v_policy.staking_reward_rates_by_duration ->> NEW.duration_days::text)::numeric;
    IF v_cap<=0 OR v_cap>1 OR NEW.reward_rate>v_cap THEN
      RAISE EXCEPTION USING errcode='42501',message='STAKING_REWARD_RATE_EXCEEDS_ALBUKHR_LIMIT';
    END IF;
    RETURN NEW;
  END IF;


  IF TG_TABLE_NAME = 'project_staking_risk_controls'
     AND TG_OP = 'UPDATE'
     AND current_setting('albukhr.testnet_staking_risk_control_review', true) = 'on' THEN
    IF OLD.network IS DISTINCT FROM 'testnet'
       OR NEW.network IS DISTINCT FROM 'testnet'
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.project_code IS DISTINCT FROM OLD.project_code
       OR NEW.staking_enabled IS DISTINCT FROM false
       OR NEW.approval_status NOT IN ('approved','rejected','suspended') THEN
      RAISE EXCEPTION USING errcode='42501', message='TESTNET_RISK_CONTROL_REVIEW_INVALID';
    END IF;

    SELECT * INTO v_project FROM public.projects
    WHERE id=NEW.project_id AND project_code=NEW.project_code
      AND network='testnet' AND status='approved';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING errcode='42501', message='TESTNET_APPROVED_PROJECT_REQUIRED';
    END IF;

    SELECT * INTO v_policy FROM public.testnet_global_treasury_policy
    WHERE singleton_id=1 AND network='testnet';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING errcode='55000', message='GLOBAL_TESTNET_POLICY_NOT_CONFIGURED';
    END IF;

    SELECT * INTO v_treasury FROM public.project_treasury
    WHERE project_id=NEW.project_id AND network='testnet';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING errcode='55000', message='PROJECT_TREASURY_OR_TARGET_NOT_CONFIGURED';
    END IF;

    v_stage_rule := v_policy.staking_stage_policies -> v_project.staking_stage;
    SELECT max((value #>> '{}')::numeric) INTO v_cap
    FROM jsonb_each(v_policy.staking_reward_rates_by_duration);

    IF jsonb_typeof(v_stage_rule) IS DISTINCT FROM 'object'
       OR v_cap IS NULL
       OR NEW.minimum_liquidity IS DISTINCT FROM greatest(v_policy.minimum_project_liquidity, v_treasury.required_liquidity)
       OR NEW.capital_reserve_percent IS DISTINCT FROM (v_stage_rule->>'capital_reserve_percent')::numeric
       OR NEW.maximum_deployment_percent IS DISTINCT FROM (v_stage_rule->>'maximum_deployment_percent')::numeric
       OR NEW.max_active_principal IS DISTINCT FROM (v_stage_rule->>'max_active_principal')::numeric
       OR NEW.max_reward_rate IS DISTINCT FROM v_cap
       OR NEW.reward_reserve_coverage_percent IS DISTINCT FROM v_policy.staking_reward_reserve_coverage_percent THEN
      RAISE EXCEPTION USING errcode='42501', message='TESTNET_RISK_CONTROLS_STALE_OR_POLICY_MISMATCH';
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP='DELETE' THEN
    IF OLD.network='testnet' THEN RAISE EXCEPTION USING errcode='42501',message='GLOBAL_TESTNET_POLICY_AUTHORITATIVE'; END IF;
    RETURN OLD;
  ELSIF TG_OP='UPDATE' THEN
    IF OLD.network='testnet' OR NEW.network='testnet' THEN RAISE EXCEPTION USING errcode='42501',message='GLOBAL_TESTNET_POLICY_AUTHORITATIVE'; END IF;
    RETURN NEW;
  ELSE
    IF NEW.network='testnet' THEN RAISE EXCEPTION USING errcode='42501',message='GLOBAL_TESTNET_POLICY_AUTHORITATIVE'; END IF;
    RETURN NEW;
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.review_testnet_project_staking_risk_control(
  p_project_id uuid,
  p_admin_session_id uuid,
  p_decision text
)
RETURNS public.project_staking_risk_controls
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_admin public.testnet_admin_sessions%ROWTYPE;
  v_control public.project_staking_risk_controls%ROWTYPE;
  v_project public.projects%ROWTYPE;
  v_policy public.testnet_global_treasury_policy%ROWTYPE;
  v_treasury public.project_treasury%ROWTYPE;
  v_stage_rule jsonb;
  v_max_reward_rate numeric;
  v_previous_state jsonb;
  v_prev_flag text := current_setting('albukhr.testnet_staking_risk_control_review', true);
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING errcode='42501', message='SERVICE_ROLE_REQUIRED';
  END IF;
  IF p_project_id IS NULL OR p_admin_session_id IS NULL
     OR p_decision NOT IN ('approved','rejected','suspended') THEN
    RAISE EXCEPTION USING errcode='22023', message='STAKING_POLICY_REVIEW_FIELDS_REQUIRED';
  END IF;

  SELECT * INTO v_admin FROM public.testnet_admin_sessions
  WHERE id=p_admin_session_id AND network='testnet'
    AND revoked_at IS NULL AND expires_at > now()
    AND 'super_admin' = ANY(roles)
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='42501', message='TESTNET_STAKING_SUPER_ADMIN_REQUIRED';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('albukhr:testnet:staking-risk-control:' || p_project_id::text,0));

  SELECT * INTO v_project FROM public.projects
  WHERE id=p_project_id AND network='testnet' AND status='approved'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='42501', message='TESTNET_APPROVED_PROJECT_REQUIRED';
  END IF;

  SELECT * INTO v_control FROM public.project_staking_risk_controls
  WHERE project_id=p_project_id AND network='testnet'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='P0002', message='STAKING_POLICY_NOT_PROVISIONED';
  END IF;
  IF v_control.approval_status <> 'pending' OR v_control.staking_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING errcode='55000', message='STAKING_POLICY_NOT_PENDING_REVIEW';
  END IF;

  SELECT * INTO v_policy FROM public.testnet_global_treasury_policy
  WHERE singleton_id=1 AND network='testnet' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='55000', message='GLOBAL_TESTNET_POLICY_NOT_CONFIGURED';
  END IF;

  SELECT * INTO v_treasury FROM public.project_treasury
  WHERE project_id=p_project_id AND network='testnet' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='55000', message='PROJECT_TREASURY_OR_TARGET_NOT_CONFIGURED';
  END IF;

  v_stage_rule := v_policy.staking_stage_policies -> v_project.staking_stage;
  SELECT max((value #>> '{}')::numeric) INTO v_max_reward_rate
  FROM jsonb_each(v_policy.staking_reward_rates_by_duration);

  IF jsonb_typeof(v_stage_rule) IS DISTINCT FROM 'object'
     OR v_max_reward_rate IS NULL
     OR v_control.minimum_liquidity IS DISTINCT FROM greatest(v_policy.minimum_project_liquidity,v_treasury.required_liquidity)
     OR v_control.capital_reserve_percent IS DISTINCT FROM (v_stage_rule->>'capital_reserve_percent')::numeric
     OR v_control.maximum_deployment_percent IS DISTINCT FROM (v_stage_rule->>'maximum_deployment_percent')::numeric
     OR v_control.max_active_principal IS DISTINCT FROM (v_stage_rule->>'max_active_principal')::numeric
     OR v_control.max_reward_rate IS DISTINCT FROM v_max_reward_rate
     OR v_control.reward_reserve_coverage_percent IS DISTINCT FROM v_policy.staking_reward_reserve_coverage_percent THEN
    RAISE EXCEPTION USING errcode='55000', message='TESTNET_RISK_CONTROLS_STALE_OR_POLICY_MISMATCH';
  END IF;

  v_previous_state := to_jsonb(v_control);
  PERFORM set_config('albukhr.testnet_staking_risk_control_review','on',true);
  UPDATE public.project_staking_risk_controls
  SET approval_status=p_decision, staking_enabled=false, updated_at=now()
  WHERE id=v_control.id AND network='testnet'
  RETURNING * INTO v_control;
  PERFORM set_config('albukhr.testnet_staking_risk_control_review',coalesce(nullif(v_prev_flag,''),'off'),true);

  INSERT INTO public.testnet_project_staking_risk_control_review_audit(
    network,project_id,project_code,admin_session_id,admin_actor_id,
    decision,previous_state,after_state
  ) VALUES (
    'testnet',v_project.id,v_project.project_code,v_admin.id,v_admin.admin_user_id,
    p_decision,v_previous_state,to_jsonb(v_control)
  );
  RETURN v_control;
END;
$function$;

REVOKE ALL ON FUNCTION public.review_testnet_project_staking_risk_control(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_testnet_project_staking_risk_control(uuid,uuid,text) TO service_role;
