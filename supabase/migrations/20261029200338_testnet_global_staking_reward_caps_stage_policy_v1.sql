
BEGIN;

DO $guard$
DECLARE
  v_count integer;
  v_networks text[];
  v_active boolean;
BEGIN
  SELECT count(*), array_agg(network), bool_or(staking_policy_active)
    INTO v_count, v_networks, v_active
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1;

  IF v_count <> 1 OR v_networks IS DISTINCT FROM ARRAY['testnet']::text[] THEN
    RAISE EXCEPTION 'Expected exactly one global treasury policy row for Testnet';
  END IF;

  IF v_active IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Refusing to change reward caps while Testnet staking policy is active';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.projects
    WHERE network = 'testnet'
      AND staking_stage IS NOT NULL
      AND staking_stage NOT IN ('setup_pre_operation','construction_fit_out','operating_expansion')
  ) THEN
    RAISE EXCEPTION 'Unexpected Testnet staking_stage value';
  END IF;
END;
$guard$;

UPDATE public.testnet_global_treasury_policy
SET staking_reward_rates_by_duration = '{
  "30": 0.01,
  "90": 0.03,
  "180": 0.06,
  "365": 0.12,
  "730": 0.24,
  "1095": 0.36
}'::jsonb,
staking_stage_policies = '{
  "setup_pre_operation": {
    "capital_reserve_percent": 50,
    "maximum_deployment_percent": 25,
    "max_active_principal": 100
  },
  "construction_fit_out": {
    "capital_reserve_percent": 40,
    "maximum_deployment_percent": 40,
    "max_active_principal": 500
  },
  "operating_expansion": {
    "capital_reserve_percent": 30,
    "maximum_deployment_percent": 50,
    "max_active_principal": 2000
  }
}'::jsonb,
staking_policy_version = 2,
updated_at = now()
WHERE singleton_id = 1
  AND network = 'testnet'
  AND staking_policy_active IS FALSE;

DO $verify$
DECLARE
  v_record public.testnet_global_treasury_policy%ROWTYPE;
BEGIN
  SELECT * INTO v_record
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1 AND network = 'testnet';

  IF NOT FOUND
    OR v_record.staking_policy_active IS DISTINCT FROM false
    OR v_record.staking_reward_rates_by_duration <> '{
      "30": 0.01, "90": 0.03, "180": 0.06,
      "365": 0.12, "730": 0.24, "1095": 0.36
    }'::jsonb
    OR v_record.staking_stage_policies <> '{
      "setup_pre_operation": {
        "capital_reserve_percent": 50,
        "maximum_deployment_percent": 25,
        "max_active_principal": 100
      },
      "construction_fit_out": {
        "capital_reserve_percent": 40,
        "maximum_deployment_percent": 40,
        "max_active_principal": 500
      },
      "operating_expansion": {
        "capital_reserve_percent": 30,
        "maximum_deployment_percent": 50,
        "max_active_principal": 2000
      }
    }'::jsonb
    OR v_record.staking_policy_version <> 2
  THEN
    RAISE EXCEPTION 'Testnet global staking policy verification failed';
  END IF;
END;
$verify$;

COMMIT;
