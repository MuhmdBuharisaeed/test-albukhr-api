-- READ-ONLY postflight for Migration A. Run only after the migration has been
-- applied in an isolated Testnet validation database. This script performs SELECTs.
DO $verify$
DECLARE
  v_name text;
  v_rls boolean;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'project_staking_governance',
    'project_staking_policy_acceptances',
    'project_staking_engine_evaluation_audit'
  ] LOOP
    SELECT c.relrowsecurity INTO v_rls
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=v_name AND c.relkind='r';
    IF v_rls IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'POSTFLIGHT_RLS_NOT_ENABLED: %', v_name;
    END IF;
  END LOOP;

  IF has_table_privilege('anon','public.project_staking_governance','SELECT')
     OR has_table_privilege('authenticated','public.project_staking_governance','SELECT')
     OR has_table_privilege('anon','public.project_staking_policy_acceptances','SELECT')
     OR has_table_privilege('authenticated','public.project_staking_policy_acceptances','SELECT')
     OR has_table_privilege('anon','public.project_staking_engine_evaluation_audit','SELECT')
     OR has_table_privilege('authenticated','public.project_staking_engine_evaluation_audit','SELECT') THEN
    RAISE EXCEPTION 'POSTFLIGHT_BROWSER_ACCESS_PRESENT';
  END IF;

  IF has_table_privilege('service_role','public.project_staking_policy_acceptances','UPDATE')
     OR has_table_privilege('service_role','public.project_staking_policy_acceptances','DELETE')
     OR has_table_privilege('service_role','public.project_staking_engine_evaluation_audit','UPDATE')
     OR has_table_privilege('service_role','public.project_staking_engine_evaluation_audit','DELETE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_APPEND_ONLY_GUARD_FAILED';
  END IF;
END;
$verify$;

SELECT 'PASS' AS result,
       (SELECT count(*) FROM public.project_staking_governance WHERE network='testnet') AS governance_rows,
       (SELECT count(*) FROM public.project_staking_policy_acceptances WHERE network='testnet') AS policy_acceptance_rows,
       (SELECT count(*) FROM public.project_staking_engine_evaluation_audit WHERE network='testnet') AS engine_evaluation_rows,
       (SELECT count(*) FROM public.project_staking_governance WHERE network='testnet' AND configuration_status='awaiting_owner_link') AS awaiting_owner_link,
       (SELECT count(*) FROM public.project_staking_governance WHERE network='testnet' AND configuration_status='awaiting_owner_selection') AS awaiting_owner_selection,
       (SELECT active FROM public.testnet_global_treasury_policy WHERE singleton_id=1 AND network='testnet') AS treasury_active,
       (SELECT staking_policy_active FROM public.testnet_global_treasury_policy WHERE singleton_id=1 AND network='testnet') AS staking_policy_active;
