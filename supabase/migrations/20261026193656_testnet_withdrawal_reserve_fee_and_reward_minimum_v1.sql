
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

  -- Rewards may be withdrawn in smaller increments than principal.
  v_min_requested := CASE WHEN v_type = 'reward' THEN 0.01 ELSE 0.50 END;

  IF v_requested < v_min_requested THEN
    RAISE EXCEPTION USING errcode = '22023',
      message = CASE
        WHEN v_type = 'reward' THEN 'MINIMUM_REWARD_WITHDRAWAL_IS_0.01_PI'
        ELSE 'MINIMUM_CAPITAL_WITHDRAWAL_IS_0.50_PI'
      END;
  END IF;

  IF v_wallet IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'WALLET_ADDRESS_REQUIRED';
  END IF;

  /*
   * Serialize withdrawals for this investor and lock the stake row.
   * This prevents concurrent requests from using the same balance.
   */
  PERFORM pg_advisory_xact_lock(
    hashtextextended('albukhr:testnet:withdraw:' || v_uid, 0)
  );

  SELECT s.*
    INTO v_stake
  FROM public.stakes s
  WHERE s.id = p_stake_id
    AND s.pi_uid = v_uid
    AND s.network = 'testnet'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'STAKE_NOT_FOUND';
  END IF;

  IF lower(coalesce(v_stake.status, '')) NOT IN ('active', 'completed') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_NOT_WITHDRAWABLE';
  END IF;

  v_project_id := v_stake.project_id;
  v_project_code := v_stake.project_code;

  SELECT u.id
    INTO v_user_id
  FROM public.users u
  WHERE u.pi_uid = v_uid
    AND u.network = 'testnet'
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'TESTNET_USER_NOT_FOUND';
  END IF;

  v_fee := greatest(round(v_requested * v_fee_rate, 7), v_min_fee);
  v_required := round(v_requested + v_fee, 7);

  /*
   * Reserve the full gross deduction for every non-rejected/non-cancelled
   * withdrawal. requested_amount is what the investor receives; fee_amount
   * is an additional deduction from the same stake balance.
   */
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
      round(coalesce(v_stake.reward_amount, 0) - v_withdrawn, 7),
      0
    );
  ELSE
    IF v_stake.unlock_at IS NULL OR now() < v_stake.unlock_at THEN
      RAISE EXCEPTION USING errcode = '22023',
        message = 'CAPITAL_IS_LOCKED_UNTIL_UNLOCK_AT';
    END IF;

    v_available := greatest(
      round(coalesce(v_stake.amount, 0) - v_withdrawn, 7),
      0
    );
  END IF;

  IF v_required > v_available THEN
    RAISE EXCEPTION USING errcode = '22003',
      message = 'INSUFFICIENT_WITHDRAWABLE_BALANCE',
      detail = format(
        'requested=%s fee=%s total_deduction=%s available=%s',
        v_requested, v_fee, v_required, v_available
      );
  END IF;

  INSERT INTO public.withdrawal_requests (
    stake_id,
    user_id,
    pi_uid,
    project_id,
    project_code,
    network,
    withdrawal_type,
    requested_amount,
    fee_rate,
    fee_amount,
    net_amount,
    wallet_address,
    status,
    created_at,
    updated_at
  )
  VALUES (
    v_stake.id,
    v_user_id,
    v_uid,
    v_project_id,
    v_project_code,
    'testnet',
    v_type,
    v_requested,
    v_fee_rate,
    v_fee,
    v_requested,
    v_wallet,
    'pending',
    now(),
    now()
  )
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_testnet_withdrawal(text, uuid, text, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_testnet_withdrawal(text, uuid, text, numeric, text) TO service_role;
