-- READ-ONLY preflight for Migration A. This script performs SELECTs only.
SELECT
  to_regclass('public.projects') AS projects_table,
  to_regclass('public.users') AS users_table,
  to_regclass('public.testnet_sessions') AS testnet_sessions_table,
  to_regclass('public.testnet_global_treasury_policy') AS testnet_global_policy_table,
  to_regclass('public.project_staking_governance') AS governance_table_before_migration,
  to_regclass('public.project_staking_policy_acceptances') AS acceptance_table_before_migration,
  to_regclass('public.project_staking_engine_evaluation_audit') AS engine_audit_table_before_migration;

SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema='public'
  AND (
    (table_name='projects' AND column_name IN ('id','project_code','project_type','network','status','owner_user_id'))
    OR (table_name='users' AND column_name IN ('id','pi_uid','network'))
    OR (table_name='testnet_sessions' AND column_name IN ('id','pi_uid','network','expires_at','revoked_at'))
    OR (table_name='testnet_global_treasury_policy' AND column_name IN ('singleton_id','network','allowed_duration_days','staking_reward_rates_by_duration'))
  )
ORDER BY table_name, ordinal_position;

SELECT singleton_id, network, allowed_duration_days, staking_reward_rates_by_duration,
       active AS treasury_active, staking_policy_active
FROM public.testnet_global_treasury_policy
WHERE singleton_id=1 AND network='testnet';
