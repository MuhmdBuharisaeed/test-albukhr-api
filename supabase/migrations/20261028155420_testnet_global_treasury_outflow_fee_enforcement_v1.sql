-- Testnet-only Global Treasury outflow fee enforcement.
-- Deliberately keeps the policy inactive; no live withdrawals are enabled.

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

  IF v_status NOT IN ('pending', 'approved', 'processing') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OUTFLOW_FEE_SOURCE_NOT_OPEN';
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

CREATE OR REPLACE FUNCTION public.mark_testnet_outflow_fee_paid(
  p_assessment_id uuid,
  p_actor_pi_uid text,
  p_fee_payment_id text,
  p_fee_payment_txid text
)
RETURNS public.testnet_outflow_fee_assessments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.testnet_outflow_fee_assessments%ROWTYPE;
  v_payment_id text := nullif(trim(coalesce(p_fee_payment_id, '')), '');
  v_txid text := nullif(trim(coalesce(p_fee_payment_txid, '')), '');
  v_pi_uid text := nullif(trim(coalesce(p_actor_pi_uid, '')), '');
BEGIN
  IF p_assessment_id IS NULL OR v_payment_id IS NULL OR v_txid IS NULL OR v_pi_uid IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OUTFLOW_FEE_PAYMENT_FIELDS_REQUIRED';
  END IF;

  SELECT * INTO v_row
  FROM public.testnet_outflow_fee_assessments
  WHERE id = p_assessment_id AND network = 'testnet'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'OUTFLOW_FEE_ASSESSMENT_NOT_FOUND';
  END IF;

  IF v_row.actor_pi_uid IS DISTINCT FROM v_pi_uid THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'OUTFLOW_FEE_ACTOR_MISMATCH';
  END IF;

  IF v_row.fee_amount <= 0 OR v_row.fee_status = 'not_required' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OUTFLOW_FEE_PAYMENT_NOT_REQUIRED';
  END IF;

  IF v_row.fee_status = 'paid' THEN
    IF v_row.fee_payment_id = v_payment_id AND v_row.fee_payment_txid = v_txid THEN
      RETURN v_row;
    END IF;
    RAISE EXCEPTION USING errcode = '23505', message = 'OUTFLOW_FEE_ALREADY_PAID_WITH_DIFFERENT_PAYMENT';
  END IF;

  IF v_row.fee_status <> 'payment_pending' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OUTFLOW_FEE_NOT_AWAITING_PAYMENT';
  END IF;

  UPDATE public.testnet_outflow_fee_assessments
  SET fee_status = 'paid',
      fee_payment_id = v_payment_id,
      fee_payment_txid = v_txid,
      updated_at = now()
  WHERE id = p_assessment_id AND network = 'testnet'
  RETURNING * INTO v_row;

  INSERT INTO public.testnet_platform_fee_ledger (
    network, assessment_id, entry_type, movement, amount, payment_txid,
    idempotency_key, metadata
  )
  VALUES (
    'testnet', v_row.id, 'fee_collected', 'credit', v_row.fee_amount, v_txid,
    'testnet-outflow-fee:' || v_row.id::text || ':collected',
    jsonb_build_object(
      'fee_payment_id', v_payment_id,
      'source_type', v_row.source_type,
      'source_id', v_row.source_id,
      'actor_user_id', v_row.actor_user_id,
      'actor_pi_uid', v_row.actor_pi_uid,
      'network', 'testnet'
    )
  )
  ON CONFLICT (assessment_id, entry_type) DO NOTHING;

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.assert_testnet_outflow_fee_ready(
  p_source_type text,
  p_source_id uuid
)
RETURNS public.testnet_outflow_fee_assessments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.testnet_outflow_fee_assessments%ROWTYPE;
BEGIN
  IF p_source_type NOT IN ('staker_withdrawal', 'project_owner_withdrawal') OR p_source_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OUTFLOW_FEE_SOURCE_INVALID';
  END IF;

  SELECT * INTO v_row
  FROM public.testnet_outflow_fee_assessments
  WHERE source_type = p_source_type
    AND source_id = p_source_id
    AND network = 'testnet'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'OUTFLOW_FEE_ASSESSMENT_REQUIRED';
  END IF;

  IF v_row.fee_amount > 0 AND v_row.fee_status <> 'paid' THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'OUTFLOW_FEE_PAYMENT_REQUIRED';
  END IF;

  IF v_row.fee_amount = 0 AND v_row.fee_status NOT IN ('not_required', 'paid') THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'OUTFLOW_FEE_STATUS_INVALID';
  END IF;

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_testnet_withdrawal(
  p_pi_uid text,
  p_stake_id uuid,
  p_withdrawal_type text,
  p_requested_amount numeric,
  p_wallet_address text
)
RETURNS public.withdrawal_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := nullif(trim(p_pi_uid), '');
  v_type text := lower(trim(p_withdrawal_type));
  v_wallet text := nullif(trim(p_wallet_address), '');
  v_requested numeric := round(coalesce(p_requested_amount, 0)::numeric, 7);
  v_min_requested numeric := 0.50;
  v_policy_active boolean := false;
  v_available numeric;
  v_project_available numeric;
  v_project_pending numeric;
  v_stake public.stakes%ROWTYPE;
  v_user_id uuid;
  v_user_wallet text;
  v_project_id uuid;
  v_project_code text;
  v_withdrawn numeric;
  v_result public.withdrawal_requests;
BEGIN
  SELECT active INTO v_policy_active
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1 AND network = 'testnet';

  IF NOT FOUND OR v_policy_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'TESTNET_GLOBAL_TREASURY_POLICY_INACTIVE';
  END IF;

  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PI_UID_REQUIRED';
  END IF;
  IF p_stake_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_ID_REQUIRED';
  END IF;
  IF v_type NOT IN ('reward', 'capital') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_WITHDRAWAL_TYPE';
  END IF;
  IF v_requested::text IN ('NaN', 'Infinity', '-Infinity') OR v_requested < v_min_requested THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'MINIMUM_STAKER_WITHDRAWAL_IS_0.50_PI';
  END IF;
  IF v_wallet IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'WALLET_ADDRESS_REQUIRED';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('albukhr:testnet:withdraw:' || v_uid, 0));

  SELECT s.* INTO v_stake
  FROM public.stakes s
  WHERE s.id = p_stake_id AND s.pi_uid = v_uid AND s.network = 'testnet'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'STAKE_NOT_FOUND';
  END IF;
  IF lower(coalesce(v_stake.status, '')) NOT IN ('active', 'completed') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_NOT_WITHDRAWABLE';
  END IF;

  v_project_id := v_stake.project_id;
  v_project_code := v_stake.project_code;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('albukhr:testnet:project-withdraw:' || v_project_id::text, 0)
  );

  SELECT u.id, u.wallet_address INTO v_user_id, v_user_wallet
  FROM public.users u
  WHERE u.pi_uid = v_uid AND u.network = 'testnet'
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'TESTNET_USER_NOT_FOUND';
  END IF;

  IF nullif(trim(coalesce(v_user_wallet, '')), '') IS NOT NULL
     AND trim(v_user_wallet) <> v_wallet THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'WITHDRAWAL_WALLET_MISMATCH';
  END IF;

  SELECT coalesce(sum(round(w.requested_amount + w.fee_amount, 7)), 0)
    INTO v_withdrawn
  FROM public.withdrawal_requests w
  WHERE w.stake_id = v_stake.id
    AND w.pi_uid = v_uid
    AND w.network = 'testnet'
    AND lower(w.withdrawal_type) = v_type
    AND w.status IN ('pending', 'processing', 'completed', 'approved');

  IF v_type = 'reward' THEN
    v_available := greatest(
      round(coalesce(v_stake.reward_amount, 0) - v_withdrawn, 7), 0
    );

    SELECT coalesce(sum(CASE WHEN l.movement='credit' THEN l.amount ELSE -l.amount END), 0)
      INTO v_project_available
    FROM public.project_staking_ledger l
    WHERE l.project_id = v_project_id AND l.network = 'testnet'
      AND l.bucket = 'reward_reserve';

    SELECT coalesce(sum(w.requested_amount + w.fee_amount), 0)
      INTO v_project_pending
    FROM public.withdrawal_requests w
    WHERE w.project_id = v_project_id AND w.network = 'testnet'
      AND w.withdrawal_type = 'reward'
      AND w.status IN ('pending', 'processing', 'approved');

    IF round(v_project_available - v_project_pending, 7) < v_requested THEN
      RAISE EXCEPTION USING errcode = '22003', message = 'PROJECT_REWARD_RESERVE_INSUFFICIENT';
    END IF;
  ELSE
    IF v_stake.unlock_at IS NULL OR now() < v_stake.unlock_at THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'CAPITAL_IS_LOCKED_UNTIL_UNLOCK_AT';
    END IF;

    v_available := greatest(
      round(coalesce(v_stake.amount, 0) - v_withdrawn, 7), 0
    );

    SELECT coalesce(sum(CASE WHEN l.movement='credit' THEN l.amount ELSE -l.amount END)
      FILTER (WHERE l.bucket IN ('capital_reserve','project_operating')), 0)
      INTO v_project_available
    FROM public.project_staking_ledger l
    WHERE l.project_id = v_project_id AND l.network = 'testnet';

    SELECT coalesce(sum(w.requested_amount + w.fee_amount), 0)
      INTO v_project_pending
    FROM public.withdrawal_requests w
    WHERE w.project_id = v_project_id AND w.network = 'testnet'
      AND w.withdrawal_type = 'capital'
      AND w.status IN ('pending', 'processing', 'approved');

    IF round(v_project_available - v_project_pending, 7) < v_requested THEN
      RAISE EXCEPTION USING errcode = '22003', message = 'PROJECT_CAPITAL_RESERVE_INSUFFICIENT';
    END IF;
  END IF;

  IF v_requested > v_available THEN
    RAISE EXCEPTION USING errcode = '22003',
      message = 'INSUFFICIENT_WITHDRAWABLE_BALANCE',
      detail = format('requested=%s available=%s', v_requested, v_available);
  END IF;

  INSERT INTO public.withdrawal_requests (
    stake_id, user_id, pi_uid, project_id, project_code, network,
    withdrawal_type, requested_amount, fee_rate, fee_amount, net_amount,
    wallet_address, status, created_at, updated_at
  )
  VALUES (
    v_stake.id, v_user_id, v_uid, v_project_id, v_project_code, 'testnet',
    v_type, v_requested, 0, 0, v_requested,
    v_wallet, 'pending', now(), now()
  )
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_testnet_project_owner_withdrawal(
  p_project_id uuid,
  p_owner_user_id uuid,
  p_requested_amount numeric,
  p_wallet_address text,
  p_fee_rate numeric DEFAULT 0
)
RETURNS public.project_owner_withdrawals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_project public.projects%ROWTYPE;
  v_owner public.users%ROWTYPE;
  v_available numeric;
  v_policy_active boolean := false;
  v_requested numeric := round(coalesce(p_requested_amount, 0)::numeric, 7);
  v_row public.project_owner_withdrawals%ROWTYPE;
  v_wallet text := nullif(trim(coalesce(p_wallet_address, '')), '');
BEGIN
  SELECT active INTO v_policy_active
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1 AND network = 'testnet';

  IF NOT FOUND OR v_policy_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'TESTNET_GLOBAL_TREASURY_POLICY_INACTIVE';
  END IF;

  IF v_requested IS NULL OR v_requested <= 0
     OR v_requested::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OWNER_WITHDRAWAL_AMOUNT_INVALID';
  END IF;

  IF p_fee_rate IS NOT NULL AND p_fee_rate <> 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OWNER_WITHDRAWAL_FEE_MUST_BE_PAID_SEPARATELY';
  END IF;

  IF v_wallet IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OWNER_WITHDRAWAL_WALLET_REQUIRED';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_project_id::text || ':' || p_owner_user_id::text, 0)
  );

  SELECT * INTO v_project
  FROM public.projects
  WHERE id = p_project_id AND network = 'testnet' AND status = 'approved'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'PROJECT_NOT_APPROVED';
  END IF;

  SELECT * INTO v_owner
  FROM public.users
  WHERE id = p_owner_user_id AND network = 'testnet'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'OWNER_USER_NOT_FOUND';
  END IF;

  IF v_project.owner_user_id IS DISTINCT FROM v_owner.id THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'PROJECT_OWNER_ACCESS_DENIED';
  END IF;

  IF v_owner.wallet_address IS NOT NULL AND trim(v_owner.wallet_address) <> ''
     AND trim(v_owner.wallet_address) <> v_wallet THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'OWNER_WITHDRAWAL_WALLET_MISMATCH';
  END IF;

  v_available := public.get_testnet_project_owner_balance(p_project_id, p_owner_user_id);
  IF v_available < v_requested THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'OWNER_BALANCE_INSUFFICIENT';
  END IF;

  INSERT INTO public.project_owner_withdrawals (
    project_id, owner_user_id, network, requested_amount,
    fee_rate, fee_amount, net_amount, wallet_address, status, metadata
  )
  VALUES (
    p_project_id, p_owner_user_id, 'testnet', v_requested,
    0, 0, v_requested, v_wallet, 'pending',
    jsonb_build_object('source', 'project_owner', 'network', 'testnet',
      'fee_paid_separately', true)
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_testnet_withdrawal_and_ledger(
  p_request_id uuid,
  p_txid text
)
RETURNS public.withdrawal_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.withdrawal_requests%ROWTYPE;
  v_stake public.stakes%ROWTYPE;
  v_txid text := nullif(trim(coalesce(p_txid, '')), '');
  v_gross numeric;
  v_capital_balance numeric;
  v_operating_balance numeric;
  v_from_capital numeric;
  v_from_operating numeric;
  v_reward_balance numeric;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'WITHDRAWAL_ID_REQUIRED';
  END IF;
  IF v_txid IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'WITHDRAWAL_TXID_REQUIRED';
  END IF;

  SELECT * INTO v_row
  FROM public.withdrawal_requests
  WHERE id = p_request_id AND network = 'testnet'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'WITHDRAWAL_NOT_FOUND';
  END IF;

  IF v_row.status NOT IN ('completed', 'approved', 'processing') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'WITHDRAWAL_NOT_READY_FOR_COMPLETION';
  END IF;

  PERFORM public.assert_testnet_outflow_fee_ready('staker_withdrawal', p_request_id);

  SELECT * INTO v_stake
  FROM public.stakes
  WHERE id = v_row.stake_id AND network = 'testnet'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'WITHDRAWAL_STAKE_NOT_FOUND';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('albukhr:testnet:project-withdraw:' || v_stake.project_id::text, 0)
  );

  v_gross := round(v_row.requested_amount, 7);

  IF v_row.status = 'completed' THEN
    IF EXISTS (
      SELECT 1 FROM public.project_staking_ledger
      WHERE idempotency_key IN (
        'withdrawal:' || v_row.id::text || ':settlement',
        'withdrawal:' || v_row.id::text || ':capital-reserve-settlement',
        'withdrawal:' || v_row.id::text || ':project-operating-settlement'
      )
    ) THEN
      UPDATE public.testnet_outflow_fee_assessments
      SET payout_txid = coalesce(payout_txid, v_txid), updated_at = now()
      WHERE source_type = 'staker_withdrawal' AND source_id = p_request_id
        AND network = 'testnet';
      RETURN v_row;
    END IF;
  END IF;

  IF v_row.withdrawal_type = 'reward' THEN
    SELECT coalesce(sum(CASE WHEN l.movement='credit' THEN l.amount ELSE -l.amount END), 0)
      INTO v_reward_balance
    FROM public.project_staking_ledger l
    WHERE l.project_id = v_stake.project_id AND l.network = 'testnet'
      AND l.bucket = 'reward_reserve';

    IF v_reward_balance < v_gross THEN
      RAISE EXCEPTION USING errcode = '22003', message = 'PROJECT_REWARD_RESERVE_INSUFFICIENT_AT_SETTLEMENT';
    END IF;

    INSERT INTO public.project_staking_ledger (
      network, project_id, stake_id, withdrawal_request_id, bucket, movement,
      event_type, amount, source_type, source_id, idempotency_key, metadata
    ) VALUES (
      'testnet', v_stake.project_id, v_stake.id, v_row.id, 'reward_reserve', 'debit',
      'reward_paid', v_gross, 'withdrawal', v_row.id::text,
      'withdrawal:' || v_row.id::text || ':settlement',
      jsonb_build_object('txid', v_txid, 'requested_amount', v_row.requested_amount,
        'fee_amount', 0, 'gross_deduction', v_gross, 'network', 'testnet')
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  ELSE
    SELECT coalesce(sum(CASE WHEN l.movement='credit' THEN l.amount ELSE -l.amount END)
      FILTER (WHERE l.bucket='capital_reserve'), 0),
      coalesce(sum(CASE WHEN l.movement='credit' THEN l.amount ELSE -l.amount END)
      FILTER (WHERE l.bucket='project_operating'), 0)
    INTO v_capital_balance, v_operating_balance
    FROM public.project_staking_ledger l
    WHERE l.project_id = v_stake.project_id AND l.network = 'testnet';

    IF coalesce(v_capital_balance,0) + coalesce(v_operating_balance,0) < v_gross THEN
      RAISE EXCEPTION USING errcode = '22003', message = 'PROJECT_CAPITAL_RESERVE_INSUFFICIENT_AT_SETTLEMENT';
    END IF;

    v_from_capital := least(greatest(coalesce(v_capital_balance,0),0), v_gross);
    v_from_operating := v_gross - v_from_capital;

    IF v_from_capital > 0 THEN
      INSERT INTO public.project_staking_ledger (
        network, project_id, stake_id, withdrawal_request_id, bucket, movement,
        event_type, amount, source_type, source_id, idempotency_key, metadata
      ) VALUES (
        'testnet', v_stake.project_id, v_stake.id, v_row.id, 'capital_reserve', 'debit',
        'capital_returned', v_from_capital, 'withdrawal', v_row.id::text,
        'withdrawal:' || v_row.id::text || ':capital-reserve-settlement',
        jsonb_build_object('txid', v_txid, 'network', 'testnet')
      ) ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;

    IF v_from_operating > 0 THEN
      INSERT INTO public.project_staking_ledger (
        network, project_id, stake_id, withdrawal_request_id, bucket, movement,
        event_type, amount, source_type, source_id, idempotency_key, metadata
      ) VALUES (
        'testnet', v_stake.project_id, v_stake.id, v_row.id, 'project_operating', 'debit',
        'capital_returned', v_from_operating, 'withdrawal', v_row.id::text,
        'withdrawal:' || v_row.id::text || ':project-operating-settlement',
        jsonb_build_object('txid', v_txid, 'network', 'testnet')
      ) ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;
  END IF;

  UPDATE public.withdrawal_requests
  SET status = 'completed',
      fee_rate = 0,
      fee_amount = 0,
      net_amount = requested_amount,
      txid = v_txid,
      reviewed_at = coalesce(reviewed_at, now()),
      updated_at = now()
  WHERE id = p_request_id AND network = 'testnet'
  RETURNING * INTO v_row;

  UPDATE public.testnet_outflow_fee_assessments
  SET payout_txid = v_txid, updated_at = now()
  WHERE source_type = 'staker_withdrawal' AND source_id = p_request_id
    AND network = 'testnet';

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_testnet_project_owner_withdrawal(
  p_withdrawal_id uuid,
  p_txid text,
  p_reviewed_by uuid
)
RETURNS public.project_owner_withdrawals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.project_owner_withdrawals%ROWTYPE;
  v_existing public.project_owner_ledger_entries%ROWTYPE;
  v_txid text := nullif(trim(coalesce(p_txid, '')), '');
BEGIN
  IF v_txid IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OWNER_WITHDRAWAL_TXID_REQUIRED';
  END IF;

  SELECT * INTO v_row
  FROM public.project_owner_withdrawals
  WHERE id = p_withdrawal_id AND network = 'testnet'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'OWNER_WITHDRAWAL_NOT_FOUND';
  END IF;

  IF v_row.status = 'completed' THEN
    RETURN v_row;
  END IF;

  IF v_row.status NOT IN ('approved', 'processing') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OWNER_WITHDRAWAL_NOT_READY';
  END IF;

  PERFORM public.assert_testnet_outflow_fee_ready('project_owner_withdrawal', p_withdrawal_id);

  INSERT INTO public.project_owner_ledger_entries (
    project_id, owner_user_id, network, entry_type, amount, source_type,
    source_reference, description, metadata
  )
  VALUES (
    v_row.project_id, v_row.owner_user_id, 'testnet', 'debit',
    v_row.requested_amount, 'owner_withdrawal', v_row.id::text,
    'Project Owner withdrawal',
    jsonb_build_object(
      'withdrawal_id', v_row.id,
      'txid', v_txid,
      'net_amount', v_row.requested_amount,
      'fee_amount', 0,
      'network', 'testnet',
      'fee_paid_separately', true
    )
  )
  ON CONFLICT (source_type, source_reference)
  WHERE source_reference IS NOT NULL
  DO NOTHING
  RETURNING * INTO v_existing;

  UPDATE public.project_owner_withdrawals
  SET status = 'completed',
      fee_rate = 0,
      fee_amount = 0,
      net_amount = requested_amount,
      txid = v_txid,
      reviewed_by = coalesce(p_reviewed_by, reviewed_by),
      reviewed_at = coalesce(reviewed_at, now()),
      updated_at = now()
  WHERE id = p_withdrawal_id AND network = 'testnet'
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'OWNER_WITHDRAWAL_COMPLETION_FAILED';
  END IF;

  UPDATE public.testnet_outflow_fee_assessments
  SET payout_txid = v_txid, updated_at = now()
  WHERE source_type = 'project_owner_withdrawal' AND source_id = p_withdrawal_id
    AND network = 'testnet';

  RETURN v_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_testnet_outflow_fee_assessment(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_testnet_outflow_fee_paid(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_testnet_outflow_fee_ready(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_testnet_withdrawal(text, uuid, text, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_testnet_project_owner_withdrawal(uuid, uuid, numeric, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_testnet_withdrawal_and_ledger(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_testnet_project_owner_withdrawal(uuid, text, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_testnet_outflow_fee_assessment(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_testnet_outflow_fee_paid(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.assert_testnet_outflow_fee_ready(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_testnet_withdrawal(text, uuid, text, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_testnet_project_owner_withdrawal(uuid, uuid, numeric, text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_testnet_withdrawal_and_ledger(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_testnet_project_owner_withdrawal(uuid, text, uuid) TO service_role;
