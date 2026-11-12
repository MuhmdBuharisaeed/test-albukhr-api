
CREATE OR REPLACE FUNCTION public.update_testnet_project_staking_offer(
  p_project_id uuid,
  p_pi_uid text,
  p_duration_days integer,
  p_reward_rate numeric
)
RETURNS public.project_staking_terms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_project public.projects%ROWTYPE;
  v_owner_id uuid;
  v_policy public.testnet_global_treasury_policy%ROWTYPE;
  v_treasury public.project_treasury%ROWTYPE;
  v_controls public.project_staking_risk_controls%ROWTYPE;
  v_offer public.project_staking_terms%ROWTYPE;
  v_stage_rule jsonb;
  v_reward_rate numeric := round(coalesce(p_reward_rate, 0)::numeric, 8);
  v_reward_cap numeric;
  v_global_max_reward_rate numeric;
  v_expected_minimum_liquidity numeric;
  v_prev text := current_setting('albukhr.testnet_staking_offer_write', true);
  v_uid text := nullif(trim(coalesce(p_pi_uid, '')), '');
BEGIN
  IF p_project_id IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION USING errcode='42501', message='PROJECT_OWNER_ACCESS_DENIED';
  END IF;

  IF p_duration_days IS NULL OR p_duration_days <= 0 THEN
    RAISE EXCEPTION USING errcode='22023', message='STAKING_DURATION_NOT_ALLOWED';
  END IF;

  IF p_reward_rate IS NULL
     OR p_reward_rate::text IN ('NaN','Infinity','-Infinity')
     OR v_reward_rate <= 0
     OR v_reward_rate > 1 THEN
    RAISE EXCEPTION USING errcode='22023', message='STAKING_REWARD_RATE_INVALID';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'albukhr:testnet:owner-offer:' ||
      p_project_id::text || ':' || p_duration_days::text,
      0
    )
  );

  SELECT *
  INTO v_project
  FROM public.projects
  WHERE id = p_project_id
    AND network = 'testnet'
    AND status = 'approved'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='42501', message='PROJECT_OWNER_ACCESS_DENIED';
  END IF;

  SELECT u.id
  INTO v_owner_id
  FROM public.users u
  WHERE u.pi_uid = v_uid
    AND u.network = 'testnet'
  FOR SHARE;

  IF NOT FOUND OR v_project.owner_user_id IS DISTINCT FROM v_owner_id THEN
    RAISE EXCEPTION USING errcode='42501', message='PROJECT_OWNER_ACCESS_DENIED';
  END IF;

  SELECT *
  INTO v_policy
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1
    AND network = 'testnet'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='55000', message='GLOBAL_TESTNET_POLICY_NOT_CONFIGURED';
  END IF;

  IF NOT coalesce(
    p_duration_days = ANY(v_policy.allowed_duration_days),
    false
  ) THEN
    RAISE EXCEPTION USING errcode='22023', message='STAKING_DURATION_NOT_ALLOWED';
  END IF;

  IF jsonb_typeof(v_policy.staking_reward_rates_by_duration) IS DISTINCT FROM 'object'
     OR nullif(v_policy.staking_reward_rates_by_duration ->> p_duration_days::text, '') IS NULL THEN
    RAISE EXCEPTION USING errcode='55000', message='STAKING_REWARD_LIMIT_NOT_CONFIGURED';
  END IF;

  v_reward_cap :=
    (v_policy.staking_reward_rates_by_duration ->> p_duration_days::text)::numeric;

  IF v_reward_cap <= 0 OR v_reward_cap > 1 THEN
    RAISE EXCEPTION USING errcode='55000', message='STAKING_REWARD_LIMIT_CONFIGURATION_INVALID';
  END IF;

  IF v_reward_rate > v_reward_cap THEN
    RAISE EXCEPTION USING errcode='22023', message='STAKING_REWARD_RATE_EXCEEDS_ALBUKHR_LIMIT';
  END IF;

  SELECT *
  INTO v_treasury
  FROM public.project_treasury
  WHERE project_id = p_project_id
    AND network = 'testnet'
  FOR SHARE;

  IF NOT FOUND
     OR v_treasury.status IS DISTINCT FROM 'active'
     OR nullif(trim(coalesce(v_treasury.treasury_wallet, '')), '') IS NULL
     OR v_treasury.required_liquidity IS NULL
     OR v_treasury.required_liquidity < v_policy.minimum_project_liquidity THEN
    RAISE EXCEPTION USING errcode='55000', message='PROJECT_TREASURY_NOT_CONFIGURED';
  END IF;

  v_expected_minimum_liquidity :=
    greatest(v_policy.minimum_project_liquidity, v_treasury.required_liquidity);

  v_stage_rule :=
    v_policy.staking_stage_policies -> v_project.staking_stage;

  IF jsonb_typeof(v_stage_rule) IS DISTINCT FROM 'object'
     OR nullif(v_stage_rule ->> 'capital_reserve_percent', '') IS NULL
     OR nullif(v_stage_rule ->> 'maximum_deployment_percent', '') IS NULL
     OR nullif(v_stage_rule ->> 'max_active_principal', '') IS NULL THEN
    RAISE EXCEPTION USING errcode='55000', message='PROJECT_STAKING_STAGE_REQUIRED';
  END IF;

  IF jsonb_typeof(v_policy.staking_reward_rates_by_duration) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode='55000', message='STAKING_REWARD_LIMIT_NOT_CONFIGURED';
  END IF;

  SELECT max((value #>> '{}')::numeric)
  INTO v_global_max_reward_rate
  FROM jsonb_each(v_policy.staking_reward_rates_by_duration);

  IF v_global_max_reward_rate IS NULL
     OR v_global_max_reward_rate <= 0
     OR v_global_max_reward_rate > 1 THEN
    RAISE EXCEPTION USING errcode='55000', message='STAKING_REWARD_LIMIT_CONFIGURATION_INVALID';
  END IF;

  SELECT *
  INTO v_controls
  FROM public.project_staking_risk_controls
  WHERE project_id = p_project_id
    AND network = 'testnet'
  FOR SHARE;

  IF NOT FOUND OR v_controls.approval_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION USING errcode='55000', message='STAKING_POLICY_NOT_APPROVED';
  END IF;

  IF v_controls.minimum_liquidity IS DISTINCT FROM v_expected_minimum_liquidity
     OR v_controls.capital_reserve_percent IS DISTINCT FROM (v_stage_rule ->> 'capital_reserve_percent')::numeric
     OR v_controls.maximum_deployment_percent IS DISTINCT FROM (v_stage_rule ->> 'maximum_deployment_percent')::numeric
     OR v_controls.max_active_principal IS DISTINCT FROM (v_stage_rule ->> 'max_active_principal')::numeric
     OR v_controls.max_reward_rate IS DISTINCT FROM v_global_max_reward_rate
     OR v_controls.reward_reserve_coverage_percent IS DISTINCT FROM v_policy.staking_reward_reserve_coverage_percent THEN
    RAISE EXCEPTION USING errcode='55000', message='STAKING_POLICY_REVIEW_STALE';
  END IF;

  -- Deliberately do not require staking_policy_active=true here.
  -- Owners may configure offers after risk approval while global
  -- Testnet staking remains paused. Investor staking has separate gates.
  PERFORM set_config('albukhr.testnet_staking_offer_write', 'on', true);

  SELECT *
  INTO v_offer
  FROM public.project_staking_terms
  WHERE project_code = v_project.project_code
    AND network = 'testnet'
    AND duration_days = p_duration_days
  FOR UPDATE;

  IF FOUND THEN
    UPDATE public.project_staking_terms
    SET min_stake = v_policy.staking_minimum_stake_amount,
        reward_rate = v_reward_rate,
        active = true,
        updated_at = now()
    WHERE id = v_offer.id
    RETURNING * INTO v_offer;
  ELSE
    INSERT INTO public.project_staking_terms (
      project_code,
      network,
      duration_days,
      min_stake,
      reward_rate,
      active
    )
    VALUES (
      v_project.project_code,
      'testnet',
      p_duration_days,
      v_policy.staking_minimum_stake_amount,
      v_reward_rate,
      true
    )
    RETURNING * INTO v_offer;
  END IF;

  PERFORM set_config(
    'albukhr.testnet_staking_offer_write',
    coalesce(nullif(v_prev, ''), 'off'),
    true
  );

  RETURN v_offer;
END;
$function$;
