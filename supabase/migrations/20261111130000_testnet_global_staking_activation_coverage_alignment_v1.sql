-- ALBUKHR Testnet: align global staking reactivation with verified liquidity coverage.
-- TESTNET ONLY. This migration changes one activation predicate only.
--
-- Safety:
--   * Does not pause or enable Global Treasury or Global Staking.
--   * Does not update project, treasury, stake, payment, or ledger rows.
--   * Retains verified_liquidity_contributed >= required_liquidity.
--   * Retains liquidity_buffer >= minimum_project_liquidity.
--   * Retains solvency, reward-reserve, risk, offer, wallet, and approval checks.
--   * Retains the existing SECURITY DEFINER and service_role-only ACL.
--
-- The previous predicate required owner_liquidity_available >= 100 PI
-- independently of the liquidity_buffer. That contradicted the authoritative
-- coverage function, where liquidity_buffer = owner_liquidity_available
-- + reward_reserve_balance. The independent verified contribution check
-- remains in place, so reward reserves cannot replace verified contributed
-- liquidity.

BEGIN;

DO $migration$
DECLARE
  v_function regprocedure :=
    'public.set_testnet_global_transaction_control(uuid,text,boolean,text,text,boolean,boolean)'::regprocedure;
  v_definition text;
  v_patched_definition text;
  v_after_definition text;
  v_old_line text :=
    repeat(' ', 8)
    || 'AND cv.owner_liquidity_available >= v_policy.minimum_project_liquidity'
    || chr(10);
  v_before_treasury_active boolean;
  v_before_staking_active boolean;
  v_after_treasury_active boolean;
  v_after_staking_active boolean;
  v_security_definer boolean;
  v_function_config text[];
  v_required_fragments text[] := ARRAY[
    'p.status = ''approved''',
    'c.staking_enabled IS TRUE',
    'c.approval_status = ''approved''',
    'c.capital_reserve_percent = 50',
    'c.maximum_deployment_percent = 25',
    'c.max_active_principal = 100',
    't.status = ''active''',
    'trim(coalesce(t.treasury_wallet, '''')) = trim(v_policy.treasury_wallet)',
    'coalesce(cv.verified_liquidity_contributed, 0) >= t.required_liquidity',
    'cv.liquidity_buffer >= v_policy.minimum_project_liquidity',
    'cv.total_tracked_assets >= cv.total_liability',
    'cv.reward_reserve_balance >=',
    'o.duration_days = ANY(v_policy.allowed_duration_days)',
    'o.reward_rate <=',
    'NOT EXISTS ('
  ];
  v_fragment text;
BEGIN
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: global Testnet transaction control function is missing';
  END IF;

  SELECT active, staking_policy_active
    INTO v_before_treasury_active, v_before_staking_active
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1
    AND network = 'testnet';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: Testnet global policy row is missing';
  END IF;

  SELECT pg_get_functiondef(p.oid), p.prosecdef, p.proconfig
    INTO v_definition, v_security_definer, v_function_config
  FROM pg_proc p
  WHERE p.oid = v_function::oid;

  IF v_security_definer IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: function must remain SECURITY DEFINER';
  END IF;

  IF NOT coalesce(v_function_config @> ARRAY['search_path=""']::text[], false) THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: function search_path is not locked to empty';
  END IF;

  -- Fail closed unless the exact redundant predicate exists exactly once.
  IF length(v_definition) - length(replace(v_definition, v_old_line, ''))
       <> length(v_old_line) THEN
    RAISE EXCEPTION
      'PRECHECK_FAILED: expected owner-liquidity predicate was not found exactly once; no change applied';
  END IF;

  -- Confirm all independent activation safeguards exist before patching.
  FOREACH v_fragment IN ARRAY v_required_fragments LOOP
    IF position(v_fragment IN v_definition) = 0 THEN
      RAISE EXCEPTION
        'PRECHECK_FAILED: required activation safeguard is missing: %',
        v_fragment;
    END IF;
  END LOOP;

  v_patched_definition := replace(v_definition, v_old_line, '');

  IF v_patched_definition = v_definition
     OR position(
       'cv.owner_liquidity_available >= v_policy.minimum_project_liquidity'
       IN v_patched_definition
     ) > 0 THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: exact predicate removal could not be verified';
  END IF;

  -- Recreate the existing function from its live definition, changing only
  -- the one redundant owner-only predicate. All other function logic remains.
  EXECUTE v_patched_definition;

  SELECT pg_get_functiondef(p.oid), p.prosecdef, p.proconfig
    INTO v_after_definition, v_security_definer, v_function_config
  FROM pg_proc p
  WHERE p.oid = v_function::oid;

  IF v_security_definer IS DISTINCT FROM true
     OR NOT coalesce(v_function_config @> ARRAY['search_path=""']::text[], false) THEN
    RAISE EXCEPTION 'POSTCHECK_FAILED: function security configuration changed';
  END IF;

  IF position(
       'cv.owner_liquidity_available >= v_policy.minimum_project_liquidity'
       IN v_after_definition
     ) > 0 THEN
    RAISE EXCEPTION 'POSTCHECK_FAILED: redundant owner-only predicate remains';
  END IF;

  FOREACH v_fragment IN ARRAY v_required_fragments LOOP
    IF position(v_fragment IN v_after_definition) = 0 THEN
      RAISE EXCEPTION
        'POSTCHECK_FAILED: required activation safeguard is missing: %',
        v_fragment;
    END IF;
  END LOOP;

  -- Confirm the global activation flags were not touched by this migration.
  SELECT active, staking_policy_active
    INTO v_after_treasury_active, v_after_staking_active
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1
    AND network = 'testnet';

  IF v_after_treasury_active IS DISTINCT FROM v_before_treasury_active
     OR v_after_staking_active IS DISTINCT FROM v_before_staking_active THEN
    RAISE EXCEPTION 'POSTCHECK_FAILED: global activation flags changed unexpectedly';
  END IF;

  -- Preserve the service-role-only execution boundary.
  IF has_function_privilege('anon', v_function, 'EXECUTE')
     OR has_function_privilege('authenticated', v_function, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_function, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCHECK_FAILED: function execution privileges are not service_role-only';
  END IF;
END;
$migration$;

COMMIT;
