alter table public.withdrawal_requests
  add column if not exists a2u_payment_id text;

alter table public.project_owner_withdrawals
  add column if not exists a2u_payment_id text;

create unique index if not exists withdrawal_requests_testnet_a2u_payment_id_uidx
  on public.withdrawal_requests (a2u_payment_id)
  where network = 'testnet' and a2u_payment_id is not null;

create unique index if not exists project_owner_withdrawals_testnet_a2u_payment_id_uidx
  on public.project_owner_withdrawals (a2u_payment_id)
  where network = 'testnet' and a2u_payment_id is not null;

update public.testnet_global_treasury_policy
set
  policy_version = 2,
  minimum_staker_withdrawal = 0.0100000,
  fee_per_tier = 0,
  sub_tier_fee_after_quota = 0,
  updated_at = now()
where singleton_id = 1
  and network = 'testnet';

do $migration$
declare
  v_definition text;
begin
  v_definition := pg_get_functiondef(
    'public.create_testnet_withdrawal(text,uuid,text,numeric,text)'::regprocedure
  );

  if position('v_min_requested numeric := 0.50;' in v_definition) = 0 then
    raise exception 'EXPECTED_TESTNET_WITHDRAWAL_MINIMUM_NOT_FOUND';
  end if;

  v_definition := replace(
    v_definition,
    'v_min_requested numeric := 0.50;',
    'v_min_requested numeric := 0.01;'
  );

  v_definition := replace(
    v_definition,
    'MINIMUM_STAKER_WITHDRAWAL_IS_0.50_PI',
    'MINIMUM_STAKER_WITHDRAWAL_IS_0.01_PI'
  );

  execute v_definition;
end
$migration$;

comment on column public.withdrawal_requests.a2u_payment_id is
  'Pi Platform A2U payment identifier for Testnet payout recovery.';

comment on column public.project_owner_withdrawals.a2u_payment_id is
  'Pi Platform A2U payment identifier for Testnet payout recovery.';
