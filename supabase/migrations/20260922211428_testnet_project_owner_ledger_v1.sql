
create table if not exists public.project_owner_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id),
  owner_user_id uuid not null references public.users(id),
  network text not null default 'testnet',
  entry_type text not null,
  amount numeric not null,
  source_type text not null,
  source_reference text,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint project_owner_ledger_entries_network_check
    check (network = 'testnet'),

  constraint project_owner_ledger_entries_type_check
    check (entry_type in ('credit','debit')),

  constraint project_owner_ledger_entries_amount_check
    check (amount > 0),

  constraint project_owner_ledger_entries_source_check
    check (
      source_type in (
        'admin_credit',
        'project_revenue',
        'adjustment',
        'owner_withdrawal'
      )
    )
);

create index if not exists project_owner_ledger_project_idx
  on public.project_owner_ledger_entries(project_id, network, created_at desc);

create index if not exists project_owner_ledger_owner_idx
  on public.project_owner_ledger_entries(owner_user_id, network, created_at desc);

create unique index if not exists project_owner_ledger_source_key
  on public.project_owner_ledger_entries(source_type, source_reference)
  where source_reference is not null;

create table if not exists public.project_owner_withdrawals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id),
  owner_user_id uuid not null references public.users(id),
  network text not null default 'testnet',
  requested_amount numeric not null,
  fee_rate numeric not null default 0,
  fee_amount numeric not null default 0,
  net_amount numeric not null,
  wallet_address text not null,
  status text not null default 'pending',
  txid text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  rejection_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint project_owner_withdrawals_network_check
    check (network = 'testnet'),

  constraint project_owner_withdrawals_amount_check
    check (requested_amount > 0 and fee_amount >= 0 and net_amount > 0),

  constraint project_owner_withdrawals_fee_check
    check (fee_rate >= 0 and fee_rate <= 100),

  constraint project_owner_withdrawals_status_check
    check (
      status in (
        'pending',
        'approved',
        'processing',
        'completed',
        'failed',
        'rejected',
        'cancelled'
      )
    )
);

create index if not exists project_owner_withdrawals_project_idx
  on public.project_owner_withdrawals(project_id, network, created_at desc);

create index if not exists project_owner_withdrawals_owner_idx
  on public.project_owner_withdrawals(owner_user_id, network, created_at desc);

alter table public.project_owner_ledger_entries enable row level security;
alter table public.project_owner_withdrawals enable row level security;

drop policy if exists "project_owner_ledger_entries_deny_anon" on public.project_owner_ledger_entries;
create policy "project_owner_ledger_entries_deny_anon"
  on public.project_owner_ledger_entries
  for all to anon
  using (false)
  with check (false);

drop policy if exists "project_owner_ledger_entries_deny_authenticated" on public.project_owner_ledger_entries;
create policy "project_owner_ledger_entries_deny_authenticated"
  on public.project_owner_ledger_entries
  for all to authenticated
  using (false)
  with check (false);

drop policy if exists "project_owner_withdrawals_deny_anon" on public.project_owner_withdrawals;
create policy "project_owner_withdrawals_deny_anon"
  on public.project_owner_withdrawals
  for all to anon
  using (false)
  with check (false);

drop policy if exists "project_owner_withdrawals_deny_authenticated" on public.project_owner_withdrawals;
create policy "project_owner_withdrawals_deny_authenticated"
  on public.project_owner_withdrawals
  for all to authenticated
  using (false)
  with check (false);

create or replace function public.get_testnet_project_owner_balance(
  p_project_id uuid,
  p_owner_user_id uuid
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_network text;
  v_owner_network text;
  v_credits numeric := 0;
  v_debits numeric := 0;
  v_reserved numeric := 0;
begin
  select network into v_project_network
  from public.projects
  where id = p_project_id;

  select network into v_owner_network
  from public.users
  where id = p_owner_user_id;

  if v_project_network <> 'testnet'
     or v_owner_network <> 'testnet' then
    raise exception 'TESTNET_OWNER_NETWORK_MISMATCH';
  end if;

  select coalesce(sum(amount),0)
    into v_credits
  from public.project_owner_ledger_entries
  where project_id = p_project_id
    and owner_user_id = p_owner_user_id
    and network = 'testnet'
    and entry_type = 'credit';

  select coalesce(sum(amount),0)
    into v_debits
  from public.project_owner_ledger_entries
  where project_id = p_project_id
    and owner_user_id = p_owner_user_id
    and network = 'testnet'
    and entry_type = 'debit';

  select coalesce(sum(net_amount),0)
    into v_reserved
  from public.project_owner_withdrawals
  where project_id = p_project_id
    and owner_user_id = p_owner_user_id
    and network = 'testnet'
    and status in ('pending','approved','processing');

  return greatest(0, v_credits - v_debits - v_reserved);
end;
$$;

revoke all on function public.get_testnet_project_owner_balance(uuid, uuid) from public;
revoke all on function public.get_testnet_project_owner_balance(uuid, uuid) from anon;
revoke all on function public.get_testnet_project_owner_balance(uuid, uuid) from authenticated;
grant execute on function public.get_testnet_project_owner_balance(uuid, uuid) to service_role;
