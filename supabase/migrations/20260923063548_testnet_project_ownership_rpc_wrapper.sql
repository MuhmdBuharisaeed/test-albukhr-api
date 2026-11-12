
create or replace function public.manage_testnet_project_ownership(
  p_project_id uuid,
  p_action text,
  p_owner_user_id uuid default null,
  p_performed_by uuid default null,
  p_reason text default null,
  p_profile jsonb default '{}'::jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language sql
set search_path = ''
as $$
  select private.manage_testnet_project_ownership(
    p_project_id,
    p_action,
    p_owner_user_id,
    p_performed_by,
    p_reason,
    p_profile,
    p_metadata
  );
$$;

revoke execute on function public.manage_testnet_project_ownership(uuid,text,uuid,uuid,text,jsonb,jsonb)
  from public, anon, authenticated;

grant execute on function public.manage_testnet_project_ownership(uuid,text,uuid,uuid,text,jsonb,jsonb)
  to service_role;

comment on function public.manage_testnet_project_ownership(uuid,text,uuid,uuid,text,jsonb,jsonb) is
  'Server-only RPC wrapper for transactional Testnet project ownership control.';
