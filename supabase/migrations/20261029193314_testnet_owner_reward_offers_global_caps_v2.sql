-- Testnet only: project owners submit the reward offer; ALBUKHR global
-- per-duration rates are maximum caps. Policy stays inactive.
CREATE OR REPLACE FUNCTION public.guard_testnet_project_local_staking_policy()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_policy public.testnet_global_treasury_policy%ROWTYPE;
  v_cap numeric;
BEGIN
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
$function$;
CREATE OR REPLACE FUNCTION public.update_testnet_project_staking_offer(p_project_id uuid,p_pi_uid text,p_duration_days integer,p_reward_rate numeric)
RETURNS public.project_staking_terms LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
 v_project public.projects%ROWTYPE;
 v_owner_id uuid;
 v_policy public.testnet_global_treasury_policy%ROWTYPE;
 v_offer public.project_staking_terms%ROWTYPE;
 v_uid text:=nullif(trim(coalesce(p_pi_uid,'')),'');
 v_reward_rate numeric:=round(coalesce(p_reward_rate,0)::numeric,8);
 v_reward_cap numeric;
 v_prev text:=current_setting('albukhr.testnet_staking_offer_write',true);
BEGIN
 IF p_project_id IS NULL OR v_uid IS NULL THEN RAISE EXCEPTION USING errcode='42501',message='PROJECT_OWNER_ACCESS_DENIED'; END IF;
 IF p_duration_days IS NULL OR p_duration_days<=0 THEN RAISE EXCEPTION USING errcode='22023',message='STAKING_DURATION_NOT_ALLOWED'; END IF;
 IF p_reward_rate IS NULL OR p_reward_rate::text IN ('NaN','Infinity','-Infinity') OR v_reward_rate<=0 OR v_reward_rate>1 THEN
   RAISE EXCEPTION USING errcode='22023',message='STAKING_REWARD_RATE_INVALID';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('albukhr:testnet:owner-offer:'||p_project_id::text||':'||p_duration_days::text,0));
 SELECT * INTO v_project FROM public.projects WHERE id=p_project_id AND network='testnet' AND status='approved' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING errcode='42501',message='PROJECT_OWNER_ACCESS_DENIED'; END IF;
 SELECT u.id INTO v_owner_id FROM public.users u WHERE u.pi_uid=v_uid AND u.network='testnet' FOR SHARE;
 IF NOT FOUND OR v_project.owner_user_id IS DISTINCT FROM v_owner_id THEN
   RAISE EXCEPTION USING errcode='42501',message='PROJECT_OWNER_ACCESS_DENIED';
 END IF;
 SELECT * INTO v_policy FROM public.testnet_global_treasury_policy WHERE singleton_id=1 AND network='testnet' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION USING errcode='55000',message='GLOBAL_TESTNET_POLICY_NOT_CONFIGURED'; END IF;
 IF NOT (p_duration_days=ANY(v_policy.allowed_duration_days)) THEN RAISE EXCEPTION USING errcode='22023',message='STAKING_DURATION_NOT_ALLOWED'; END IF;
 IF jsonb_typeof(v_policy.staking_reward_rates_by_duration)<>'object'
   OR nullif(v_policy.staking_reward_rates_by_duration ->> p_duration_days::text,'') IS NULL THEN
   RAISE EXCEPTION USING errcode='55000',message='STAKING_REWARD_LIMIT_NOT_CONFIGURED';
 END IF;
 v_reward_cap := (v_policy.staking_reward_rates_by_duration ->> p_duration_days::text)::numeric;
 IF v_reward_cap<=0 OR v_reward_cap>1 THEN RAISE EXCEPTION USING errcode='55000',message='STAKING_REWARD_LIMIT_CONFIGURATION_INVALID'; END IF;
 IF v_reward_rate>v_reward_cap THEN RAISE EXCEPTION USING errcode='22023',message='STAKING_REWARD_RATE_EXCEEDS_ALBUKHR_LIMIT'; END IF;
 PERFORM set_config('albukhr.testnet_staking_offer_write','on',true);
 SELECT * INTO v_offer FROM public.project_staking_terms
 WHERE project_code=v_project.project_code AND network='testnet' AND duration_days=p_duration_days FOR UPDATE;
 IF FOUND THEN
   UPDATE public.project_staking_terms SET min_stake=v_policy.staking_minimum_stake_amount,reward_rate=v_reward_rate,active=true,updated_at=now()
   WHERE id=v_offer.id RETURNING * INTO v_offer;
 ELSE
   INSERT INTO public.project_staking_terms(project_code,network,duration_days,min_stake,reward_rate,active)
   VALUES(v_project.project_code,'testnet',p_duration_days,v_policy.staking_minimum_stake_amount,v_reward_rate,true)
   RETURNING * INTO v_offer;
 END IF;
 PERFORM set_config('albukhr.testnet_staking_offer_write',coalesce(nullif(v_prev,''),'off'),true);
 RETURN v_offer;
END;
$function$;
CREATE OR REPLACE FUNCTION public.create_testnet_stake_intent(p_project_id uuid, p_project_code text, p_pi_uid text, p_amount numeric, p_duration_days integer)
 RETURNS testnet_stake_intents
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_project public.projects%ROWTYPE;
  v_treasury public.project_treasury%ROWTYPE;
  v_policy public.testnet_global_treasury_policy%ROWTYPE;
  v_stage_policy jsonb;
  v_coverage record;
  v_intent public.testnet_stake_intents%ROWTYPE;
  v_term public.project_staking_terms%ROWTYPE;
  v_reward_cap numeric;
  v_amount numeric := round(coalesce(p_amount, 0)::numeric, 7);
  v_uid text := nullif(trim(p_pi_uid), '');
  v_reward_rate numeric;
  v_min_stake numeric;
  v_reward numeric;
  v_capital_reserve_percent numeric;
  v_maximum_deployment_percent numeric;
  v_max_active_principal numeric;
  v_deployment_percent numeric;
BEGIN
  IF p_project_id IS NULL OR nullif(trim(p_project_code), '') IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PROJECT_ID_AND_CODE_REQUIRED';
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PI_UID_REQUIRED';
  END IF;
  IF v_amount <= 0 OR p_duration_days IS NULL OR p_duration_days <= 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_AMOUNT_AND_DURATION_REQUIRED';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('albukhr:testnet:staking:' || p_project_id::text, 0)
  );

  IF EXISTS (
    SELECT 1 FROM public.testnet_stake_intents
    WHERE project_id = p_project_id AND network = 'testnet'
      AND pi_uid = v_uid AND status = 'pending_payment'
  ) THEN
    RAISE EXCEPTION USING errcode = '23505', message = 'STAKE_INTENT_ALREADY_PENDING';
  END IF;

  SELECT * INTO v_project
  FROM public.projects
  WHERE id = p_project_id AND project_code = trim(p_project_code)
    AND network = 'testnet' AND status = 'approved'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PROJECT_NOT_APPROVED_FOR_TESTNET_STAKING';
  END IF;

  SELECT * INTO v_policy
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1 AND network = 'testnet'
  FOR SHARE;
  IF NOT FOUND OR v_policy.staking_policy_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_STAKING_POLICY_INACTIVE';
  END IF;

  IF NOT (p_duration_days = ANY(v_policy.allowed_duration_days)) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKING_DURATION_NOT_ALLOWED';
  END IF;

  SELECT * INTO v_term
  FROM public.project_staking_terms
  WHERE project_code = v_project.project_code AND network = 'testnet'
    AND duration_days = p_duration_days AND active IS TRUE
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'STAKING_OFFER_NOT_CONFIGURED';
  END IF;

  IF jsonb_typeof(v_policy.staking_reward_rates_by_duration) <> 'object'
     OR nullif(v_policy.staking_reward_rates_by_duration ->> p_duration_days::text, '') IS NULL THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'STAKING_REWARD_LIMIT_NOT_CONFIGURED';
  END IF;

  v_reward_cap := (v_policy.staking_reward_rates_by_duration ->> p_duration_days::text)::numeric;
  v_reward_rate := v_term.reward_rate;
  IF v_reward_cap <= 0 OR v_reward_cap > 1 OR v_reward_rate <= 0 OR v_reward_rate > v_reward_cap THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKING_REWARD_RATE_EXCEEDS_ALBUKHR_LIMIT';
  END IF;

  IF v_project.staking_stage IS NULL THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'PROJECT_STAKING_STAGE_NOT_CONFIGURED';
  END IF;

  v_stage_policy := v_policy.staking_stage_policies -> v_project.staking_stage;
  IF jsonb_typeof(v_stage_policy) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_STAKING_STAGE_POLICY_NOT_CONFIGURED';
  END IF;

  v_capital_reserve_percent := (v_stage_policy ->> 'capital_reserve_percent')::numeric;
  v_maximum_deployment_percent := (v_stage_policy ->> 'maximum_deployment_percent')::numeric;
  v_max_active_principal := (v_stage_policy ->> 'max_active_principal')::numeric;
  IF v_capital_reserve_percent < 0 OR v_capital_reserve_percent > 100
     OR v_maximum_deployment_percent < 0 OR v_maximum_deployment_percent > 100
     OR v_capital_reserve_percent + v_maximum_deployment_percent > 100
     OR v_max_active_principal <= 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'GLOBAL_STAKING_STAGE_POLICY_INVALID';
  END IF;

  v_min_stake := v_policy.staking_minimum_stake_amount;
  IF v_amount < v_min_stake THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_AMOUNT_BELOW_GLOBAL_MINIMUM';
  END IF;

  SELECT * INTO v_treasury
  FROM public.project_treasury
  WHERE project_id = p_project_id AND network = 'testnet'
  FOR SHARE;

  IF NOT FOUND
     OR v_treasury.status <> 'active'
     OR nullif(trim(coalesce(v_treasury.treasury_wallet, '')), '') IS NULL
     OR v_treasury.verified_liquidity < v_policy.minimum_project_liquidity
     OR v_treasury.required_liquidity < v_policy.minimum_project_liquidity THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PROJECT_LIQUIDITY_REQUIREMENT_NOT_MET';
  END IF;

  v_reward := round(v_amount * v_reward_rate, 7);
  IF v_reward <= 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_REWARD_MUST_BE_POSITIVE';
  END IF;

  SELECT * INTO v_coverage
  FROM public.get_testnet_staking_coverage(p_project_id);
  IF coalesce(v_coverage.staking_eligible, false) IS NOT TRUE THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'STAKING_LIQUIDITY_COVERAGE_NOT_ELIGIBLE';
  END IF;
  IF coalesce(v_coverage.owner_liquidity_available, 0) < v_reward THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'REWARD_LIQUIDITY_RESERVE_INSUFFICIENT';
  END IF;
  IF coalesce(v_coverage.outstanding_principal, 0) + v_amount > v_max_active_principal THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'PROJECT_ACTIVE_STAKING_CAP_REACHED';
  END IF;
  IF coalesce(v_coverage.total_tracked_assets, 0) <
       coalesce(v_coverage.total_liability, 0) + v_reward THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'STAKING_COVERAGE_INSUFFICIENT';
  END IF;

  v_deployment_percent := least(
    v_maximum_deployment_percent,
    100 - v_capital_reserve_percent
  );

  INSERT INTO public.testnet_stake_intents (
    project_id, project_code, pi_uid, network, amount, duration_days,
    reward_rate, reward_amount, capital_reserve_percent,
    maximum_deployment_percent, status, expires_at, metadata
  )
  VALUES (
    v_project.id, v_project.project_code, v_uid, 'testnet', v_amount, p_duration_days,
    v_reward_rate, v_reward, v_capital_reserve_percent,
    v_deployment_percent, 'pending_payment', now() + interval '20 minutes',
    jsonb_build_object(
      'origin', 'testnet_staking',
      'policy_version', v_policy.staking_policy_version,
      'reward_withdrawal', 'immediate',
      'capital_unlock_days', p_duration_days,
      'policy_source', 'testnet_global_treasury_policy'
    )
  )
  RETURNING * INTO v_intent;

  INSERT INTO public.project_staking_ledger (
    network, project_id, bucket, movement, event_type, amount,
    source_type, source_id, idempotency_key, metadata
  )
  VALUES
  (
    'testnet', v_project.id, 'owner_liquidity', 'debit', 'reward_reserved',
    v_reward, 'stake_intent_reward', v_intent.id::text,
    'intent:' || v_intent.id::text || ':reward-source',
    jsonb_build_object('pi_uid', v_uid, 'payment_intent', v_intent.id, 'network', 'testnet')
  ),
  (
    'testnet', v_project.id, 'reward_reserve', 'credit', 'reward_reserved',
    v_reward, 'stake_intent_reward', v_intent.id::text,
    'intent:' || v_intent.id::text || ':reward-reserve',
    jsonb_build_object('pi_uid', v_uid, 'payment_intent', v_intent.id, 'network', 'testnet',
      'policy_version', v_policy.staking_policy_version)
  );

  RETURN v_intent;
END;
$function$;
REVOKE ALL ON FUNCTION public.update_testnet_project_staking_offer(uuid,text,integer,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_testnet_project_staking_offer(uuid,text,integer,numeric) TO service_role;
