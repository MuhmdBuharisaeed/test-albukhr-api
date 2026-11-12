
create table if not exists public.testnet_liquidity_auto_verify_guard (
  id smallint primary key check (id = 1),
  token_hash text not null,
  updated_at timestamptz not null default now()
);
alter table public.testnet_liquidity_auto_verify_guard enable row level security;
revoke all on table public.testnet_liquidity_auto_verify_guard from public, anon, authenticated;
grant select on table public.testnet_liquidity_auto_verify_guard to service_role;
insert into public.testnet_liquidity_auto_verify_guard (id, token_hash, updated_at)
values (1, '1c91494608279db97cf444765b32cefaf27ad7bce9bb61d60617eb4d2de508ff', now())
on conflict (id) do update
set token_hash = excluded.token_hash, updated_at = now();
