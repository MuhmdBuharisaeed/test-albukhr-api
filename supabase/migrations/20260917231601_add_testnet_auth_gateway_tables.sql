
create table if not exists public.testnet_access_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  pi_uid text not null,
  username text,
  wallet_address text,
  network text not null default 'testnet' check (network='testnet'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists testnet_access_codes_expires_idx
  on public.testnet_access_codes (expires_at);

create index if not exists testnet_access_codes_pi_uid_idx
  on public.testnet_access_codes (pi_uid);

alter table public.testnet_access_codes enable row level security;

drop policy if exists "testnet access codes deny anon" on public.testnet_access_codes;
create policy "testnet access codes deny anon"
on public.testnet_access_codes for all to anon
using (false) with check (false);

drop policy if exists "testnet access codes deny authenticated" on public.testnet_access_codes;
create policy "testnet access codes deny authenticated"
on public.testnet_access_codes for all to authenticated
using (false) with check (false);

create table if not exists public.testnet_sessions (
  id uuid primary key default gen_random_uuid(),
  session_hash text not null unique,
  pi_uid text not null,
  username text,
  wallet_address text,
  network text not null default 'testnet' check (network='testnet'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists testnet_sessions_pi_uid_idx
  on public.testnet_sessions (pi_uid);

create index if not exists testnet_sessions_expires_idx
  on public.testnet_sessions (expires_at);

alter table public.testnet_sessions enable row level security;

drop policy if exists "testnet sessions deny anon" on public.testnet_sessions;
create policy "testnet sessions deny anon"
on public.testnet_sessions for all to anon
using (false) with check (false);

drop policy if exists "testnet sessions deny authenticated" on public.testnet_sessions;
create policy "testnet sessions deny authenticated"
on public.testnet_sessions for all to authenticated
using (false) with check (false);

revoke all on table public.testnet_access_codes from anon, authenticated;
revoke all on table public.testnet_sessions from anon, authenticated;
