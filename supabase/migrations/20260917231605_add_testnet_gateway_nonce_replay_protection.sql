
create table if not exists public.testnet_gateway_nonces (
  nonce_hash text primary key,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists testnet_gateway_nonces_expires_idx
  on public.testnet_gateway_nonces (expires_at);

alter table public.testnet_gateway_nonces enable row level security;

drop policy if exists "testnet gateway nonces deny anon" on public.testnet_gateway_nonces;
create policy "testnet gateway nonces deny anon"
on public.testnet_gateway_nonces for all to anon
using (false) with check (false);

drop policy if exists "testnet gateway nonces deny authenticated" on public.testnet_gateway_nonces;
create policy "testnet gateway nonces deny authenticated"
on public.testnet_gateway_nonces for all to authenticated
using (false) with check (false);

revoke all on table public.testnet_gateway_nonces from anon, authenticated;
