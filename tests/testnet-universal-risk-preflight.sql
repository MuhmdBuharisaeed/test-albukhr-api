-- Read-only preflight for the universal-risk migration.
-- Run against the Testnet Supabase project before applying the migration.
-- This script makes no changes.

WITH funcs AS (
  SELECT p.proname, pg_get_functiondef(p.oid) AS src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'validate_testnet_global_staking_policy',
      'get_testnet_staking_coverage',
      'guard_testnet_project_local_staking_policy',
      'provision_testnet_project_staking_risk_control',
      'review_testnet_project_staking_risk_control',
      'update_testnet_project_staking_offer',
      'create_testnet_stake_intent'
    )
), expected(proname, needle, expected_count) AS (
  VALUES
    ('validate_testnet_global_staking_policy', E'  IF NEW.staking_policy_active IS DISTINCT FROM true THEN\n    RETURN NEW;\n  END IF;', 1),
    ('get_testnet_staking_coverage', '      g.staking_stage_policies,', 1),
    ('get_testnet_staking_coverage', E'      p.staking_stage,\n', 1),
    ('get_testnet_staking_coverage', '      pol.staking_stage_policies,', 1),
    ('get_testnet_staking_coverage', E'      pol.staking_stage,\n', 1),
    ('get_testnet_staking_coverage', E'  stage_policy AS (\n    SELECT c.*, c.staking_stage_policies -> c.staking_stage AS stage_rule\n    FROM combined c\n  )', 1),
    ('get_testnet_staking_coverage', E'    coalesce(c.staking_policy_active, false)\n      AND c.staking_stage IS NOT NULL\n      AND c.stage_rule IS NOT NULL', 1),
    ('get_testnet_staking_coverage', '  FROM stage_policy c;', 1),
    ('guard_testnet_project_local_staking_policy', 'v_policy.staking_stage_policies -> v_project.staking_stage', 2),
    ('guard_testnet_project_local_staking_policy', 'PROJECT_STAKING_STAGE_REQUIRED', 1),
    ('provision_testnet_project_staking_risk_control', 'v_policy.staking_stage_policies -> v_project.staking_stage', 1),
    ('provision_testnet_project_staking_risk_control', 'PROJECT_STAKING_STAGE_REQUIRED', 1),
    ('review_testnet_project_staking_risk_control', 'v_policy.staking_stage_policies -> v_project.staking_stage', 1),
    ('update_testnet_project_staking_offer', 'v_policy.staking_stage_policies -> v_project.staking_stage', 1),
    ('update_testnet_project_staking_offer', 'PROJECT_STAKING_STAGE_REQUIRED', 1),
    ('create_testnet_stake_intent', E'  IF v_project.staking_stage IS NULL THEN\n    RAISE EXCEPTION USING errcode = ''55000'', message = ''PROJECT_STAKING_STAGE_NOT_CONFIGURED'';\n  END IF;\n\n', 1),
    ('create_testnet_stake_intent', 'v_policy.staking_stage_policies -> v_project.staking_stage', 1),
    ('create_testnet_stake_intent', 'GLOBAL_STAKING_STAGE_POLICY_NOT_CONFIGURED', 1),
    ('create_testnet_stake_intent', 'GLOBAL_STAKING_STAGE_POLICY_INVALID', 1)
), results AS (
  SELECT e.proname, e.expected_count,
    CASE WHEN d.src IS NULL OR length(e.needle) = 0 THEN NULL
      ELSE (length(d.src) - length(replace(d.src, e.needle, ''))) / length(e.needle)
    END AS actual_count
  FROM expected e
  LEFT JOIN funcs d USING (proname)
)
SELECT proname, expected_count, actual_count,
       CASE WHEN actual_count = expected_count THEN 'PASS' ELSE 'FAIL' END AS status
FROM results
ORDER BY proname, actual_count;

-- The migration must only be applied if all rows above report PASS.
-- Also inspect the current Testnet policy and activation flags:
SELECT singleton_id, network, active, staking_policy_active,
       minimum_project_liquidity, staking_minimum_stake_amount,
       allowed_duration_days, staking_reward_rates_by_duration,
       staking_stage_policies, staking_policy_version
FROM public.testnet_global_treasury_policy
WHERE singleton_id = 1 AND network = 'testnet';
