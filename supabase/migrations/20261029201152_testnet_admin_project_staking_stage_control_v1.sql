
BEGIN;

CREATE TABLE IF NOT EXISTS public.testnet_project_staking_stage_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network text NOT NULL DEFAULT 'testnet' CHECK (network = 'testnet'),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  project_code text NOT NULL,
  previous_stage text,
  new_stage text NOT NULL CHECK (
    new_stage IN ('setup_pre_operation','construction_fit_out','operating_expansion')
  ),
  admin_pi_uid text NOT NULL CHECK (length(trim(admin_pi_uid)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.testnet_project_staking_stage_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.testnet_project_staking_stage_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.testnet_project_staking_stage_audit TO service_role;

CREATE OR REPLACE FUNCTION public.guard_testnet_project_staking_stage_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.network = 'testnet'
     AND NEW.staking_stage IS DISTINCT FROM OLD.staking_stage
     AND current_setting('albukhr.testnet_project_stage_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION USING errcode = '42501',
      message = 'TESTNET_PROJECT_STAGE_RPC_REQUIRED';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS testnet_project_staking_stage_write_guard ON public.projects;
CREATE TRIGGER testnet_project_staking_stage_write_guard
BEFORE UPDATE OF staking_stage ON public.projects
FOR EACH ROW
EXECUTE FUNCTION public.guard_testnet_project_staking_stage_write();

CREATE OR REPLACE FUNCTION public.set_testnet_project_staking_stage(
  p_project_id uuid,
  p_staking_stage text,
  p_admin_pi_uid text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_project public.projects%ROWTYPE;
  v_policy public.testnet_global_treasury_policy%ROWTYPE;
  v_stage_rule jsonb;
  v_max_active_principal numeric;
  v_coverage record;
  v_prev_write_flag text := current_setting('albukhr.testnet_project_stage_write', true);
  v_admin_uid text := nullif(trim(p_admin_pi_uid), '');
BEGIN
  IF p_project_id IS NULL OR v_admin_uid IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'TESTNET_PROJECT_STAGE_FIELDS_REQUIRED';
  END IF;

  IF p_staking_stage NOT IN (
    'setup_pre_operation','construction_fit_out','operating_expansion'
  ) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'TESTNET_PROJECT_STAKING_STAGE_INVALID';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('albukhr:testnet:staking:' || p_project_id::text, 0)
  );

  SELECT * INTO v_project
  FROM public.projects
  WHERE id = p_project_id
    AND network = 'testnet'
    AND status = 'approved'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'TESTNET_APPROVED_PROJECT_REQUIRED';
  END IF;

  IF v_project.staking_stage = p_staking_stage THEN
    RETURN jsonb_build_object(
      'success', true,
      'network', 'testnet',
      'project_id', v_project.id,
      'project_code', v_project.project_code,
      'staking_stage', v_project.staking_stage,
      'changed', false
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.testnet_stake_intents i
    WHERE i.project_id = p_project_id
      AND i.network = 'testnet'
      AND i.status = 'pending_payment'
  ) THEN
    RAISE EXCEPTION USING errcode = '55000',
      message = 'TESTNET_PROJECT_STAGE_CHANGE_BLOCKED_PENDING_STAKE_INTENTS';
  END IF;

  SELECT * INTO v_policy
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1 AND network = 'testnet'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_TESTNET_POLICY_NOT_CONFIGURED';
  END IF;

  v_stage_rule := v_policy.staking_stage_policies -> p_staking_stage;
  IF jsonb_typeof(v_stage_rule) <> 'object'
     OR nullif(v_stage_rule ->> 'max_active_principal', '') IS NULL THEN
    RAISE EXCEPTION USING errcode = '55000',
      message = 'GLOBAL_STAKING_STAGE_POLICY_NOT_CONFIGURED';
  END IF;

  v_max_active_principal := (v_stage_rule ->> 'max_active_principal')::numeric;
  IF v_max_active_principal <= 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'GLOBAL_STAKING_STAGE_POLICY_INVALID';
  END IF;

  SELECT * INTO v_coverage
  FROM public.get_testnet_staking_coverage(p_project_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'TESTNET_STAKING_COVERAGE_UNAVAILABLE';
  END IF;

  IF coalesce(v_coverage.outstanding_principal, 0) > v_max_active_principal THEN
    RAISE EXCEPTION USING errcode = '22003',
      message = 'TESTNET_PROJECT_STAGE_CAP_BELOW_OUTSTANDING_PRINCIPAL';
  END IF;

  PERFORM set_config('albukhr.testnet_project_stage_write', 'on', true);

  UPDATE public.projects
  SET staking_stage = p_staking_stage
  WHERE id = p_project_id
    AND network = 'testnet'
  RETURNING * INTO v_project;

  PERFORM set_config(
    'albukhr.testnet_project_stage_write',
    coalesce(nullif(v_prev_write_flag, ''), 'off'),
    true
  );

  INSERT INTO public.testnet_project_staking_stage_audit (
    network, project_id, project_code, previous_stage, new_stage, admin_pi_uid
  )
  VALUES (
    'testnet', v_project.id, v_project.project_code,
    (SELECT p.staking_stage FROM public.projects p WHERE p.id = p_project_id),
    p_staking_stage, v_admin_uid
  );

  RETURN jsonb_build_object(
    'success', true,
    'network', 'testnet',
    'project_id', v_project.id,
    'project_code', v_project.project_code,
    'staking_stage', v_project.staking_stage,
    'changed', true
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.set_testnet_project_staking_stage(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_testnet_project_staking_stage(uuid,text,text) TO service_role;

COMMIT;
