
-- Step 4A correction:
-- Admin session identities are not guaranteed to be rows in public.users.
-- Keep the UUID audit fields, but do not impose an incorrect FK coupling.

alter table public.project_owner_history
  drop constraint if exists project_owner_history_performed_by_fkey;

alter table public.project_owner_profiles
  drop constraint if exists project_owner_profiles_verified_by_fkey;

comment on column public.project_owner_history.performed_by is
  'Testnet admin actor UUID from the admin authorization/session system; intentionally not FK-coupled to public.users.';

comment on column public.project_owner_profiles.verified_by is
  'Admin actor UUID from the admin authorization/session system; intentionally not FK-coupled to public.users.';
