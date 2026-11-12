
-- ALBUKHR TESTNET — Project Ownership & Team Identity, Step 4A
-- Additive only: creates new ownership identity/audit tables.
-- Does not alter or delete existing ALBUKHR tables, rows, functions, or navigation.

create table if not exists public.project_owner_profiles (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null
    references public.projects(id)
    on delete restrict,
  owner_user_id uuid not null
    references public.users(id)
    on delete restrict,
  network text not null default 'testnet'
    check (network = 'testnet'),
  display_name text,
  role_title text,
  organization_name text,
  contact_email text,
  contact_phone text,
  bio text,
  verification_status text not null default 'pending'
    check (verification_status in ('pending','verified','rejected')),
  verified_at timestamptz,
  verified_by uuid references public.users(id) on delete set null,
  profile_status text not null default 'active'
    check (profile_status in ('active','suspended','archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_owner_profiles_project_unique unique (project_id)
);

create table if not exists public.project_owner_history (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null
    references public.projects(id)
    on delete restrict,
  network text not null default 'testnet'
    check (network = 'testnet'),
  action_type text not null
    check (action_type in ('assign','change','revoke')),
  previous_owner_user_id uuid
    references public.users(id)
    on delete set null,
  new_owner_user_id uuid
    references public.users(id)
    on delete set null,
  performed_by uuid not null
    references public.users(id)
    on delete restrict,
  reason text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_project_owner_profiles_owner
  on public.project_owner_profiles(network, owner_user_id);

create index if not exists idx_project_owner_profiles_status
  on public.project_owner_profiles(network, profile_status, verification_status);

create index if not exists idx_project_owner_history_project
  on public.project_owner_history(project_id, created_at desc);

create index if not exists idx_project_owner_history_owner
  on public.project_owner_history(network, previous_owner_user_id, new_owner_user_id);

alter table public.project_owner_profiles enable row level security;
alter table public.project_owner_history enable row level security;

revoke all on table public.project_owner_profiles from anon, authenticated;
revoke all on table public.project_owner_history from anon, authenticated;

grant all on table public.project_owner_profiles to service_role;
grant all on table public.project_owner_history to service_role;

comment on table public.project_owner_profiles is
  'Testnet project-owner identity/profile data. Ownership authority remains projects.owner_user_id. Access is server-authorized only.';

comment on table public.project_owner_history is
  'Immutable-style Testnet ownership assignment/change/revocation audit trail. Access is server-authorized only.';
