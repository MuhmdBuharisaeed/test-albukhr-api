-- Testnet-only. Assessment creation for project-owner withdrawals requires
-- independent admin approval (approved/processing status).
CREATE OR REPLACE FUNCTION public.create_testnet_outflow_fee_assessment(
  p_source_type text,
  p_source_id uuid
)
RETURNS public.testnet_outflow_fee_assessments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_policy public.testnet_global_treasury_policy%ROWTYPE;
  v_existing public.testnet_outflow_fee_assessments%ROWTYPE;
  v_result public.testnet_outflow_fee_assessments%ROWTYPE;
  v_actor_user_id uuid;
  v_actor_pi_uid text;
  v_project_id uuid;
  v_requested numeric;
  v_local_day date;
  v_sub_tier_count integer := 0;
  v_ordinal integer;
  v_fee numeric := 0;
  v_basis text;
  v_fee_status text;
  v_status text;
BEGIN
  IF p_source_type NOT IN ('staker_withdrawal', 'project_owner_withdrawal') OR p_source_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OUTFLOW_FEE_SOURCE_INVALID';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('albukhr:testnet:outflow-fee:source:' || p_source_type || ':' || p_source_id::text, 0)
  );

  IF p_source_type = 'staker_withdrawal' THEN
    SELECT w.user_id, w.pi_uid, w.project_id, w.requested_amount, w.status
      INTO v_actor_user_id, v_actor_pi_uid, v_project_id, v_requested, v_status
    FROM public.withdrawal_requests w
    WHERE w.id = p_source_id AND w.network = 'testnet';
  ELSE
    SELECT w.owner_user_id, u.pi_uid, w.project_id, w.requested_amount, w.status
      INTO v_actor_user_id, v_actor_pi_uid, v_project_id, v_requested, v_status
    FROM public.project_owner_withdrawals w
    JOIN public.users u ON u.id = w.owner_user_id AND u.network = 'testnet'
    WHERE w.id = p_source_id AND w.network = 'testnet';
  END IF;

  IF NOT FOUND OR v_actor_user_id IS NULL OR nullif(trim(coalesce(v_actor_pi_uid, '')), '') IS NULL THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'OUTFLOW_FEE_SOURCE_NOT_FOUND_OR_ACTOR_INVALID';
  END IF;

  SELECT * INTO v_existing
  FROM public.testnet_outflow_fee_assessments
  WHERE source_type = p_source_type AND source_id = p_source_id
    AND network = 'testnet';

  IF FOUND THEN
    IF v_existing.actor_user_id IS DISTINCT FROM v_actor_user_id
       OR v_existing.actor_pi_uid IS DISTINCT FROM v_actor_pi_uid
       OR round(v_existing.requested_amount, 7) IS DISTINCT FROM round(v_requested, 7) THEN
      RAISE EXCEPTION USING errcode = '23514', message = 'OUTFLOW_FEE_EXISTING_ASSESSMENT_MISMATCH';
    END IF;
    RETURN v_existing;
  END IF;

  IF (p_source_type = 'staker_withdrawal' AND v_status NOT IN ('pending', 'approved', 'processing'))
     OR (p_source_type = 'project_owner_withdrawal' AND v_status NOT IN ('approved', 'processing')) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OUTFLOW_FEE_SOURCE_NOT_READY';
  END IF;

  SELECT * INTO v_policy
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1 AND network = 'testnet'
  FOR SHARE;

  IF NOT FOUND OR v_policy.active IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'TESTNET_GLOBAL_TREASURY_POLICY_INACTIVE';
  END IF;

  IF v_requested IS NULL OR v_requested <= 0
     OR v_requested::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OUTFLOW_FEE_AMOUNT_INVALID';
  END IF;

  v_local_day := (now() AT TIME ZONE v_policy.business_day_timezone)::date;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'albukhr:testnet:outflow-fee:actor:' || v_actor_user_id::text || ':' || v_local_day::text,
      0
    )
  );

  IF v_requested < v_policy.fee_tier_size THEN
    SELECT count(*)::integer INTO v_sub_tier_count
    FROM public.testnet_outflow_fee_assessments a
    WHERE a.network = 'testnet'
      AND a.actor_user_id = v_actor_user_id
      AND a.local_day = v_local_day
      AND a.requested_amount < v_policy.fee_tier_size;

    v_ordinal := v_sub_tier_count + 1;
    IF v_ordinal <= v_policy.sub_tier_fee_free_count THEN
      v_fee := 0;
      v_basis := 'no_fee_under_tier_daily_allowance';
    ELSE
      v_fee := round(v_policy.sub_tier_fee_after_quota, 7);
      v_basis := 'under_tier_after_allowance';
    END IF;
  ELSE
    v_ordinal := NULL;
    v_fee := round(
      floor(v_requested / v_policy.fee_tier_size) * v_policy.fee_per_tier,
      7
    );
    v_basis := 'complete_tier_fee';
  END IF;

  v_fee_status := CASE WHEN v_fee > 0 THEN 'payment_pending' ELSE 'not_required' END;

  INSERT INTO public.testnet_outflow_fee_assessments (
    network, actor_user_id, actor_pi_uid, project_id, source_type, source_id,
    local_day, sub_tier_ordinal, requested_amount, fee_amount, sender_total_debit,
    recipient_amount, fee_policy_version, fee_basis, fee_status, idempotency_key,
    metadata
  )
  VALUES (
    'testnet', v_actor_user_id, v_actor_pi_uid, v_project_id, p_source_type, p_source_id,
    v_local_day, CASE WHEN v_requested < v_policy.fee_tier_size THEN v_ordinal ELSE NULL END,
    round(v_requested, 7), v_fee, round(v_requested + v_fee, 7),
    round(v_requested, 7), v_policy.policy_version, v_basis, v_fee_status,
    'testnet-outflow-fee:' || p_source_type || ':' || p_source_id::text,
    jsonb_build_object(
      'network', 'testnet',
      'fee_policy_version', v_policy.policy_version,
      'business_day_timezone', v_policy.business_day_timezone,
      'fee_assessed_at', now()
    )
  )
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_testnet_outflow_fee_assessment(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_testnet_outflow_fee_assessment(text, uuid) TO service_role;
