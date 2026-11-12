-- Testnet security hardening: these SECURITY DEFINER functions are trigger-only.
-- Trigger execution is governed by the trigger itself; callers should not be able
-- to invoke the trigger helper functions through PostgREST RPC.
REVOKE EXECUTE ON FUNCTION public.bootstrap_testnet_project_treasury() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_testnet_global_treasury_values() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_testnet_project_local_staking_policy() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_testnet_project_staking_stage_write() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_testnet_global_staking_policy() FROM PUBLIC, anon, authenticated;
