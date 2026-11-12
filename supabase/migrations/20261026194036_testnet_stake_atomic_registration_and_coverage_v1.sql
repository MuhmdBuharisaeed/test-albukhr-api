
CREATE OR REPLACE FUNCTION public.get_testnet_staking_coverage(p_project_id uuid)
RETURNS TABLE (
  project_id uuid,
  network text,
  verified_liquidity_contributed numeric,
  owner_liquidity_available numeric,
  capital_reserve_balance numeric,
  project_operating_balance numeric,
  reward_reserve_balance numeric,
  total_tracked_assets numeric,
  outstanding_principal numeric,
  outstanding_rewards numeric,
  total_liability numeric,
  surplus numeric,
  coverage_ratio numeric,
  liquidity_buffer numeric,
  staking_eligible boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_project_network text;
BEGIN
  SELECT p.network
    INTO v_project_network
  FROM public.projects p
  WHERE p.id = p_project_id;

  IF v_project_network IS DISTINCT FROM 'testnet' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'TESTNET_PROJECT_REQUIRED';
  END IF;

  RETURN QUERY
  WITH ledger_balances AS (
    SELECT
      coalesce(sum(l.amount) FILTER (
        WHERE l.event_type = 'liquidity_verified'
          AND l.bucket = 'owner_liquidity'
          AND l.movement = 'credit'
      ), 0)::numeric AS verified_liquidity_contributed,
      coalesce(sum(CASE WHEN l.bucket = 'owner_liquidity'
        THEN CASE WHEN l.movement = 'credit' THEN l.amount ELSE -l.amount END
        ELSE 0 END), 0)::numeric AS owner_liquidity_available,
      coalesce(sum(CASE WHEN l.bucket = 'capital_reserve'
        THEN CASE WHEN l.movement = 'credit' THEN l.amount ELSE -l.amount END
        ELSE 0 END), 0)::numeric AS capital_reserve_balance,
      coalesce(sum(CASE WHEN l.bucket = 'project_operating'
        THEN CASE WHEN l.movement = 'credit' THEN l.amount ELSE -l.amount END
        ELSE 0 END), 0)::numeric AS project_operating_balance,
      coalesce(sum(CASE WHEN l.bucket = 'reward_reserve'
        THEN CASE WHEN l.movement = 'credit' THEN l.amount ELSE -l.amount END
        ELSE 0 END), 0)::numeric AS reward_reserve_balance
    FROM public.project_staking_ledger l
    WHERE l.project_id = p_project_id AND l.network = 'testnet'
  ),
  stake_liabilities AS (
    SELECT
      coalesce(sum(greatest(s.amount - coalesce(c.completed_deduction, 0), 0)), 0)::numeric
        AS outstanding_principal,
      coalesce(sum(greatest(s.reward_amount - coalesce(r.completed_deduction, 0), 0)), 0)::numeric
        AS outstanding_rewards
    FROM public.stakes s
    LEFT JOIN LATERAL (
      SELECT sum(w.requested_amount + w.fee_amount) AS completed_deduction
      FROM public.withdrawal_requests w
      WHERE w.stake_id = s.id
        AND w.network = 'testnet'
        AND w.withdrawal_type = 'capital'
        AND w.status = 'completed'
    ) c ON true
    LEFT JOIN LATERAL (
      SELECT sum(w.requested_amount + w.fee_amount) AS completed_deduction
      FROM public.withdrawal_requests w
      WHERE w.stake_id = s.id
        AND w.network = 'testnet'
        AND w.withdrawal_type = 'reward'
        AND w.status = 'completed'
    ) r ON true
    WHERE s.project_id = p_project_id
      AND s.network = 'testnet'
      AND s.status IN ('active', 'completed')
  ),
  policy AS (
    SELECT
      rc.staking_enabled,
      rc.approval_status,
      rc.minimum_liquidity,
      pt.status AS treasury_status,
      pt.required_liquidity
    FROM public.project_staking_risk_controls rc
    LEFT JOIN public.project_treasury pt
      ON pt.project_id = rc.project_id AND pt.network = 'testnet'
    WHERE rc.project_id = p_project_id AND rc.network = 'testnet'
  ),
  combined AS (
    SELECT
      b.*,
      sl.outstanding_principal,
      sl.outstanding_rewards,
      (b.owner_liquidity_available + b.capital_reserve_balance
        + b.project_operating_balance + b.reward_reserve_balance)::numeric AS total_tracked_assets,
      (b.owner_liquidity_available + b.reward_reserve_balance)::numeric AS liquidity_buffer,
      pol.staking_enabled,
      pol.approval_status,
      pol.minimum_liquidity,
      pol.treasury_status,
      pol.required_liquidity
    FROM ledger_balances b
    CROSS JOIN stake_liabilities sl
    LEFT JOIN policy pol ON true
  )
  SELECT
    p_project_id,
    'testnet'::text,
    c.verified_liquidity_contributed,
    c.owner_liquidity_available,
    c.capital_reserve_balance,
    c.project_operating_balance,
    c.reward_reserve_balance,
    c.total_tracked_assets,
    c.outstanding_principal,
    c.outstanding_rewards,
    (c.outstanding_principal + c.outstanding_rewards)::numeric,
    (c.total_tracked_assets - c.outstanding_principal - c.outstanding_rewards)::numeric,
    CASE
      WHEN c.outstanding_principal + c.outstanding_rewards = 0 THEN NULL
      ELSE round(c.total_tracked_assets
        / (c.outstanding_principal + c.outstanding_rewards), 7)
    END,
    c.liquidity_buffer,
    coalesce(c.staking_enabled, false)
      AND c.approval_status = 'approved'
      AND c.treasury_status = 'active'
      AND c.verified_liquidity_contributed >= coalesce(c.minimum_liquidity, 100)
      AND c.liquidity_buffer >= coalesce(c.minimum_liquidity, 100)
      AND c.total_tracked_assets >= c.outstanding_principal + c.outstanding_rewards
      AND c.reward_reserve_balance >= c.outstanding_rewards
  FROM combined c;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_testnet_stake_from_verified_payment(
  p_payment_id text,
  p_pi_uid text,
  p_duration_days integer
)
RETURNS public.stakes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_payment public.testnet_stake_payments%rowtype;
  v_project public.projects%rowtype;
  v_term public.project_staking_terms%rowtype;
  v_control public.project_staking_risk_controls%rowtype;
  v_treasury public.project_treasury%rowtype;
  v_user_id uuid;
  v_existing public.stakes%rowtype;
  v_stake public.stakes%rowtype;
  v_reward numeric;
  v_deployment_percent numeric;
  v_deploy_amount numeric;
  v_owner_liquidity numeric;
  v_assets numeric;
  v_principal_liability numeric;
  v_reward_liability numeric;
  v_liquidity_buffer numeric;
  v_payment_id text := nullif(trim(p_payment_id), '');
  v_uid text := nullif(trim(p_pi_uid), '');
BEGIN
  IF v_payment_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PAYMENT_ID_REQUIRED';
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PI_UID_REQUIRED';
  END IF;
  IF p_duration_days IS NULL OR p_duration_days <= 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'INVALID_STAKING_DURATION';
  END IF;

  SELECT * INTO v_payment
  FROM public.testnet_stake_payments
  WHERE payment_id = v_payment_id AND network = 'testnet'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'VERIFIED_STAKE_PAYMENT_NOT_FOUND';
  END IF;
  IF v_payment.action <> 'stake'
     OR v_payment.pi_status <> 'completed'
     OR v_payment.verification_status <> 'verified'
     OR v_payment.payer_pi_uid IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_PAYMENT_NOT_VERIFIED_FOR_USER';
  END IF;

  -- Idempotent completion: retries return the same stake, never create another.
  SELECT * INTO v_existing
  FROM public.stakes
  WHERE payment_id = v_payment.payment_id AND network = 'testnet';

  IF FOUND THEN
    IF v_existing.pi_uid IS DISTINCT FROM v_uid
       OR v_existing.project_id IS DISTINCT FROM v_payment.project_id
       OR v_existing.duration_days IS DISTINCT FROM p_duration_days THEN
      RAISE EXCEPTION USING errcode = '23505', message = 'STAKE_PAYMENT_IDEMPOTENCY_MISMATCH';
    END IF;
    RETURN v_existing;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('albukhr:testnet:staking:' || v_payment.project_id::text, 0)
  );

  SELECT * INTO v_project
  FROM public.projects
  WHERE id = v_payment.project_id
    AND project_code = v_payment.project_code
    AND network = 'testnet'
    AND status = 'approved'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PROJECT_NOT_APPROVED_FOR_TESTNET_STAKING';
  END IF;

  SELECT * INTO v_user_id
  FROM public.users
  WHERE pi_uid = v_uid AND network = 'testnet'
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'TESTNET_USER_NOT_FOUND';
  END IF;

  SELECT * INTO v_term
  FROM public.project_staking_terms
  WHERE project_code = v_project.project_code
    AND network = 'testnet'
    AND duration_days = p_duration_days
    AND active = true
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKING_TERM_NOT_ACTIVE';
  END IF;

  SELECT * INTO v_control
  FROM public.project_staking_risk_controls
  WHERE project_id = v_project.id AND network = 'testnet'
  FOR UPDATE;

  IF NOT FOUND
     OR NOT v_control.staking_enabled
     OR v_control.approval_status <> 'approved'
     OR v_control.capital_reserve_percent IS NULL
     OR v_control.maximum_deployment_percent IS NULL
     OR v_control.max_reward_rate IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKING_NOT_ENABLED_OR_NOT_APPROVED';
  END IF;

  IF v_term.min_stake > v_payment.amount THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_AMOUNT_BELOW_TERM_MINIMUM';
  END IF;
  IF v_term.reward_rate <= 0 OR v_term.reward_rate > v_control.max_reward_rate THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKING_REWARD_RATE_OUTSIDE_POLICY';
  END IF;
  IF v_control.capital_reserve_percent + v_control.maximum_deployment_percent > 100 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKING_RESERVE_DEPLOYMENT_POLICY_INVALID';
  END IF;

  SELECT * INTO v_treasury
  FROM public.project_treasury
  WHERE project_id = v_project.id AND network = 'testnet'
  FOR SHARE;

  IF NOT FOUND OR v_treasury.status <> 'active'
     OR v_treasury.verified_liquidity < greatest(v_treasury.required_liquidity, v_control.minimum_liquidity) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PROJECT_LIQUIDITY_REQUIREMENT_NOT_MET';
  END IF;

  v_reward := round(v_payment.amount * v_term.reward_rate, 7);
  IF v_reward <= 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_REWARD_MUST_BE_POSITIVE';
  END IF;

  SELECT
    c.owner_liquidity_available,
    c.total_tracked_assets,
    c.outstanding_principal,
    c.outstanding_rewards,
    c.liquidity_buffer
  INTO
    v_owner_liquidity,
    v_assets,
    v_principal_liability,
    v_reward_liability,
    v_liquidity_buffer
  FROM public.get_testnet_staking_coverage(v_project.id) c;

  IF coalesce(v_owner_liquidity, 0) < v_reward THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'REWARD_LIQUIDITY_RESERVE_INSUFFICIENT';
  END IF;

  IF coalesce(v_liquidity_buffer, 0) < v_control.minimum_liquidity THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'MINIMUM_LIQUIDITY_BUFFER_NOT_MET';
  END IF;

  IF v_control.max_active_principal IS NOT NULL
     AND v_principal_liability + v_payment.amount > v_control.max_active_principal THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'PROJECT_ACTIVE_STAKING_CAP_REACHED';
  END IF;

  -- The incoming principal backs its own principal liability; the existing
  -- project assets must additionally cover the newly promised immediate reward.
  IF coalesce(v_assets, 0) < coalesce(v_principal_liability, 0)
       + coalesce(v_reward_liability, 0) + v_reward THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'STAKING_COVERAGE_INSUFFICIENT';
  END IF;

  SELECT u.id INTO v_user_id
  FROM public.users u
  WHERE u.pi_uid = v_uid AND u.network = 'testnet'
  LIMIT 1;

  INSERT INTO public.stakes (
    project_id, project_code, user_id, pi_uid, network,
    amount, duration_days, reward_rate, reward_amount, status,
    payment_record_id, payment_id, start_at, unlock_at, created_at, updated_at
  )
  VALUES (
    v_project.id, v_project.project_code, v_user_id, v_uid, 'testnet',
    v_payment.amount, v_term.duration_days, v_term.reward_rate, v_reward, 'active',
    v_payment.id, v_payment.payment_id, now(),
    now() + make_interval(days => v_term.duration_days), now(), now()
  )
  RETURNING * INTO v_stake;

  -- Receive principal into the reserve bucket before allocating the permitted
  -- deployment portion. Any unallocated remainder stays reserved for capital.
  INSERT INTO public.project_staking_ledger (
    network, project_id, stake_id, stake_payment_id, bucket, movement, event_type,
    amount, source_type, source_id, idempotency_key, metadata
  )
  VALUES (
    'testnet', v_project.id, v_stake.id, v_payment.id, 'capital_reserve',
    'credit', 'stake_principal_received', v_payment.amount,
    'stake_payment', v_payment.payment_id, 'stake:' || v_payment.payment_id || ':principal',
    jsonb_build_object('duration_days', v_term.duration_days, 'reward_rate', v_term.reward_rate)
  );

  v_deployment_percent := least(
    v_control.maximum_deployment_percent,
    100 - v_control.capital_reserve_percent
  );
  v_deploy_amount := round(v_payment.amount * v_deployment_percent / 100, 7);

  IF v_deploy_amount > 0 THEN
    INSERT INTO public.project_staking_ledger (
      network, project_id, stake_id, stake_payment_id, bucket, movement, event_type,
      amount, source_type, source_id, idempotency_key, metadata
    )
    VALUES
    (
      'testnet', v_project.id, v_stake.id, v_payment.id, 'capital_reserve',
      'debit', 'capital_released_to_project', v_deploy_amount,
      'stake_payment', v_payment.payment_id, 'stake:' || v_payment.payment_id || ':reserve-debit',
      jsonb_build_object('deployment_percent', v_deployment_percent)
    ),
    (
      'testnet', v_project.id, v_stake.id, v_payment.id, 'project_operating',
      'credit', 'capital_released_to_project', v_deploy_amount,
      'stake_payment', v_payment.payment_id, 'stake:' || v_payment.payment_id || ':operating-credit',
      jsonb_build_object('deployment_percent', v_deployment_percent)
    );
  END IF;

  -- The immediate reward is sourced only from verified project liquidity,
  -- never from a future investor's principal. Moving buckets does not change
  -- tracked assets; paying the reward later will reduce the reserve.
  INSERT INTO public.project_staking_ledger (
    network, project_id, stake_id, stake_payment_id, bucket, movement, event_type,
    amount, source_type, source_id, idempotency_key, metadata
  )
  VALUES
  (
    'testnet', v_project.id, v_stake.id, v_payment.id, 'owner_liquidity',
    'debit', 'reward_reserved', v_reward,
    'stake_reward', v_payment.payment_id, 'stake:' || v_payment.payment_id || ':reward-source',
    jsonb_build_object('reward_rate', v_term.reward_rate)
  ),
  (
    'testnet', v_project.id, v_stake.id, v_payment.id, 'reward_reserve',
    'credit', 'reward_reserved', v_reward,
    'stake_reward', v_payment.payment_id, 'stake:' || v_payment.payment_id || ':reward-reserve',
    jsonb_build_object('reward_rate', v_term.reward_rate)
  );

  RETURN v_stake;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_testnet_staking_coverage(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_testnet_staking_coverage(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.create_testnet_stake_from_verified_payment(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_testnet_stake_from_verified_payment(text, text, integer) TO service_role;
