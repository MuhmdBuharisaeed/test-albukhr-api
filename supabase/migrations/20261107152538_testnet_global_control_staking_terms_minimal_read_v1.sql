BEGIN;

DO $preflight$
DECLARE
  v_rls_enabled boolean;
BEGIN
  IF to_regclass('public.project_staking_terms') IS NULL THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: public.project_staking_terms does not exist in the connected Testnet database';
  END IF;

  SELECT c.relrowsecurity
    INTO v_rls_enabled
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'project_staking_terms'
    AND c.relkind = 'r';

  IF v_rls_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: RLS must remain enabled on public.project_staking_terms';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: service_role does not exist';
  END IF;

  IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'project_staking_terms'
        AND column_name = 'project_code'
    )
    OR NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'project_staking_terms'
        AND column_name = 'duration_days'
    )
    OR NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'project_staking_terms'
        AND column_name = 'min_stake'
    )
    OR NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'project_staking_terms'
        AND column_name = 'reward_rate'
    )
    OR NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'project_staking_terms'
        AND column_name = 'active'
    )
    OR NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'project_staking_terms'
        AND column_name = 'network'
    ) THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: one or more required staking-offer columns are missing';
  END IF;

  IF has_column_privilege('anon', 'public.project_staking_terms', 'project_code', 'SELECT')
     OR has_column_privilege('authenticated', 'public.project_staking_terms', 'project_code', 'SELECT') THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: browser roles unexpectedly have SELECT on project_staking_terms';
  END IF;
END;
$preflight$;

-- Least-privilege server access for the Testnet API read paths.
-- The API explicitly selects and filters only these six columns.
-- No table-wide SELECT, browser-role grant, RLS change, or data write is made.
GRANT SELECT (
  project_code,
  duration_days,
  min_stake,
  reward_rate,
  active,
  network
) ON TABLE public.project_staking_terms TO service_role;

DO $verify$
BEGIN
  IF NOT has_column_privilege('service_role', 'public.project_staking_terms', 'project_code', 'SELECT')
     OR NOT has_column_privilege('service_role', 'public.project_staking_terms', 'duration_days', 'SELECT')
     OR NOT has_column_privilege('service_role', 'public.project_staking_terms', 'min_stake', 'SELECT')
     OR NOT has_column_privilege('service_role', 'public.project_staking_terms', 'reward_rate', 'SELECT')
     OR NOT has_column_privilege('service_role', 'public.project_staking_terms', 'active', 'SELECT')
     OR NOT has_column_privilege('service_role', 'public.project_staking_terms', 'network', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCHECK_FAILED: service_role does not have all six required column SELECT privileges';
  END IF;

  IF has_column_privilege('anon', 'public.project_staking_terms', 'project_code', 'SELECT')
     OR has_column_privilege('authenticated', 'public.project_staking_terms', 'project_code', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCHECK_FAILED: browser roles gained SELECT access';
  END IF;

  IF has_column_privilege('service_role', 'public.project_staking_terms', 'id', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCHECK_FAILED: service_role has unexpected SELECT access to the id column';
  END IF;
END;
$verify$;

COMMIT;
