-- Read-only postflight for the Testnet global-staking terms permission fix.
-- Run against the TESTNET Supabase project only. This script makes no writes.

-- 1. Simulate the service_role read used by the backend Global Controls route.
BEGIN;
SET LOCAL ROLE service_role;
SELECT current_user,
       project_code,
       duration_days,
       min_stake,
       reward_rate,
       active,
       network
FROM public.project_staking_terms
WHERE network = 'testnet'
  AND active IS TRUE
ORDER BY project_code, duration_days;
ROLLBACK;

-- 2. Assert exact column permissions and ensure browser roles remain blocked.
SELECT
  has_column_privilege('service_role', 'public.project_staking_terms', 'project_code', 'SELECT') AS service_project_code,
  has_column_privilege('service_role', 'public.project_staking_terms', 'duration_days', 'SELECT') AS service_duration_days,
  has_column_privilege('service_role', 'public.project_staking_terms', 'min_stake', 'SELECT') AS service_min_stake,
  has_column_privilege('service_role', 'public.project_staking_terms', 'reward_rate', 'SELECT') AS service_reward_rate,
  has_column_privilege('service_role', 'public.project_staking_terms', 'active', 'SELECT') AS service_active,
  has_column_privilege('service_role', 'public.project_staking_terms', 'network', 'SELECT') AS service_network,
  has_column_privilege('service_role', 'public.project_staking_terms', 'id', 'SELECT') AS service_id_unexpected,
  has_table_privilege('service_role', 'public.project_staking_terms', 'SELECT') AS table_wide_select_unexpected,
  has_column_privilege('anon', 'public.project_staking_terms', 'project_code', 'SELECT') AS anon_select,
  has_column_privilege('authenticated', 'public.project_staking_terms', 'project_code', 'SELECT') AS authenticated_select;

-- 3. Confirm RLS and the existing Testnet-only active-terms policy remain intact.
SELECT
  c.relrowsecurity AS rls_enabled,
  (SELECT count(*) FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.tablename = 'project_staking_terms') AS policy_count,
  (SELECT count(*) FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.tablename = 'project_staking_terms'
     AND p.policyname = 'testnet public active staking terms read'
     AND p.cmd = 'SELECT'
     AND p.qual LIKE '%network = ''testnet''%'
     AND p.qual LIKE '%active = true%') AS expected_testnet_policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'project_staking_terms';

-- 4. Confirm the global switch was not activated by the permission migration.
SELECT active AS treasury_active,
       staking_policy_active,
       updated_at
FROM public.testnet_global_treasury_policy
WHERE singleton_id = 1
  AND network = 'testnet';

-- 5. Confirm the Testnet staking deployment guard remains enabled.
SELECT public.testnet_global_transaction_control_guard_status() AS deployment_guard_ready;

-- 6. Confirm terms remain in Testnet only.
SELECT network, count(*) AS offer_count,
       count(*) FILTER (WHERE active IS TRUE) AS active_offer_count
FROM public.project_staking_terms
GROUP BY network
ORDER BY network;
