
CREATE TABLE public.project_staking_offer_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  project_code text NOT NULL REFERENCES public.projects(project_code) ON UPDATE CASCADE ON DELETE RESTRICT,
  owner_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  actor_pi_uid text NOT NULL,
  network text NOT NULL DEFAULT 'testnet' CHECK (network = 'testnet'),
  duration_days integer NOT NULL CHECK (duration_days > 0),
  previous_reward_rate numeric NOT NULL CHECK (previous_reward_rate >= 0),
  new_reward_rate numeric NOT NULL CHECK (new_reward_rate > 0 AND new_reward_rate <= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX project_staking_offer_audit_project_date_idx
  ON public.project_staking_offer_audit (project_id, network, created_at DESC);
ALTER TABLE public.project_staking_offer_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_staking_offer_audit_no_direct_api_access
  ON public.project_staking_offer_audit FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.project_staking_offer_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.project_staking_offer_audit TO service_role;

CREATE OR REPLACE FUNCTION public.update_testnet_project_staking_offer(
  p_project_id uuid,
  p_pi_uid text,
  p_duration_days integer,
  p_reward_rate numeric
)
RETURNS public.project_staking_terms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid text := nullif(trim(p_pi_uid), '');
  v_project public.projects%rowtype;
  v_owner_id uuid;
  v_control public.project_staking_risk_controls%rowtype;
  v_term public.project_staking_terms%rowtype;
  v_coverage record;
  v_rate numeric := round(coalesce(p_reward_rate, 0)::numeric, 7);
BEGIN
  IF p_project_id IS NULL OR v_uid IS NULL OR p_duration_days IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKING_OFFER_FIELDS_REQUIRED';
  END IF;
  IF v_rate <= 0 OR v_rate > 1 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKING_REWARD_RATE_INVALID';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('albukhr:testnet:staking:' || p_project_id::text, 0)
  );

  SELECT * INTO v_project
  FROM public.projects
  WHERE id = p_project_id AND network = 'testnet' AND status = 'approved'
  FOR UPDATE;
  IF NOT FOUND OR v_project.owner_user_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'PROJECT_OWNER_ACCESS_DENIED';
  END IF;

  SELECT u.id INTO v_owner_id
  FROM public.users u
  WHERE u.pi_uid = v_uid AND u.network = 'testnet'
  LIMIT 1;
  IF v_owner_id IS NULL OR v_owner_id IS DISTINCT FROM v_project.owner_user_id THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'PROJECT_OWNER_ACCESS_DENIED';
  END IF;

  SELECT * INTO v_control
  FROM public.project_staking_risk_controls
  WHERE project_id = p_project_id AND network = 'testnet'
  FOR UPDATE;
  IF NOT FOUND OR NOT v_control.staking_enabled
     OR v_control.approval_status <> 'approved'
     OR v_control.max_reward_rate IS NULL
     OR v_control.capital_reserve_percent IS NULL
     OR v_control.maximum_deployment_percent IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKING_POLICY_NOT_APPROVED';
  END IF;

  IF v_rate > v_control.max_reward_rate THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKING_REWARD_RATE_EXCEEDS_ALBUKHR_LIMIT';
  END IF;

  SELECT * INTO v_term
  FROM public.project_staking_terms
  WHERE project_code = v_project.project_code
    AND network = 'testnet'
    AND duration_days = p_duration_days
    AND active = true
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKING_DURATION_NOT_ALLOWED';
  END IF;

  SELECT * INTO v_coverage
  FROM public.get_testnet_staking_coverage(p_project_id);
  IF coalesce(v_coverage.staking_eligible, false) IS NOT TRUE THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'STAKING_LIQUIDITY_COVERAGE_NOT_ELIGIBLE';
  END IF;

  INSERT INTO public.project_staking_offer_audit (
    project_id, project_code, owner_user_id, actor_pi_uid, network,
    duration_days, previous_reward_rate, new_reward_rate, metadata
  ) VALUES (
    p_project_id, v_project.project_code, v_owner_id, v_uid, 'testnet',
    v_term.duration_days, v_term.reward_rate, v_rate,
    jsonb_build_object('source', 'owner_dashboard', 'policy_max_reward_rate', v_control.max_reward_rate)
  );

  UPDATE public.project_staking_terms
  SET reward_rate = v_rate, updated_at = now()
  WHERE id = v_term.id AND network = 'testnet'
  RETURNING * INTO v_term;

  RETURN v_term;
END;
$function$;

REVOKE ALL ON FUNCTION public.update_testnet_project_staking_offer(uuid,text,integer,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_testnet_project_staking_offer(uuid,text,integer,numeric) TO service_role;
