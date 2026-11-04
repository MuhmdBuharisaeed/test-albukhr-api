-- Read-only post-migration verification. Run after the DB migration and API/UI patches.
-- No rows are inserted, updated, or deleted.

DO $verify$
DECLARE
  v_policy public.testnet_global_treasury_policy%ROWTYPE;
  v_name text;
  v_def text;
BEGIN
  SELECT * INTO v_policy
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1 AND network = 'testnet';

  IF NOT FOUND THEN RAISE EXCEPTION 'TESTNET_POLICY_ROW_MISSING'; END IF;
  IF v_policy.active IS DISTINCT FROM false THEN RAISE EXCEPTION 'TESTNET_TREASURY_ACTIVATED_UNEXPECTEDLY'; END IF;
  IF v_policy.staking_policy_active IS DISTINCT FROM false THEN RAISE EXCEPTION 'TESTNET_STAKING_ACTIVATED_UNEXPECTEDLY'; END IF;
  IF v_policy.staking_universal_risk_policy IS DISTINCT FROM
    '{"capital_reserve_percent":50,"maximum_deployment_percent":25,"max_active_principal":100}'::jsonb
  THEN RAISE EXCEPTION 'TESTNET_UNIVERSAL_RISK_PROFILE_MISMATCH'; END IF;
  IF v_policy.minimum_project_liquidity < 100 THEN RAISE EXCEPTION 'MINIMUM_PROJECT_LIQUIDITY_DROPPED'; END IF;
  IF v_policy.staking_minimum_stake_amount <> 10 THEN RAISE EXCEPTION 'MINIMUM_STAKE_CHANGED'; END IF;
  IF v_policy.allowed_duration_days <> ARRAY[30,90,180,365,730,1095] THEN RAISE EXCEPTION 'ALLOWED_DURATIONS_CHANGED'; END IF;
  IF v_policy.staking_reward_rates_by_duration <>
    '{"30":0.01,"90":0.03,"180":0.06,"365":0.12,"730":0.24,"1095":0.36}'::jsonb
  THEN RAISE EXCEPTION 'REWARD_RATES_CHANGED'; END IF;
  IF v_policy.staking_reward_reserve_coverage_percent <> 100 THEN RAISE EXCEPTION 'REWARD_RESERVE_COVERAGE_CHANGED'; END IF;

  FOREACH v_name IN ARRAY ARRAY[
    'create_testnet_stake_intent',
    'get_testnet_staking_coverage',
    'guard_testnet_project_local_staking_policy',
    'provision_testnet_project_staking_risk_control',
    'review_testnet_project_staking_risk_control',
    'update_testnet_project_staking_offer'
  ] LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=v_name;
    IF v_def IS NULL THEN RAISE EXCEPTION 'REQUIRED_FUNCTION_MISSING: %', v_name; END IF;
    IF position('v_project.staking_stage' in v_def) > 0
       OR position('c.staking_stage' in v_def) > 0
       OR position('PROJECT_STAKING_STAGE_REQUIRED' in v_def) > 0
    THEN RAISE EXCEPTION 'STAGE_DEPENDENCY_REMAINS_IN_FUNCTION: %', v_name; END IF;
  END LOOP;

  -- Legacy stage RPC and project column remain for compatibility.
  IF to_regprocedure('public.set_testnet_project_staking_stage(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'LEGACY_STAGE_RPC_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='projects' AND column_name='staking_stage'
  ) THEN RAISE EXCEPTION 'LEGACY_STAKING_STAGE_COLUMN_MISSING'; END IF;
END;
$verify$;

SELECT 'PASS' AS result,
       (SELECT count(*) FROM public.projects WHERE network='testnet' AND status='approved') AS approved_testnet_projects,
       (SELECT count(*) FROM public.project_staking_risk_controls WHERE network='testnet') AS risk_control_rows,
       (SELECT count(*) FROM public.stakes WHERE network='testnet') AS stake_rows,
       active AS treasury_active,
       staking_policy_active
FROM public.testnet_global_treasury_policy
WHERE singleton_id=1 AND network='testnet';
