
create or replace function public.credit_testnet_project_owner_balance(
  p_project_id uuid,
  p_owner_user_id uuid,
  p_amount numeric,
  p_source_type text,
  p_source_reference text,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.project_owner_ledger_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project public.projects;
  v_owner public.users;
  v_existing public.project_owner_ledger_entries;
  v_row public.project_owner_ledger_entries;
  v_source_type text := lower(trim(coalesce(p_source_type,'')));
  v_reference text := nullif(trim(coalesce(p_source_reference,'')), '');
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'OWNER_CREDIT_AMOUNT_INVALID';
  end if;

  if v_source_type not in ('admin_credit','project_revenue','adjustment') then
    raise exception 'OWNER_CREDIT_SOURCE_INVALID';
  end if;

  if v_reference is null then
    raise exception 'OWNER_CREDIT_SOURCE_REFERENCE_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      p_project_id::text || ':' || p_owner_user_id::text || ':' ||
      v_source_type || ':' || v_reference,
      0
    )
  );

  select * into v_project
  from public.projects
  where id = p_project_id
    and network = 'testnet'
    and status = 'approved';

  if not found then
    raise exception 'PROJECT_NOT_APPROVED';
  end if;

  select * into v_owner
  from public.users
  where id = p_owner_user_id
    and network = 'testnet';

  if not found then
    raise exception 'OWNER_USER_NOT_FOUND';
  end if;

  if v_project.owner_user_id is distinct from v_owner.id then
    raise exception 'PROJECT_OWNER_ACCESS_DENIED';
  end if;

  select * into v_existing
  from public.project_owner_ledger_entries
  where source_type = v_source_type
    and source_reference = v_reference
  limit 1
  for share;

  if found then
    return v_existing;
  end if;

  insert into public.project_owner_ledger_entries (
    project_id,
    owner_user_id,
    network,
    entry_type,
    amount,
    source_type,
    source_reference,
    description,
    metadata
  )
  values (
    p_project_id,
    p_owner_user_id,
    'testnet',
    'credit',
    p_amount,
    v_source_type,
    v_reference,
    nullif(trim(coalesce(p_description,'')), ''),
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.credit_testnet_project_owner_balance(
  uuid,uuid,numeric,text,text,text,jsonb
) from public, anon, authenticated;

grant execute on function public.credit_testnet_project_owner_balance(
  uuid,uuid,numeric,text,text,text,jsonb
) to service_role;


create or replace function public.approve_testnet_project_owner_withdrawal(
  p_withdrawal_id uuid,
  p_reviewed_by uuid
)
returns public.project_owner_withdrawals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.project_owner_withdrawals;
begin
  select *
    into v_row
  from public.project_owner_withdrawals
  where id = p_withdrawal_id
    and network = 'testnet'
  for update;

  if not found then
    raise exception 'OWNER_WITHDRAWAL_NOT_FOUND';
  end if;

  if v_row.status <> 'pending' then
    return v_row;
  end if;

  update public.project_owner_withdrawals
  set
    status = 'approved',
    reviewed_by = p_reviewed_by,
    reviewed_at = now(),
    updated_at = now()
  where id = p_withdrawal_id
    and network = 'testnet'
    and status = 'pending'
  returning * into v_row;

  if not found then
    raise exception 'OWNER_WITHDRAWAL_APPROVAL_FAILED';
  end if;

  return v_row;
end;
$$;

revoke all on function public.approve_testnet_project_owner_withdrawal(uuid,uuid)
from public, anon, authenticated;

grant execute on function public.approve_testnet_project_owner_withdrawal(uuid,uuid)
to service_role;


create or replace function public.complete_testnet_project_owner_withdrawal(
  p_withdrawal_id uuid,
  p_txid text,
  p_reviewed_by uuid
)
returns public.project_owner_withdrawals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.project_owner_withdrawals;
  v_existing public.project_owner_ledger_entries;
  v_txid text := nullif(trim(coalesce(p_txid,'')), '');
begin
  if v_txid is null then
    raise exception 'OWNER_WITHDRAWAL_TXID_REQUIRED';
  end if;

  select *
    into v_row
  from public.project_owner_withdrawals
  where id = p_withdrawal_id
    and network = 'testnet'
  for update;

  if not found then
    raise exception 'OWNER_WITHDRAWAL_NOT_FOUND';
  end if;

  if v_row.status = 'completed' then
    return v_row;
  end if;

  if v_row.status not in ('approved','processing') then
    raise exception 'OWNER_WITHDRAWAL_NOT_READY';
  end if;

  insert into public.project_owner_ledger_entries (
    project_id,
    owner_user_id,
    network,
    entry_type,
    amount,
    source_type,
    source_reference,
    description,
    metadata
  )
  values (
    v_row.project_id,
    v_row.owner_user_id,
    'testnet',
    'debit',
    v_row.requested_amount,
    'owner_withdrawal',
    v_row.id::text,
    'Project Owner withdrawal',
    jsonb_build_object(
      'withdrawal_id', v_row.id,
      'txid', v_txid,
      'net_amount', v_row.net_amount,
      'fee_amount', v_row.fee_amount,
      'network', 'testnet'
    )
  )
  on conflict (source_type, source_reference)
  where source_reference is not null
  do nothing
  returning * into v_existing;

  update public.project_owner_withdrawals
  set
    status = 'completed',
    txid = v_txid,
    reviewed_by = coalesce(p_reviewed_by, reviewed_by),
    reviewed_at = coalesce(reviewed_at, now()),
    updated_at = now()
  where id = p_withdrawal_id
    and network = 'testnet'
  returning * into v_row;

  if not found then
    raise exception 'OWNER_WITHDRAWAL_COMPLETION_FAILED';
  end if;

  return v_row;
end;
$$;

revoke all on function public.complete_testnet_project_owner_withdrawal(uuid,text,uuid)
from public, anon, authenticated;

grant execute on function public.complete_testnet_project_owner_withdrawal(uuid,text,uuid)
to service_role;
