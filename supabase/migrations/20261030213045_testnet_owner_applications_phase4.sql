-- ALBUKHR Testnet Owner Applications — Phase 4 additive draft
-- TARGET: Testnet Supabase only (vhvkwvngmrlgyzwemttt)
-- NOT APPLIED. Review against the live schema and generate a canonical migration before use.
-- This migration deliberately does not alter legacy Core ownership functions/tables.

begin;

create table if not exists public.mainnet_project_mirror_provenance (
  testnet_project_id uuid primary key references public.projects(id) on delete restrict,
  network text not null default 'testnet' check (network='testnet'),
  mainnet_source_project_id uuid not null unique,
  project_code text not null unique,
  project_type text not null check (project_type in ('core','internal','external')),
  source_status text not null check (source_status in ('approved','active','suspended','archived','unknown')),
  source_updated_at timestamptz,
  last_verified_at timestamptz not null default now(),
  sync_batch_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.testnet_owner_application_proof_uses (
  id uuid primary key default gen_random_uuid(),
  network text not null default 'testnet' check (network='testnet'),
  proof_id_hash text not null unique,
  project_id uuid not null references public.projects(id) on delete restrict,
  applicant_testnet_user_id uuid not null references public.users(id) on delete restrict,
  owner_pi_uid_hash text not null check (length(owner_pi_uid_hash) = 64),
  expires_at timestamptz not null,
  consumed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint testnet_owner_proof_hash_length check (length(proof_id_hash) = 64)
);

create table if not exists public.testnet_project_owner_application_tickets (
  id uuid primary key default gen_random_uuid(),
  network text not null default 'testnet' check (network='testnet'),
  ticket_hash text not null unique,
  proof_id_hash text not null unique,
  project_id uuid not null references public.projects(id) on delete restrict,
  applicant_testnet_user_id uuid not null references public.users(id) on delete restrict,
  mainnet_source_project_id uuid not null,
  project_code text not null,
  project_type text not null check (project_type in ('internal','external')),
  owner_pi_uid_hash text not null check (length(owner_pi_uid_hash) = 64),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint testnet_owner_app_ticket_hash_length check (length(ticket_hash) = 64),
  constraint testnet_owner_app_ticket_proof_hash_length check (length(proof_id_hash) = 64)
);

create table if not exists public.testnet_project_owner_approval_tickets (
  id uuid primary key default gen_random_uuid(),
  network text not null default 'testnet' check (network='testnet'),
  ticket_hash text not null unique,
  application_id uuid not null,
  project_id uuid not null references public.projects(id) on delete restrict,
  applicant_testnet_user_id uuid not null references public.users(id) on delete restrict,
  mainnet_source_project_id uuid not null,
  revalidation_nonce_hash text not null unique check (length(revalidation_nonce_hash) = 64),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint testnet_owner_approval_ticket_hash_length check (length(ticket_hash) = 64)
);

create table if not exists public.testnet_project_owner_applications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  network text not null default 'testnet' check (network = 'testnet'),
  applicant_testnet_user_id uuid not null references public.users(id) on delete restrict,
  mainnet_source_project_id uuid not null,
  mainnet_source_project_code text not null,
  mainnet_source_project_type text not null check (mainnet_source_project_type in ('internal','external')),
  proof_ticket_id uuid not null unique references public.testnet_project_owner_application_tickets(id) on delete restrict,
  status text not null default 'submitted' check (status in ('submitted','changes_requested','resubmitted','approved','rejected','withdrawn')),
  owner_submission jsonb not null check (jsonb_typeof(owner_submission) = 'object'),
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by_admin_session_id uuid,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname='testnet_project_owner_approval_tickets_application_fkey'
      and conrelid='public.testnet_project_owner_approval_tickets'::regclass
  ) then
    alter table public.testnet_project_owner_approval_tickets
      add constraint testnet_project_owner_approval_tickets_application_fkey
      foreign key (application_id)
      references public.testnet_project_owner_applications(id)
      on delete restrict;
  end if;
end $$;

create unique index if not exists testnet_project_owner_applications_one_open_per_project
  on public.testnet_project_owner_applications(project_id)
  where status in ('submitted','changes_requested','resubmitted');

create index if not exists testnet_project_owner_applications_applicant_idx
  on public.testnet_project_owner_applications(applicant_testnet_user_id, created_at desc);

create index if not exists testnet_project_owner_applications_queue_idx
  on public.testnet_project_owner_applications(status, submitted_at desc);

create table if not exists public.testnet_project_owner_application_history (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.testnet_project_owner_applications(id) on delete restrict,
  project_id uuid not null references public.projects(id) on delete restrict,
  network text not null default 'testnet' check (network = 'testnet'),
  actor_role text not null check (actor_role in ('owner','admin','system')),
  actor_testnet_user_id uuid references public.users(id) on delete set null,
  actor_admin_session_id uuid,
  action text not null check (action in ('submitted','changes_requested','resubmitted','approved','rejected','withdrawn')),
  from_status text,
  to_status text not null,
  note text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists testnet_project_owner_application_history_app_idx
  on public.testnet_project_owner_application_history(application_id, created_at);

-- New public-schema tables are intentionally service-role-only. RLS is defense in depth.
-- Grant only the direct operations used by the Edge Functions; all application state
-- transitions are performed by narrowly scoped SECURITY DEFINER RPCs below.
do $$
declare t text;
begin
  foreach t in array array[
    'mainnet_project_mirror_provenance',
    'testnet_owner_application_proof_uses',
    'testnet_project_owner_application_tickets',
    'testnet_project_owner_approval_tickets',
    'testnet_project_owner_applications',
    'testnet_project_owner_application_history'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
  end loop;
  grant select on table public.mainnet_project_mirror_provenance to service_role;
  grant insert on table public.testnet_owner_application_proof_uses to service_role;
  grant select, insert on table public.testnet_project_owner_application_tickets to service_role;
  grant insert on table public.testnet_project_owner_approval_tickets to service_role;
  grant select on table public.testnet_project_owner_applications to service_role;
  -- Application history is written only inside the privileged transition RPCs.
end $$;

-- Registry mirror replacement: retains existing project-code upsert semantics,
-- but also records the exact Mainnet source UUID in a restricted provenance table.
create or replace function public.apply_mainnet_approved_project_mirror_with_provenance(p_projects jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_received integer;
  v_inserted integer := 0;
  v_suspended integer := 0;
  v_batch uuid := gen_random_uuid();
  v_item jsonb;
  v_project_id uuid;
  v_source_id uuid;
  v_code text;
  v_type text;
  v_status text;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  if jsonb_typeof(p_projects) is distinct from 'array' then
    raise exception 'INVALID_PROJECT_PAYLOAD';
  end if;
  v_received := jsonb_array_length(p_projects);
  if v_received < 1 or v_received > 250 then
    raise exception 'PROJECT_PAYLOAD_COUNT_INVALID';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_projects) e(value)
    where coalesce(e.value->>'network','') <> 'mainnet'
       or coalesce(e.value->>'status','') not in ('approved','active')
       or coalesce(e.value->>'project_type','') not in ('core','internal','external')
       or coalesce(trim(e.value->>'id'),'') = ''
       or coalesce(trim(e.value->>'project_code'),'') = ''
       or coalesce(trim(e.value->>'slug'),'') = ''
       or coalesce(trim(e.value->>'name'),'') = ''
       or coalesce(trim(e.value->>'logo_path'),'') = ''
       or coalesce(trim(e.value->>'logo_url'),'') = ''
       or (e.value->>'logo_url') !~ '^https://ribpntyqdleytsyktdfb[.]supabase[.]co/storage/v1/object/public/'
       or (e.value->>'project_type' = 'core' and coalesce((e.value->>'core_slot')::integer,0) not between 1 and 7)
       or (e.value->>'project_type' <> 'core' and nullif(e.value->>'core_slot','') is not null)
  ) then
    raise exception 'PROJECT_PAYLOAD_VALIDATION_FAILED';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_projects) e(value)
    group by e.value->>'project_code' having count(*) > 1
  ) or exists (
    select 1 from jsonb_array_elements(p_projects) e(value)
    group by e.value->>'id' having count(*) > 1
  ) then
    raise exception 'DUPLICATE_PROJECT_IDENTITY';
  end if;

  -- Do not silently rebind any Testnet code that is already attached to a different source.
  if exists (
    select 1
    from public.projects p
    join jsonb_array_elements(p_projects) e(value)
      on p.project_code = e.value->>'project_code'
    join public.mainnet_project_mirror_provenance pr on pr.testnet_project_id = p.id and pr.network='testnet'
    where p.network='testnet'
      and pr.mainnet_source_project_id <> (e.value->>'id')::uuid
  ) then raise exception 'MIRROR_SOURCE_ID_REBIND_DENIED'; end if;

  select count(*) into v_inserted
  from jsonb_array_elements(p_projects) e(value)
  where not exists (
    select 1 from public.projects p
    where p.network='testnet' and p.project_code=e.value->>'project_code'
  );

  insert into public.projects (
    project_code,slug,name,description,project_type,core_slot,network,status,
    logo_url,logo_path,logo_width,logo_height,logo_format,logo_size_bytes,
    registration_source,created_at,updated_at
  )
  select e.value->>'project_code',e.value->>'slug',e.value->>'name',
    nullif(e.value->>'description',''),e.value->>'project_type',
    nullif(e.value->>'core_slot','')::smallint,'testnet',e.value->>'status',
    e.value->>'logo_url',e.value->>'logo_path',
    nullif(e.value->>'logo_width','')::integer,nullif(e.value->>'logo_height','')::integer,
    nullif(e.value->>'logo_format',''),nullif(e.value->>'logo_size_bytes','')::bigint,
    'mainnet-approved-mirror',now(),now()
  from jsonb_array_elements(p_projects) e(value)
  on conflict (project_code) do update set
    slug=excluded.slug,name=excluded.name,description=excluded.description,
    project_type=excluded.project_type,core_slot=excluded.core_slot,network='testnet',
    status=excluded.status,logo_url=excluded.logo_url,logo_path=excluded.logo_path,
    logo_width=excluded.logo_width,logo_height=excluded.logo_height,
    logo_format=excluded.logo_format,logo_size_bytes=excluded.logo_size_bytes,
    registration_source='mainnet-approved-mirror',updated_at=now()
  where public.projects.network='testnet'
    and public.projects.registration_source='mainnet-approved-mirror';

  for v_item in select value from jsonb_array_elements(p_projects) loop
    v_source_id := (v_item->>'id')::uuid;
    v_code := v_item->>'project_code';
    v_type := v_item->>'project_type';
    v_status := v_item->>'status';
    select id into v_project_id from public.projects
      where network='testnet' and project_code=v_code
        and registration_source='mainnet-approved-mirror';
    if v_project_id is null then raise exception 'MIRROR_PROJECT_UPSERT_FAILED'; end if;

    if exists (
      select 1 from public.mainnet_project_mirror_provenance
      where network='testnet' and mainnet_source_project_id=v_source_id and testnet_project_id<>v_project_id
    ) then raise exception 'MIRROR_SOURCE_ALREADY_BOUND'; end if;

    insert into public.mainnet_project_mirror_provenance(
      testnet_project_id,network,mainnet_source_project_id,project_code,project_type,
      source_status,source_updated_at,last_verified_at,sync_batch_id,updated_at
    ) values (
      v_project_id,'testnet',v_source_id,v_code,v_type,v_status,
      nullif(v_item->>'updated_at','')::timestamptz,now(),v_batch,now()
    )
    on conflict (testnet_project_id) do update set
      network='testnet',project_code=excluded.project_code,
      project_type=excluded.project_type,
      source_status=excluded.source_status,
      source_updated_at=excluded.source_updated_at,
      last_verified_at=now(),sync_batch_id=excluded.sync_batch_id,updated_at=now()
    where public.mainnet_project_mirror_provenance.network='testnet'
      and public.mainnet_project_mirror_provenance.mainnet_source_project_id=excluded.mainnet_source_project_id;

    if not found then raise exception 'MIRROR_PROVENANCE_CONFLICT'; end if;
  end loop;

  update public.projects p set status='suspended',updated_at=now()
  where p.network='testnet'
    and p.registration_source='mainnet-approved-mirror'
    and p.status in ('approved','active')
    and not exists (select 1 from jsonb_array_elements(p_projects) e(value)
                    where e.value->>'project_code'=p.project_code);
  get diagnostics v_suspended = row_count;

  update public.mainnet_project_mirror_provenance pr
  set source_status='suspended',last_verified_at=now(),sync_batch_id=v_batch,updated_at=now()
  from public.projects p
  where p.id=pr.testnet_project_id and p.network='testnet' and pr.network='testnet'
    and p.registration_source='mainnet-approved-mirror'
    and p.status='suspended'
    and not exists (select 1 from jsonb_array_elements(p_projects) e(value)
                    where e.value->>'project_code'=p.project_code);

  return jsonb_build_object('success',true,'network','testnet','source','mainnet',
    'received',v_received,'inserted',v_inserted,'updated',v_received-v_inserted,
    'suspended',v_suspended,'provenance_batch_id',v_batch);
end;
$function$;

revoke all on function public.apply_mainnet_approved_project_mirror_with_provenance(jsonb) from public, anon, authenticated;
grant execute on function public.apply_mainnet_approved_project_mirror_with_provenance(jsonb) to service_role;

-- Create an application row atomically with one-time ticket consumption.
create or replace function public.submit_testnet_project_owner_application(
  p_ticket_hash text, p_applicant_user_id uuid, p_project_id uuid, p_submission jsonb
) returns uuid
language plpgsql security definer set search_path=''
as $function$
declare v_ticket public.testnet_project_owner_application_tickets%rowtype;
        v_project public.projects%rowtype; v_app_id uuid;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if jsonb_typeof(p_submission) is distinct from 'object' then raise exception 'APPLICATION_PAYLOAD_INVALID'; end if;
  select * into v_ticket from public.testnet_project_owner_application_tickets
    where ticket_hash=p_ticket_hash and network='testnet' for update;
  if not found or v_ticket.consumed_at is not null or v_ticket.expires_at<=now() then
    raise exception 'APPLICATION_TICKET_INVALID_OR_USED';
  end if;
  if v_ticket.applicant_testnet_user_id<>p_applicant_user_id or v_ticket.project_id<>p_project_id then
    raise exception 'APPLICATION_TICKET_SCOPE_MISMATCH';
  end if;
  select * into v_project from public.projects where id=p_project_id and network='testnet' for update;
  if not found or v_project.project_type not in ('internal','external')
     or v_project.status not in ('approved','active') then raise exception 'PROJECT_NOT_ELIGIBLE'; end if;
  if v_project.owner_user_id is not null then
    raise exception 'PROJECT_ALREADY_OWNED';
  end if;
  if v_project.project_code<>v_ticket.project_code or v_project.project_type<>v_ticket.project_type then
    raise exception 'PROJECT_SOURCE_MISMATCH';
  end if;
  if not exists (
    select 1 from public.mainnet_project_mirror_provenance pr
    where pr.testnet_project_id=p_project_id and pr.network='testnet'
      and pr.mainnet_source_project_id=v_ticket.mainnet_source_project_id
      and pr.project_code=v_ticket.project_code
      and pr.project_type=v_ticket.project_type
      and pr.source_status in ('approved','active')
  ) then raise exception 'PROJECT_MIRROR_PROVENANCE_INVALID'; end if;

  if exists (
    select 1 from public.testnet_project_owner_applications a
    where a.project_id=p_project_id and a.applicant_testnet_user_id=p_applicant_user_id
      and a.network='testnet' and a.status='rejected'
  ) then raise exception 'APPLICATION_PREVIOUSLY_REJECTED'; end if;

  insert into public.testnet_project_owner_applications(
    project_id,network,applicant_testnet_user_id,mainnet_source_project_id,
    mainnet_source_project_code,mainnet_source_project_type,proof_ticket_id,
    status,owner_submission
  ) values (
    p_project_id,'testnet',p_applicant_user_id,v_ticket.mainnet_source_project_id,
    v_ticket.project_code,v_ticket.project_type,v_ticket.id,'submitted',p_submission
  ) returning id into v_app_id;

  update public.testnet_project_owner_application_tickets set consumed_at=now() where id=v_ticket.id and network='testnet';
  insert into public.testnet_project_owner_application_history(
    application_id,project_id,network,actor_role,actor_testnet_user_id,action,
    from_status,to_status,note
  ) values (v_app_id,p_project_id,'testnet','owner',p_applicant_user_id,
            'submitted',null,'submitted','Owner submitted application');
  return v_app_id;
end;
$function$;

revoke all on function public.submit_testnet_project_owner_application(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.submit_testnet_project_owner_application(text,uuid,uuid,jsonb) to service_role;

create or replace function public.resubmit_testnet_project_owner_application(
  p_application_id uuid,p_applicant_user_id uuid,p_ticket_hash text,p_submission jsonb
) returns void
language plpgsql security definer set search_path=''
as $function$
declare v_app public.testnet_project_owner_applications%rowtype;
        v_ticket public.testnet_project_owner_application_tickets%rowtype;
        v_project public.projects%rowtype;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into v_app from public.testnet_project_owner_applications
   where id=p_application_id and applicant_testnet_user_id=p_applicant_user_id and network='testnet'
   for update;
  if not found then raise exception 'APPLICATION_NOT_FOUND'; end if;
  if v_app.status<>'changes_requested' then raise exception 'APPLICATION_NOT_RESUBMITTABLE'; end if;
  select * into v_ticket from public.testnet_project_owner_application_tickets where ticket_hash=p_ticket_hash and network='testnet' for update;
  if not found or v_ticket.consumed_at is not null or v_ticket.expires_at<=now()
     or v_ticket.project_id<>v_app.project_id or v_ticket.applicant_testnet_user_id<>p_applicant_user_id
     or v_ticket.mainnet_source_project_id<>v_app.mainnet_source_project_id
     or v_ticket.project_code<>v_app.mainnet_source_project_code
     or v_ticket.project_type<>v_app.mainnet_source_project_type then
    raise exception 'APPLICATION_TICKET_INVALID_OR_USED';
  end if;
  select * into v_project from public.projects where id=v_app.project_id and network='testnet' for update;
  if not found or v_project.project_type not in ('internal','external') or v_project.status not in ('approved','active')
    or v_project.project_code<>v_app.mainnet_source_project_code
    or v_project.project_type<>v_app.mainnet_source_project_type
    or not exists (select 1 from public.mainnet_project_mirror_provenance pr where pr.testnet_project_id=v_app.project_id and pr.network='testnet'
      and pr.mainnet_source_project_id=v_app.mainnet_source_project_id
      and pr.project_code=v_app.mainnet_source_project_code
      and pr.project_type=v_app.mainnet_source_project_type
      and pr.source_status in ('approved','active')) then
    raise exception 'PROJECT_NOT_ELIGIBLE';
  end if;
  if v_project.owner_user_id is not null then raise exception 'PROJECT_ALREADY_OWNED'; end if;
  if jsonb_typeof(p_submission) is distinct from 'object' then raise exception 'APPLICATION_PAYLOAD_INVALID'; end if;
  update public.testnet_project_owner_applications
    set owner_submission=p_submission,proof_ticket_id=v_ticket.id,status='resubmitted',submitted_at=now(),updated_at=now(),
        reviewed_at=null,reviewed_by_admin_session_id=null,review_note=null
    where id=v_app.id;
  update public.testnet_project_owner_application_tickets set consumed_at=now() where id=v_ticket.id and network='testnet';
  insert into public.testnet_project_owner_application_history(
    application_id,project_id,network,actor_role,actor_testnet_user_id,action,
    from_status,to_status,note
  ) values (v_app.id,v_app.project_id,'testnet','owner',p_applicant_user_id,
            'resubmitted','changes_requested','resubmitted','Owner resubmitted requested changes');
end;
$function$;
revoke all on function public.resubmit_testnet_project_owner_application(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.resubmit_testnet_project_owner_application(uuid,uuid,text,jsonb) to service_role;

create or replace function public.review_testnet_project_owner_application(
  p_application_id uuid,p_admin_session_id uuid,p_decision text,p_note text
) returns void
language plpgsql security definer set search_path=''
as $function$
declare v_app public.testnet_project_owner_applications%rowtype;
        v_project public.projects%rowtype;
        v_admin public.testnet_admin_sessions%rowtype;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into v_admin from public.testnet_admin_sessions
    where id=p_admin_session_id and network='testnet' and revoked_at is null and expires_at>now()
      and roles @> array['super_admin']::text[] for share;
  if not found then raise exception 'TESTNET_SUPER_ADMIN_REQUIRED'; end if;
  select * into v_app from public.testnet_project_owner_applications
    where id=p_application_id and network='testnet' for update;
  if not found then raise exception 'APPLICATION_NOT_FOUND'; end if;
  if jsonb_array_length(coalesce(v_admin.scoped_projects,'[]'::jsonb))>0
     and not (v_admin.scoped_projects @> to_jsonb(v_app.project_id::text)) then
    raise exception 'TESTNET_PROJECT_SCOPE_DENIED';
  end if;
  if p_decision is null or p_decision not in ('changes_requested','rejected') then raise exception 'APPLICATION_DECISION_INVALID'; end if;
  if v_app.status not in ('submitted','resubmitted') then raise exception 'APPLICATION_NOT_REVIEWABLE'; end if;
  if nullif(trim(coalesce(p_note,'')),'') is null then raise exception 'REVIEW_NOTE_REQUIRED'; end if;
  select * into v_project from public.projects where id=v_app.project_id and network='testnet' for share;
  if not found then raise exception 'PROJECT_NOT_FOUND'; end if;
  -- Core is excluded even from the Admin decision RPC. A non-Core project
  -- that later becomes suspended/stale may still be rejected to close the queue.
  if v_project.project_type not in ('internal','external')
     or v_project.project_code<>v_app.mainnet_source_project_code
     or v_project.project_type<>v_app.mainnet_source_project_type then
    raise exception 'CORE_PROJECT_NOT_ELIGIBLE';
  end if;
  if p_decision='changes_requested' then
    if v_project.project_type not in ('internal','external')
       or v_project.status not in ('approved','active')
       or v_project.project_code<>v_app.mainnet_source_project_code
       or v_project.project_type<>v_app.mainnet_source_project_type then
      raise exception 'PROJECT_NOT_ELIGIBLE';
    end if;
    if v_project.owner_user_id is not null then raise exception 'PROJECT_ALREADY_OWNED'; end if;
    if not exists (select 1 from public.mainnet_project_mirror_provenance pr
      where pr.testnet_project_id=v_app.project_id and pr.network='testnet'
        and pr.mainnet_source_project_id=v_app.mainnet_source_project_id
        and pr.project_code=v_app.mainnet_source_project_code
        and pr.project_type=v_app.mainnet_source_project_type
        and pr.source_status in ('approved','active')) then
      raise exception 'PROJECT_MIRROR_PROVENANCE_INVALID';
    end if;
  end if;
  update public.testnet_project_owner_applications set status=p_decision,reviewed_at=now(),
    reviewed_by_admin_session_id=p_admin_session_id,review_note=left(trim(p_note),3000),updated_at=now()
    where id=v_app.id;
  insert into public.testnet_project_owner_application_history(
    application_id,project_id,network,actor_role,actor_admin_session_id,action,
    from_status,to_status,note
  ) values (v_app.id,v_app.project_id,'testnet','admin',p_admin_session_id,p_decision,
    v_app.status,p_decision,left(trim(p_note),3000));
end;
$function$;
revoke all on function public.review_testnet_project_owner_application(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.review_testnet_project_owner_application(uuid,uuid,text,text) to service_role;

create or replace function public.approve_testnet_project_owner_application(
  p_application_id uuid,p_admin_session_id uuid,p_approval_ticket_hash text,p_note text
) returns void
language plpgsql security definer set search_path=''
as $function$
declare v_app public.testnet_project_owner_applications%rowtype;
        v_project public.projects%rowtype;
        v_admin public.testnet_admin_sessions%rowtype;
        v_ticket public.testnet_project_owner_approval_tickets%rowtype;
        v_profile public.project_owner_profiles%rowtype;
        v_profile_exists boolean := false;
        v_now timestamptz:=now();
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into v_admin from public.testnet_admin_sessions
    where id=p_admin_session_id and network='testnet' and revoked_at is null and expires_at>v_now
      and roles @> array['super_admin']::text[] for share;
  if not found then raise exception 'TESTNET_SUPER_ADMIN_REQUIRED'; end if;
  select * into v_app from public.testnet_project_owner_applications
    where id=p_application_id and network='testnet' for update;
  if not found then raise exception 'APPLICATION_NOT_FOUND'; end if;
  if v_app.status not in ('submitted','resubmitted') then raise exception 'APPLICATION_NOT_APPROVABLE'; end if;
  if jsonb_array_length(coalesce(v_admin.scoped_projects,'[]'::jsonb))>0
     and not (v_admin.scoped_projects @> to_jsonb(v_app.project_id::text)) then
    raise exception 'TESTNET_PROJECT_SCOPE_DENIED';
  end if;

  select * into v_ticket from public.testnet_project_owner_approval_tickets
    where ticket_hash=p_approval_ticket_hash and network='testnet' for update;
  if not found or v_ticket.consumed_at is not null or v_ticket.expires_at<=v_now
     or v_ticket.application_id<>v_app.id or v_ticket.project_id<>v_app.project_id
     or v_ticket.applicant_testnet_user_id<>v_app.applicant_testnet_user_id
     or v_ticket.mainnet_source_project_id<>v_app.mainnet_source_project_id then
    raise exception 'APPROVAL_REVALIDATION_TICKET_INVALID';
  end if;

  select * into v_project from public.projects where id=v_app.project_id and network='testnet' for update;
  if not found or v_project.project_type not in ('internal','external')
     or v_project.status not in ('approved','active') then raise exception 'PROJECT_NOT_ELIGIBLE'; end if;
  if v_project.project_code<>v_app.mainnet_source_project_code
     or v_project.project_type<>v_app.mainnet_source_project_type then raise exception 'PROJECT_SOURCE_MISMATCH'; end if;
  if not exists (select 1 from public.mainnet_project_mirror_provenance pr
    where pr.testnet_project_id=v_project.id and pr.network='testnet' and pr.mainnet_source_project_id=v_app.mainnet_source_project_id
      and pr.project_code=v_app.mainnet_source_project_code and pr.project_type=v_app.mainnet_source_project_type
      and pr.source_status in ('approved','active')) then raise exception 'PROJECT_MIRROR_PROVENANCE_INVALID'; end if;
  if v_project.owner_user_id is not null then
    raise exception 'PROJECT_ALREADY_OWNED';
  end if;

  select * into v_profile from public.project_owner_profiles
    where project_id=v_project.id and network='testnet' for update;
  v_profile_exists := found;
  if v_profile_exists and v_profile.owner_user_id<>v_app.applicant_testnet_user_id then
    raise exception 'OWNER_PROFILE_CONFLICT';
  end if;

  update public.projects set owner_user_id=v_app.applicant_testnet_user_id,updated_at=v_now
    where id=v_project.id and network='testnet';

  if not found then raise exception 'PROJECT_OWNER_BINDING_FAILED'; end if;

  if not v_profile_exists then
    -- Keep profile verification pending until the separate profile verification process.
    insert into public.project_owner_profiles(
      project_id,owner_user_id,network,display_name,role_title,organization_name,
      contact_email,contact_phone,bio,verification_status,profile_status,metadata
    ) values (
      v_project.id,v_app.applicant_testnet_user_id,'testnet',
      nullif(v_app.owner_submission->>'owner_name',''),
      nullif(v_app.owner_submission->>'role_title',''),
      nullif(v_app.owner_submission->>'organization_name',''),
      nullif(v_app.owner_submission->>'contact_email',''),
      nullif(v_app.owner_submission->>'contact_phone',''),
      nullif(v_app.owner_submission->>'business_summary',''),
      'pending','active',jsonb_build_object('source','owner_application','application_id',v_app.id)
    );
  else
    -- A same-owner archived profile may exist after a prior revocation. Reactivate
    -- only that same user's profile; never overwrite a conflicting Owner profile.
    update public.project_owner_profiles
      set display_name=nullif(v_app.owner_submission->>'owner_name',''),
          role_title=nullif(v_app.owner_submission->>'role_title',''),
          organization_name=nullif(v_app.owner_submission->>'organization_name',''),
          contact_email=nullif(v_app.owner_submission->>'contact_email',''),
          contact_phone=nullif(v_app.owner_submission->>'contact_phone',''),
          bio=nullif(v_app.owner_submission->>'business_summary',''),
          verification_status='pending',verified_at=null,verified_by=null,
          profile_status='active',
          metadata=coalesce(v_profile.metadata,'{}'::jsonb) ||
            jsonb_build_object('source','owner_application','application_id',v_app.id),
          updated_at=v_now
      where id=v_profile.id and project_id=v_project.id
        and owner_user_id=v_app.applicant_testnet_user_id and network='testnet';
    if not found then raise exception 'OWNER_PROFILE_REACTIVATION_FAILED'; end if;
  end if;

  update public.testnet_project_owner_approval_tickets set consumed_at=v_now where id=v_ticket.id and network='testnet';
  update public.testnet_project_owner_applications set status='approved',reviewed_at=v_now,
    reviewed_by_admin_session_id=p_admin_session_id,review_note=left(coalesce(nullif(trim(p_note),''),'Approved after Mainnet owner revalidation'),3000),updated_at=v_now
    where id=v_app.id;
  insert into public.testnet_project_owner_application_history(
    application_id,project_id,network,actor_role,actor_admin_session_id,action,
    from_status,to_status,note,metadata
  ) values (v_app.id,v_project.id,'testnet','admin',p_admin_session_id,'approved',
    v_app.status,'approved',left(coalesce(nullif(trim(p_note),''),'Approved after Mainnet owner revalidation'),3000),
    jsonb_build_object('owner_binding_created',true,'profile_verification_status','pending'));
end;
$function$;
revoke all on function public.approve_testnet_project_owner_application(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.approve_testnet_project_owner_application(uuid,uuid,text,text) to service_role;

commit;
