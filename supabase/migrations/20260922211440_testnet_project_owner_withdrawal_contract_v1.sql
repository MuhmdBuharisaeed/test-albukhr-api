
create or replace function public.create_testnet_project_owner_withdrawal(
  p_project_id uuid,
  p_owner_user_id uuid,
  p_requested_amount numeric,
  p_wallet_address text,
  p_fee_rate numeric default 0
)
returns public.project_owner_withdrawals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project public.projects;
  v_owner public.users;
  v_available numeric;
  v_fee numeric;
  v_net numeric;
  v_row public.project_owner_withdrawals;
  v_wallet text;
begin
  if p_requested_amount is null or p_requested_amount <= 0 then
    raise exception 'OWNER_WITHDRAWAL_AMOUNT_INVALID';
  end if;

  if p_fee_rate is null or p_fee_rate < 0 or p_fee_rate > 100 then
    raise exception 'OWNER_WITHDRAWAL_FEE_INVALID';
  end if;

  v_wallet := trim(coalesce(p_wallet_address, ''));
  if v_wallet = '' then
    raise exception 'OWNER_WITHDRAWAL_WALLET_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      p_project_id::text || ':' || p_owner_user_id::text,
      0
    )
  );

  select *
    into v_project
  from public.projects
  where id = p_project_id
    and network = 'testnet'
    and status = 'approved'
  for update;

  if not found then
    raise exception 'PROJECT_NOT_APPROVED';
  end if;

  select *
    into v_owner
  from public.users
  where id = p_owner_user_id
    and network = 'testnet'
  for share;

  if not found then
    raise exception 'OWNER_USER_NOT_FOUND';
  end if;

  if v_project.owner_user_id is distinct from v_owner.id then
    raise exception 'PROJECT_OWNER_ACCESS_DENIED';
  end if;

  if v_owner.wallet_address is not null
     and trim(v_owner.wallet_address) <> ''
     and trim(v_owner.wallet_address) <> v_wallet then
    raise exception 'OWNER_WITHDRAWAL_WALLET_MISMATCH';
  end if;

  v_fee := round(p_requested_amount * p_fee_rate / 100, 7);
  v_net := round(p_requested_amount - v_fee, 7);

  if v_net <= 0 then
    raise exception 'OWNER_WITHDRAWAL_NET_AMOUNT_INVALID';
  end if;

  v_available := public.get_testnet_project_owner_balance(
    p_project_id,
    p_owner_user_id
  );

  if v_available < p_requested_amount then
    raise exception 'OWNER_BALANCE_INSUFFICIENT';
  end if;

  insert into public.project_owner_withdrawals (
    project_id,
    owner_user_id,
    network,
    requested_amount,
    fee_rate,
    fee_amount,
    net_amount,
    wallet_address,
    status,
    metadata
  )
  values (
    p_project_id,
    p_owner_user_id,
    'testnet',
    p_requested_amount,
    p_fee_rate,
    v_fee,
    v_net,
    v_wallet,
    'pending',
    jsonb_build_object(
      'source', 'project_owner',
      'network', 'testnet'
    )
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.create_testnet_project_owner_withdrawal(
  uuid, uuid, numeric, text, numeric
) from public, anon, authenticated;

grant execute on function public.create_testnet_project_owner_withdrawal(
  uuid, uuid, numeric, text, numeric
) to service_role;
