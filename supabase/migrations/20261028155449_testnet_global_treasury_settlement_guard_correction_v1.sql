-- Applied Testnet-only forward correction.
-- Corrects the project_operating ledger stake_id reference and keeps the
-- owner-withdrawal RETURNING/row check adjacent to the owner-row UPDATE.
-- This migration is safe to replay: it only replaces these two RPC bodies.

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

REVOKE ALL ON FUNCTION public.complete_testnet_withdrawal_and_ledger(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_testnet_project_owner_withdrawal(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_testnet_withdrawal_and_ledger(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_testnet_project_owner_withdrawal(uuid, text, uuid) TO service_role;
