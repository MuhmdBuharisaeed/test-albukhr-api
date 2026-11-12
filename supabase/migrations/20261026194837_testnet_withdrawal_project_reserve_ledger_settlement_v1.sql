
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
SET search_path = public
AS $function$
DECLARE
  v_uid text := nullif(trim(p_pi_uid), '');
  v_type text := lower(trim(p_withdrawal_type));
  v_wallet text := nullif(trim(p_wallet_address), '');
  v_requested numeric := round(coalesce(p_requested_amount, 0)::numeric, 7);
  v_fee_rate numeric := 0.01;
  v_min_fee numeric := 0.01;
  v_min_requested numeric;
  v_fee numeric;
  v_required numeric;
  v_available numeric;
  v_project_available numeric;
  v_project_pending numeric;
  v_stake public.stakes%rowtype;
  v_user_id uuid;
  v_project_id uuid;
  v_project_code text;
  v_withdrawn numeric;
  v_result public.withdrawal_requests;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PI_UID_REQUIRED';
  END IF;
  IF p_stake_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_ID_REQUIRED';
  END IF;
  IF v_type NOT IN ('reward', 'capital') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_WITHDRAWAL_TYPE';
  END IF;

  v_min_requested := CASE WHEN v_type = 'reward' THEN 0.01 ELSE 0.50 END;
  IF v_requested < v_min_requested THEN
    RAISE EXCEPTION USING errcode = '22023',
      message = CASE WHEN v_type = 'reward'
        THEN 'MINIMUM_REWARD_WITHDRAWAL_IS_0.01_PI'
        ELSE 'MINIMUM_CAPITAL_WITHDRAWAL_IS_0.50_PI' END;
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

  -- Lock project-level capacity so different users cannot reserve the same
  -- reward/capital pool concurrently.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('albukhr:testnet:project-withdraw:' || v_project_id::text, 0)
  );

  SELECT u.id INTO v_user_id
  FROM public.users u
  WHERE u.pi_uid = v_uid AND u.network = 'testnet'
  LIMIT 1;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'TESTNET_USER_NOT_FOUND';
  END IF;

  v_fee := greatest(round(v_requested * v_fee_rate, 7), v_min_fee);
  v_required := round(v_requested + v_fee, 7);

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

    IF round(v_project_available - v_project_pending, 7) < v_required THEN
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

    IF round(v_project_available - v_project_pending, 7) < v_required THEN
      RAISE EXCEPTION USING errcode = '22003', message = 'PROJECT_CAPITAL_RESERVE_INSUFFICIENT';
    END IF;
  END IF;

  IF v_required > v_available THEN
    RAISE EXCEPTION USING errcode = '22003',
      message = 'INSUFFICIENT_WITHDRAWABLE_BALANCE',
      detail = format('requested=%s fee=%s total_deduction=%s available=%s',
        v_requested, v_fee, v_required, v_available);
  END IF;

  INSERT INTO public.withdrawal_requests (
    stake_id, user_id, pi_uid, project_id, project_code, network,
    withdrawal_type, requested_amount, fee_rate, fee_amount, net_amount,
    wallet_address, status, created_at, updated_at
  )
  VALUES (
    v_stake.id, v_user_id, v_uid, v_project_id, v_project_code, 'testnet',
    v_type, v_requested, v_fee_rate, v_fee, v_requested,
    v_wallet, 'pending', now(), now()
  )
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_testnet_withdrawal(text, uuid, text, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_testnet_withdrawal(text, uuid, text, numeric, text) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_testnet_withdrawal_and_ledger(
  p_request_id uuid,
  p_txid text
)
RETURNS public.withdrawal_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_row public.withdrawal_requests%rowtype;
  v_stake public.stakes%rowtype;
  v_txid text := nullif(trim(coalesce(p_txid, '')), '');
  v_gross numeric;
  v_fee numeric;
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

  v_gross := round(v_row.requested_amount + v_row.fee_amount, 7);
  v_fee := round(coalesce(v_row.fee_amount, 0), 7);

  IF v_row.status = 'completed' THEN
    -- Idempotent repair path: backfill the ledger record only if absent.
    IF EXISTS (SELECT 1 FROM public.project_staking_ledger
      WHERE idempotency_key = 'withdrawal:' || v_row.id::text || ':settlement') THEN
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
        'fee_amount', v_fee, 'gross_deduction', v_gross, 'network', 'testnet')
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

  IF v_fee > 0 THEN
    INSERT INTO public.project_staking_ledger (
      network, project_id, stake_id, withdrawal_request_id, bucket, movement,
      event_type, amount, source_type, source_id, idempotency_key, metadata
    ) VALUES (
      'testnet', v_stake.project_id, v_stake.id, v_row.id, 'platform_fees', 'credit',
      'withdrawal_fee_collected', v_fee, 'withdrawal', v_row.id::text,
      'withdrawal:' || v_row.id::text || ':fee-record',
      jsonb_build_object('txid', v_txid, 'gross_deduction', v_gross, 'network', 'testnet')
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  UPDATE public.withdrawal_requests
  SET status = 'completed',
      txid = v_txid,
      reviewed_at = coalesce(reviewed_at, now()),
      updated_at = now()
  WHERE id = p_request_id AND network = 'testnet'
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_testnet_withdrawal_and_ledger(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_testnet_withdrawal_and_ledger(uuid, text) TO service_role;
