-- Read-only verification queries. Run only AFTER the migration is applied.
-- These queries do not modify database state.

SELECT
  singleton_id,
  network,
  active AS treasury_active,
  staking_policy_active,
  withdrawal_enabled,
  policy_version,
  minimum_staker_withdrawal,
  fee_tier_size,
  fee_per_tier,
  sub_tier_fee_free_count,
  sub_tier_fee_after_quota
FROM public.testnet_global_treasury_policy
WHERE singleton_id = 1
  AND network = 'testnet';

SELECT
  control,
  action,
  previous_enabled,
  enabled,
  reason,
  admin_email,
  created_at
FROM public.testnet_global_transaction_control_audit
WHERE network = 'testnet'
ORDER BY created_at DESC
LIMIT 10;

SELECT
  p.oid::regprocedure::text AS function_signature,
  p.prosecdef AS security_definer,
  p.proconfig AS function_config,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'assert_testnet_global_withdrawals_enabled',
    'claim_testnet_withdrawal',
    'claim_testnet_project_owner_withdrawal',
    'claim_testnet_admin_withdrawal',
    'set_testnet_global_transaction_control'
  )
ORDER BY p.proname, p.oid::regprocedure::text;

SELECT
  c.relname AS table_name,
  t.tgname AS trigger_name,
  t.tgenabled AS trigger_enabled
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('withdrawal_requests', 'project_owner_withdrawals')
  AND t.tgname IN (
    'testnet_withdrawal_global_control_guard',
    'testnet_owner_withdrawal_global_control_guard'
  )
  AND NOT t.tgisinternal
ORDER BY c.relname, t.tgname;

SELECT
  'withdrawal_requests' AS table_name,
  status,
  count(*)::bigint AS row_count
FROM public.withdrawal_requests
WHERE network = 'testnet'
GROUP BY status
UNION ALL
SELECT
  'project_owner_withdrawals',
  status,
  count(*)::bigint
FROM public.project_owner_withdrawals
WHERE network = 'testnet'
GROUP BY status
ORDER BY table_name, status;
