
begin;

alter table public.withdrawal_requests
  drop constraint if exists withdrawal_requests_status_check;

alter table public.withdrawal_requests
  add constraint withdrawal_requests_status_check
  check (
    status = any (
      array[
        'pending'::text,
        'approved'::text,
        'processing'::text,
        'completed'::text,
        'failed'::text,
        'rejected'::text,
        'cancelled'::text
      ]
    )
  );

create index if not exists withdrawal_requests_pi_uid_stake_status_idx
  on public.withdrawal_requests (pi_uid, stake_id, status);

create index if not exists withdrawal_requests_pi_uid_type_status_idx
  on public.withdrawal_requests (pi_uid, withdrawal_type, status);

create or replace function public.create_testnet_withdrawal(
  p_pi_uid text,
  p_stake_id uuid,
  p_withdrawal_type text,
  p_requested_amount numeric,
  p_wallet_address text
)
returns public.withdrawal_requests
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_uid text := nullif(trim(p_pi_uid), '');
  v_type text := lower(trim(p_withdrawal_type));
  v_wallet text := nullif(trim(p_wallet_address), '');
  v_requested numeric := round(coalesce(p_requested_amount, 0)::numeric, 7);
  v_fee_rate numeric := 0.01;
  v_min_fee numeric := 0.01;
  v_fee numeric;
  v_required numeric;
  v_available numeric;
  v_stake public.stakes%rowtype;
  v_user_id uuid;
  v_project_id uuid;
  v_project_code text;
  v_withdrawn numeric;
  v_result public.withdrawal_requests;
begin
  if v_uid is null then
    raise exception using errcode = '22023', message = 'PI_UID_REQUIRED';
  end if;

  if p_stake_id is null then
    raise exception using errcode = '22023', message = 'STAKE_ID_REQUIRED';
  end if;

  if v_type not in ('reward', 'capital') then
    raise exception using errcode = '22023', message = 'INVALID_WITHDRAWAL_TYPE';
  end if;

  if v_requested < 0.50 then
    raise exception using errcode = '22023', message = 'MINIMUM_WITHDRAWAL_IS_0.50_PI';
  end if;

  if v_wallet is null then
    raise exception using errcode = '22023', message = 'WALLET_ADDRESS_REQUIRED';
  end if;

  /*
   * Serialize withdrawals for this investor. This prevents two simultaneous
   * requests from both observing the same available balance.
   */
  perform pg_advisory_xact_lock(hashtextextended('albukhr:testnet:withdraw:' || v_uid, 0));

  select s.*
    into v_stake
  from public.stakes s
  where s.id = p_stake_id
    and s.pi_uid = v_uid
    and s.network = 'testnet'
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'STAKE_NOT_FOUND';
  end if;

  if lower(coalesce(v_stake.status, '')) not in ('active', 'completed') then
    raise exception using errcode = '22023', message = 'STAKE_NOT_WITHDRAWABLE';
  end if;

  v_project_id := v_stake.project_id;
  v_project_code := v_stake.project_code;

  select u.id
    into v_user_id
  from public.users u
  where u.pi_uid = v_uid
    and u.network = 'testnet'
  limit 1;

  if v_user_id is null then
    raise exception using errcode = 'P0002', message = 'TESTNET_USER_NOT_FOUND';
  end if;

  v_fee := greatest(round(v_requested * v_fee_rate, 7), v_min_fee);
  v_required := round(v_requested + v_fee, 7);

  select coalesce(sum(w.requested_amount), 0)
    into v_withdrawn
  from public.withdrawal_requests w
  where w.stake_id = v_stake.id
    and w.pi_uid = v_uid
    and w.network = 'testnet'
    and lower(w.withdrawal_type) = v_type
    and w.status in ('pending', 'processing', 'completed', 'approved');

  if v_type = 'reward' then
    v_available := greatest(round(coalesce(v_stake.reward_amount, 0) - v_withdrawn, 7), 0);

  else
    if v_stake.unlock_at is null or now() < v_stake.unlock_at then
      raise exception using errcode = '22023', message = 'CAPITAL_IS_LOCKED_UNTIL_UNLOCK_AT';
    end if;

    v_available := greatest(round(coalesce(v_stake.amount, 0) - v_withdrawn, 7), 0);
  end if;

  if v_required > v_available then
    raise exception using errcode = '22003',
      message = 'INSUFFICIENT_WITHDRAWABLE_BALANCE',
      detail = format(
        'requested=%s fee=%s total_deduction=%s available=%s',
        v_requested, v_fee, v_required, v_available
      );
  end if;

  insert into public.withdrawal_requests (
    stake_id,
    user_id,
    pi_uid,
    project_id,
    project_code,
    network,
    withdrawal_type,
    requested_amount,
    fee_rate,
    fee_amount,
    net_amount,
    wallet_address,
    status,
    created_at,
    updated_at
  )
  values (
    v_stake.id,
    v_user_id,
    v_uid,
    v_project_id,
    v_project_code,
    'testnet',
    v_type,
    v_requested,
    v_fee_rate,
    v_fee,
    v_requested,
    v_wallet,
    'pending',
    now(),
    now()
  )
  returning * into v_result;

  return v_result;
end;
$function$;

revoke all on function public.create_testnet_withdrawal(text, uuid, text, numeric, text) from public, anon, authenticated;
grant execute on function public.create_testnet_withdrawal(text, uuid, text, numeric, text) to service_role;

create or replace function public.claim_testnet_withdrawal(
  p_request_id uuid,
  p_pi_uid text
)
returns public.withdrawal_requests
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_result public.withdrawal_requests;
begin
  update public.withdrawal_requests
  set
    status = 'processing',
    updated_at = now()
  where id = p_request_id
    and pi_uid = nullif(trim(p_pi_uid), '')
    and network = 'testnet'
    and status = 'pending'
  returning * into v_result;

  if v_result.id is null then
    raise exception using errcode = 'P0002', message = 'WITHDRAWAL_NOT_PENDING_OR_NOT_FOUND';
  end if;

  return v_result;
end;
$function$;

revoke all on function public.claim_testnet_withdrawal(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_testnet_withdrawal(uuid, text) to service_role;

commit;
