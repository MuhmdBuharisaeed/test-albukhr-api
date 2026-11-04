-- ALBUKHR Testnet — Universal staking risk profile v1
-- Purpose: remove Testnet staking eligibility dependence on business lifecycle stage.
-- Scope: Testnet database only. Mainnet is not referenced or modified.
-- Safety: this migration never activates global or per-project staking.
-- Review before applying to any live database.

BEGIN;

ALTER TABLE public.testnet_global_treasury_policy
  ADD COLUMN IF NOT EXISTS staking_universal_risk_policy jsonb
  NOT NULL DEFAULT '{"capital_reserve_percent":50,"maximum_deployment_percent":25,"max_active_principal":100}'::jsonb;

ALTER TABLE public.testnet_global_treasury_policy
  ALTER COLUMN staking_universal_risk_policy
  SET DEFAULT '{"capital_reserve_percent":50,"maximum_deployment_percent":25,"max_active_principal":100}'::jsonb;

-- Install a version-aware source patch helper in this migration session only.
-- It refuses to replace a source fragment unless the exact expected count is found.
CREATE OR REPLACE FUNCTION pg_temp.albukhr_patch_function_source(
  p_signature regprocedure,
  p_replacements jsonb
) RETURNS void
LANGUAGE plpgsql
AS $helper$
DECLARE
  v_source text;
  v_item jsonb;
  v_old text;
  v_new text;
  v_expected integer;
  v_found integer;
BEGIN
  SELECT pg_get_functiondef(p_signature) INTO v_source;
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'UNIVERSAL_RISK_PATCH_FUNCTION_NOT_FOUND: %', p_signature;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_replacements)
  LOOP
    v_old := v_item ->> 'old';
    v_new := v_item ->> 'new';
    v_expected := coalesce((v_item ->> 'expected')::integer, 1);
    IF v_old IS NULL OR v_old = '' OR v_new IS NULL OR v_expected < 0 THEN
      RAISE EXCEPTION 'UNIVERSAL_RISK_PATCH_SPEC_INVALID: %', p_signature;
    END IF;

    v_found := (length(v_source) - length(replace(v_source, v_old, ''))) / length(v_old);
    IF v_found <> v_expected THEN
      RAISE EXCEPTION
        'UNIVERSAL_RISK_PATCH_SOURCE_MISMATCH: function %, expected %, found %, fragment %',
        p_signature, v_expected, v_found, left(v_old, 180);
    END IF;
    v_source := replace(v_source, v_old, v_new);
  END LOOP;

  EXECUTE v_source;
END;
$helper$;

-- The universal profile is validated even while global staking is inactive.
-- Legacy stage profiles remain validated below for old records/RPC compatibility.
SELECT pg_temp.albukhr_patch_function_source(
  'public.validate_testnet_global_staking_policy()'::regprocedure,
  jsonb_build_array(
    jsonb_build_object(
      'old', E'  IF NEW.staking_policy_active IS DISTINCT FROM true THEN\n    RETURN NEW;\n  END IF;',
      'new', E'  IF jsonb_typeof(NEW.staking_universal_risk_policy) IS DISTINCT FROM ''object''\n     OR jsonb_typeof(NEW.staking_universal_risk_policy->''capital_reserve_percent'') IS DISTINCT FROM ''number''\n     OR jsonb_typeof(NEW.staking_universal_risk_policy->''maximum_deployment_percent'') IS DISTINCT FROM ''number''\n     OR jsonb_typeof(NEW.staking_universal_risk_policy->''max_active_principal'') IS DISTINCT FROM ''number'' THEN\n    RAISE EXCEPTION USING errcode = ''22023'', message = ''GLOBAL_UNIVERSAL_RISK_POLICY_INVALID'';\n  END IF;\n\n  IF (NEW.staking_universal_risk_policy->>''capital_reserve_percent'')::numeric <> 50\n     OR (NEW.staking_universal_risk_policy->>''maximum_deployment_percent'')::numeric <> 25\n     OR (NEW.staking_universal_risk_policy->>''max_active_principal'')::numeric <> 100 THEN\n    RAISE EXCEPTION USING errcode = ''22023'', message = ''GLOBAL_UNIVERSAL_RISK_POLICY_MUST_MATCH_APPROVED_LIMITS'';\n  END IF;\n\n  IF NEW.staking_policy_active IS DISTINCT FROM true THEN\n    RETURN NEW;\n  END IF;',
      'expected', 1
    )
  )
);

-- Update coverage calculation: keep the return contract intact, but use the
-- universal risk policy instead of projects.staking_stage.
SELECT pg_temp.albukhr_patch_function_source(
  'public.get_testnet_staking_coverage(uuid)'::regprocedure,
  jsonb_build_array(
    jsonb_build_object('old', '      g.staking_stage_policies,', 'new', '      g.staking_universal_risk_policy,', 'expected', 1),
    jsonb_build_object('old', E'      p.staking_stage,\n', 'new', '', 'expected', 1),
    jsonb_build_object('old', '      pol.staking_stage_policies,', 'new', '      pol.staking_universal_risk_policy,', 'expected', 1),
    jsonb_build_object('old', E'      pol.staking_stage,\n', 'new', '', 'expected', 1),
    jsonb_build_object(
      'old', E'  stage_policy AS (\n    SELECT c.*, c.staking_stage_policies -> c.staking_stage AS stage_rule\n    FROM combined c\n  )',
      'new', E'  universal_policy AS (\n    SELECT c.*, c.staking_universal_risk_policy AS stage_rule\n    FROM combined c\n  )',
      'expected', 1
    ),
    jsonb_build_object(
      'old', E'    coalesce(c.staking_policy_active, false)\n      AND c.staking_stage IS NOT NULL\n      AND c.stage_rule IS NOT NULL',
      'new', E'    coalesce(c.staking_policy_active, false)\n      AND c.stage_rule IS NOT NULL',
      'expected', 1
    ),
    jsonb_build_object('old', '  FROM stage_policy c;', 'new', '  FROM universal_policy c;', 'expected', 1)
  )
);

-- Shared trigger guard protects both pending-control provisioning and the
-- subsequent Super Admin review. Stage profiles remain stored but no longer gate them.
SELECT pg_temp.albukhr_patch_function_source(
  'public.guard_testnet_project_local_staking_policy()'::regprocedure,
  jsonb_build_array(
    jsonb_build_object(
      'old', 'v_policy.staking_stage_policies -> v_project.staking_stage',
      'new', 'v_policy.staking_universal_risk_policy',
      'expected', 2
    ),
    jsonb_build_object('old', 'PROJECT_STAKING_STAGE_REQUIRED', 'new', 'GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED', 'expected', 1)
  )
);

SELECT pg_temp.albukhr_patch_function_source(
  'public.provision_testnet_project_staking_risk_control(uuid,uuid)'::regprocedure,
  jsonb_build_array(
    jsonb_build_object('old', 'v_policy.staking_stage_policies -> v_project.staking_stage', 'new', 'v_policy.staking_universal_risk_policy', 'expected', 1),
    jsonb_build_object('old', 'PROJECT_STAKING_STAGE_REQUIRED', 'new', 'GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED', 'expected', 1)
  )
);

SELECT pg_temp.albukhr_patch_function_source(
  'public.review_testnet_project_staking_risk_control(uuid,uuid,text)'::regprocedure,
  jsonb_build_array(
    jsonb_build_object('old', 'v_policy.staking_stage_policies -> v_project.staking_stage', 'new', 'v_policy.staking_universal_risk_policy', 'expected', 1)
  )
);

SELECT pg_temp.albukhr_patch_function_source(
  'public.update_testnet_project_staking_offer(uuid,text,integer,numeric)'::regprocedure,
  jsonb_build_array(
    jsonb_build_object('old', 'v_policy.staking_stage_policies -> v_project.staking_stage', 'new', 'v_policy.staking_universal_risk_policy', 'expected', 1),
    jsonb_build_object('old', 'PROJECT_STAKING_STAGE_REQUIRED', 'new', 'GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED', 'expected', 1)
  )
);

-- Investor intent creation keeps all existing checks (owner, approved project,
-- active project risk controls, global activation, duration/rate, liquidity,
-- reward reserve, liabilities and idempotency) but no longer needs a stage.
SELECT pg_temp.albukhr_patch_function_source(
  'public.create_testnet_stake_intent(uuid,text,text,numeric,integer)'::regprocedure,
  jsonb_build_array(
    jsonb_build_object(
      'old', E'  IF v_project.staking_stage IS NULL THEN\n    RAISE EXCEPTION USING errcode = ''55000'', message = ''PROJECT_STAKING_STAGE_NOT_CONFIGURED'';\n  END IF;\n\n',
      'new', '',
      'expected', 1
    ),
    jsonb_build_object(
      'old', 'v_policy.staking_stage_policies -> v_project.staking_stage',
      'new', 'v_policy.staking_universal_risk_policy',
      'expected', 1
    ),
    jsonb_build_object('old', 'GLOBAL_STAKING_STAGE_POLICY_NOT_CONFIGURED', 'new', 'GLOBAL_UNIVERSAL_RISK_POLICY_NOT_CONFIGURED', 'expected', 1),
    jsonb_build_object('old', 'GLOBAL_STAKING_STAGE_POLICY_INVALID', 'new', 'GLOBAL_UNIVERSAL_RISK_POLICY_INVALID', 'expected', 1)
  )
);

-- Apply the approved universal profile and increment only the staking policy
-- version. Explicitly preserve both activation flags as false.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.testnet_global_treasury_policy
    WHERE singleton_id = 1 AND network = 'testnet'
  ) THEN
    RAISE EXCEPTION 'TESTNET_GLOBAL_TREASURY_POLICY_SINGLETON_MISSING';
  END IF;
END;
$migration$;

UPDATE public.testnet_global_treasury_policy
SET staking_universal_risk_policy = jsonb_build_object(
      'capital_reserve_percent', 50,
      'maximum_deployment_percent', 25,
      'max_active_principal', 100
    ),
    staking_policy_version = GREATEST(staking_policy_version, 3),
    updated_at = now()
WHERE singleton_id = 1
  AND network = 'testnet';

-- Final invariant: never activate global staking in this migration.
DO $verify$
DECLARE
  v_policy public.testnet_global_treasury_policy%ROWTYPE;
BEGIN
  SELECT * INTO v_policy
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1 AND network = 'testnet';

  IF NOT FOUND
     OR v_policy.active IS DISTINCT FROM false
     OR v_policy.staking_policy_active IS DISTINCT FROM false
     OR v_policy.staking_universal_risk_policy IS DISTINCT FROM
       '{"capital_reserve_percent":50,"maximum_deployment_percent":25,"max_active_principal":100}'::jsonb
     OR v_policy.minimum_project_liquidity < 100
     OR v_policy.staking_minimum_stake_amount <> 10
     OR v_policy.staking_reward_reserve_coverage_percent < 100 THEN
    RAISE EXCEPTION 'TESTNET_UNIVERSAL_RISK_POLICY_POSTCHECK_FAILED';
  END IF;
END;
$verify$;

COMMIT;
