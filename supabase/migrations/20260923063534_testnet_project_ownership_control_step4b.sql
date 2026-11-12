
create schema if not exists private;

alter table public.project_owner_history
  drop constraint if exists project_owner_history_action_type_check;

alter table public.project_owner_history
  add constraint project_owner_history_action_type_check
  check (action_type in ('assign','change','revoke','verify','reject'));

create or replace function private.manage_testnet_project_ownership(
  p_project_id uuid,
  p_action text,
  p_owner_user_id uuid default null,
  p_performed_by uuid default null,
  p_reason text default null,
  p_profile jsonb default '{}'::jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project public.projects%rowtype;
  v_profile public.project_owner_profiles%rowtype;
  v_owner public.users%rowtype;
  v_previous_owner uuid;
  v_action text := lower(trim(coalesce(p_action, '')));
  v_reason text := trim(coalesce(p_reason, ''));
  v_history_id uuid;
  v_now timestamptz := now();
begin
  if p_project_id is null then
    raise exception 'PROJECT_ID_REQUIRED';
  end if;

  if p_performed_by is null then
    raise exception 'PERFORMED_BY_REQUIRED';
  end if;

  if v_reason = '' then
    raise exception 'OWNERSHIP_REASON_REQUIRED';
  end if;

  if v_action not in ('assign','change','revoke','verify','reject') then
    raise exception 'OWNERSHIP_ACTION_INVALID';
  end if;

  select *
  into v_project
  from public.projects
  where id = p_project_id
    and network = 'testnet'
  for update;

  if not found then
    raise exception 'PROJECT_NOT_FOUND';
  end if;

  if v_project.status <> 'approved' then
    raise exception 'PROJECT_NOT_APPROVED';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_project.id::text, 0)
  );

  v_previous_owner := v_project.owner_user_id;

  if v_action in ('assign','change') then
    if p_owner_user_id is null then
      raise exception 'OWNER_USER_ID_REQUIRED';
    end if;

    select *
    into v_owner
    from public.users
    where id = p_owner_user_id
      and network = 'testnet';

    if not found then
      raise exception 'OWNER_USER_NOT_FOUND';
    end if;
  end if;

  if v_action = 'assign' then
    if v_previous_owner is not null then
      raise exception 'PROJECT_ALREADY_HAS_OWNER';
    end if;
  elsif v_action = 'change' then
    if v_previous_owner is null then
      raise exception 'PROJECT_HAS_NO_OWNER';
    end if;
    if v_previous_owner = p_owner_user_id then
      raise exception 'OWNER_ALREADY_ASSIGNED';
    end if;
  elsif v_action = 'revoke' then
    if v_previous_owner is null then
      return jsonb_build_object(
        'ok', true,
        'network', 'testnet',
        'action', 'revoke',
        'idempotent', true,
        'project_id', v_project.id,
        'owner_user_id', null
      );
    end if;
  elsif v_action in ('verify','reject') then
    if v_previous_owner is null then
      raise exception 'PROJECT_HAS_NO_OWNER';
    end if;
  end if;

  if v_action in ('assign','change') then
    update public.projects
    set owner_user_id = p_owner_user_id,
        updated_at = v_now
    where id = v_project.id
      and network = 'testnet';

    select *
    into v_profile
    from public.project_owner_profiles
    where project_id = v_project.id
      and network = 'testnet'
    for update;

    if found then
      update public.project_owner_profiles
      set owner_user_id = p_owner_user_id,
          network = 'testnet',
          display_name = coalesce(nullif(trim(p_profile->>'display_name'), ''), v_profile.display_name, v_owner.username),
          role_title = coalesce(nullif(trim(p_profile->>'role_title'), ''), v_profile.role_title),
          organization_name = coalesce(nullif(trim(p_profile->>'organization_name'), ''), v_profile.organization_name),
          contact_email = coalesce(nullif(trim(p_profile->>'contact_email'), ''), v_profile.contact_email),
          contact_phone = coalesce(nullif(trim(p_profile->>'contact_phone'), ''), v_profile.contact_phone),
          bio = coalesce(nullif(trim(p_profile->>'bio'), ''), v_profile.bio),
          verification_status = 'pending',
          verified_at = null,
          verified_by = null,
          profile_status = 'active',
          metadata = coalesce(p_profile->'metadata', v_profile.metadata, '{}'::jsonb),
          updated_at = v_now
      where project_id = v_project.id
        and network = 'testnet';
    else
      insert into public.project_owner_profiles(
        project_id,
        owner_user_id,
        network,
        display_name,
        role_title,
        organization_name,
        contact_email,
        contact_phone,
        bio,
        verification_status,
        profile_status,
        metadata
      )
      values (
        v_project.id,
        p_owner_user_id,
        'testnet',
        coalesce(nullif(trim(p_profile->>'display_name'), ''), v_owner.username),
        nullif(trim(p_profile->>'role_title'), ''),
        nullif(trim(p_profile->>'organization_name'), ''),
        nullif(trim(p_profile->>'contact_email'), ''),
        nullif(trim(p_profile->>'contact_phone'), ''),
        nullif(trim(p_profile->>'bio'), ''),
        'pending',
        'active',
        coalesce(p_profile->'metadata', '{}'::jsonb)
      );
    end if;

  elsif v_action = 'revoke' then
    update public.projects
    set owner_user_id = null,
        updated_at = v_now
    where id = v_project.id
      and network = 'testnet';

    update public.project_owner_profiles
    set profile_status = 'archived',
        updated_at = v_now
    where project_id = v_project.id
      and network = 'testnet';
  elsif v_action = 'verify' then
    select *
    into v_profile
    from public.project_owner_profiles
    where project_id = v_project.id
      and network = 'testnet'
    for update;

    if not found then
      raise exception 'OWNER_PROFILE_NOT_FOUND';
    end if;

    if v_profile.owner_user_id <> v_previous_owner then
      raise exception 'OWNER_PROFILE_PROJECT_MISMATCH';
    end if;

    update public.project_owner_profiles
    set verification_status = 'verified',
        verified_at = v_now,
        verified_by = p_performed_by,
        profile_status = 'active',
        updated_at = v_now
    where id = v_profile.id;
  elsif v_action = 'reject' then
    select *
    into v_profile
    from public.project_owner_profiles
    where project_id = v_project.id
      and network = 'testnet'
    for update;

    if not found then
      raise exception 'OWNER_PROFILE_NOT_FOUND';
    end if;

    if v_profile.owner_user_id <> v_previous_owner then
      raise exception 'OWNER_PROFILE_PROJECT_MISMATCH';
    end if;

    update public.project_owner_profiles
    set verification_status = 'rejected',
        verified_at = null,
        verified_by = p_performed_by,
        profile_status = 'suspended',
        updated_at = v_now
    where id = v_profile.id;
  end if;

  insert into public.project_owner_history(
    project_id,
    network,
    action_type,
    previous_owner_user_id,
    new_owner_user_id,
    performed_by,
    reason,
    metadata
  )
  values (
    v_project.id,
    'testnet',
    v_action,
    v_previous_owner,
    case
      when v_action in ('assign','change') then p_owner_user_id
      when v_action = 'revoke' then null
      else v_previous_owner
    end,
    p_performed_by,
    v_reason,
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_history_id;

  return jsonb_build_object(
    'ok', true,
    'network', 'testnet',
    'action', v_action,
    'history_id', v_history_id,
    'project_id', v_project.id,
    'project_code', v_project.project_code,
    'project_name', v_project.name,
    'previous_owner_user_id', v_previous_owner,
    'owner_user_id',
      case
        when v_action in ('assign','change') then p_owner_user_id
        when v_action = 'revoke' then null
        else v_previous_owner
      end
  );
end;
$$;

revoke execute on function private.manage_testnet_project_ownership(uuid,text,uuid,uuid,text,jsonb,jsonb) from public, anon, authenticated;
grant usage on schema private to service_role;
grant execute on function private.manage_testnet_project_ownership(uuid,text,uuid,uuid,text,jsonb,jsonb) to service_role;

comment on function private.manage_testnet_project_ownership(uuid,text,uuid,uuid,text,jsonb,jsonb) is
  'Server-only transactional Testnet project ownership assign/change/revoke/verify/reject operation. projects.owner_user_id remains the ownership source of truth.';
