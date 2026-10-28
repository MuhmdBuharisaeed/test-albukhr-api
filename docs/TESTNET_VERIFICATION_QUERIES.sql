-- READ-ONLY verification queries for ALBUKHR Testnet Supabase.
SELECT singleton_id, network, active, policy_version, minimum_project_liquidity,
       fee_tier_size, fee_per_tier, sub_tier_fee_free_count,
       sub_tier_fee_after_quota, minimum_staker_withdrawal,
       allowed_duration_days, business_day_timezone
FROM public.testnet_global_treasury_policy
WHERE singleton_id = 1 AND network = 'testnet';

SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
       has_table_privilege('anon', 'public.' || c.relname, 'SELECT') AS anon_select,
       has_table_privilege('authenticated', 'public.' || c.relname, 'SELECT') AS authenticated_select,
       has_table_privilege('service_role', 'public.' || c.relname, 'SELECT') AS service_role_select
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'testnet_global_treasury_policy', 'testnet_outflow_fee_assessments',
    'testnet_platform_fee_ledger', 'testnet_outflow_fee_payment_attempts'
  );

SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments,
       p.prosecdef AS security_definer, p.proconfig AS function_config,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'create_testnet_outflow_fee_assessment', 'mark_testnet_outflow_fee_paid',
    'assert_testnet_outflow_fee_ready', 'create_testnet_withdrawal_idempotent',
    'create_testnet_withdrawal', 'complete_testnet_withdrawal_and_ledger',
    'create_testnet_project_owner_withdrawal', 'complete_testnet_project_owner_withdrawal',
    'reserve_testnet_outflow_fee_payment', 'mark_testnet_outflow_fee_payment_attempt_approved',
    'cancel_testnet_outflow_fee_payment_attempt'
  )
ORDER BY p.proname;

SELECT 'withdrawal_requests' AS table_name, count(*) AS rows FROM public.withdrawal_requests WHERE network = 'testnet'
UNION ALL SELECT 'project_owner_withdrawals', count(*) FROM public.project_owner_withdrawals WHERE network = 'testnet'
UNION ALL SELECT 'testnet_outflow_fee_assessments', count(*) FROM public.testnet_outflow_fee_assessments WHERE network = 'testnet'
UNION ALL SELECT 'testnet_platform_fee_ledger', count(*) FROM public.testnet_platform_fee_ledger WHERE network = 'testnet'
UNION ALL SELECT 'testnet_outflow_fee_payment_attempts', count(*) FROM public.testnet_outflow_fee_payment_attempts WHERE network = 'testnet';
