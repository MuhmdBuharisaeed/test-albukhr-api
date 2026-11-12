
CREATE TABLE public.testnet_stake_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  project_code text NOT NULL REFERENCES public.projects(project_code) ON UPDATE CASCADE ON DELETE RESTRICT,
  pi_uid text NOT NULL,
  network text NOT NULL DEFAULT 'testnet' CHECK (network = 'testnet'),
  amount numeric NOT NULL CHECK (amount > 0),
  duration_days integer NOT NULL CHECK (duration_days > 0),
  reward_rate numeric NOT NULL CHECK (reward_rate > 0 AND reward_rate <= 1),
  reward_amount numeric NOT NULL CHECK (reward_amount > 0),
  capital_reserve_percent numeric NOT NULL CHECK (capital_reserve_percent BETWEEN 1 AND 99),
  maximum_deployment_percent numeric NOT NULL CHECK (maximum_deployment_percent BETWEEN 1 AND 99),
  payment_id text UNIQUE,
  stake_id uuid REFERENCES public.stakes(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment', 'created', 'cancelled', 'expired')),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '20 minutes'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT testnet_stake_intent_reserve_deploy_sum_check
    CHECK (capital_reserve_percent + maximum_deployment_percent <= 100)
);

CREATE INDEX testnet_stake_intents_project_status_expiry_idx
  ON public.testnet_stake_intents (project_id, network, status, expires_at);
CREATE INDEX testnet_stake_intents_pi_uid_status_idx
  ON public.testnet_stake_intents (pi_uid, network, status);

ALTER TABLE public.testnet_stake_intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY testnet_stake_intents_no_direct_api_access
  ON public.testnet_stake_intents FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.testnet_stake_intents FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.testnet_stake_intents TO service_role;

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
  SELECT p.network INTO v_project_network
  FROM public.projects p WHERE p.id = p_project_id;
  IF v_project_network IS DISTINCT FROM 'testnet' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'TESTNET_PROJECT_REQUIRED';
  END IF;

  RETURN QUERY
  WITH ledger_balances AS (
    SELECT
      coalesce(sum(l.amount) FILTER (
        WHERE l.event_type = 'liquidity_verified'
          AND l.bucket = 'owner_liquidity' AND l.movement = 'credit'
      ), 0)::numeric AS verified_liquidity_contributed,
      coalesce(sum(CASE WHEN l.bucket = 'owner_liquidity'
        THEN CASE WHEN l.movement = 'credit' THEN l.amount ELSE -l.amount END ELSE 0 END), 0)::numeric
        AS owner_liquidity_available,
      coalesce(sum(CASE WHEN l.bucket = 'capital_reserve'
        THEN CASE WHEN l.movement = 'credit' THEN l.amount ELSE -l.amount END ELSE 0 END), 0)::numeric
        AS capital_reserve_balance,
      coalesce(sum(CASE WHEN l.bucket = 'project_operating'
        THEN CASE WHEN l.movement = 'credit' THEN l.amount ELSE -l.amount END ELSE 0 END), 0)::numeric
        AS project_operating_balance,
      coalesce(sum(CASE WHEN l.bucket = 'reward_reserve'
        THEN CASE WHEN l.movement = 'credit' THEN l.amount ELSE -l.amount END ELSE 0 END), 0)::numeric
        AS reward_reserve_balance
    FROM public.project_staking_ledger l
    WHERE l.project_id = p_project_id AND l.network = 'testnet'
  ),
  stake_liabilities AS (
    SELECT
      coalesce(sum(greatest(s.amount - coalesce(c.completed_deduction, 0), 0)), 0)::numeric
        AS stake_principal,
      coalesce(sum(greatest(s.reward_amount - coalesce(r.completed_deduction, 0), 0)), 0)::numeric
        AS stake_rewards
    FROM public.stakes s
    LEFT JOIN LATERAL (
      SELECT sum(w.requested_amount + w.fee_amount) AS completed_deduction
      FROM public.withdrawal_requests w
      WHERE w.stake_id = s.id AND w.network = 'testnet'
        AND w.withdrawal_type = 'capital' AND w.status = 'completed'
    ) c ON true
    LEFT JOIN LATERAL (
      SELECT sum(w.requested_amount + w.fee_amount) AS completed_deduction
      FROM public.withdrawal_requests w
      WHERE w.stake_id = s.id AND w.network = 'testnet'
        AND w.withdrawal_type = 'reward' AND w.status = 'completed'
    ) r ON true
    WHERE s.project_id = p_project_id AND s.network = 'testnet'
      AND s.status IN ('active', 'completed')
  ),
  pending_intents AS (
    SELECT
      coalesce(sum(i.amount), 0)::numeric AS pending_principal,
      coalesce(sum(i.reward_amount), 0)::numeric AS pending_rewards
    FROM public.testnet_stake_intents i
    WHERE i.project_id = p_project_id AND i.network = 'testnet'
      AND i.status = 'pending_payment'
  ),
  policy AS (
    SELECT rc.staking_enabled, rc.approval_status, rc.minimum_liquidity,
           pt.status AS treasury_status
    FROM public.project_staking_risk_controls rc
    LEFT JOIN public.project_treasury pt
      ON pt.project_id = rc.project_id AND pt.network = 'testnet'
    WHERE rc.project_id = p_project_id AND rc.network = 'testnet'
  ),
  combined AS (
    SELECT
      b.*,
      (sl.stake_principal + pi.pending_principal)::numeric AS outstanding_principal,
      (sl.stake_rewards + pi.pending_rewards)::numeric AS outstanding_rewards,
      (b.owner_liquidity_available + b.capital_reserve_balance
        + b.project_operating_balance + b.reward_reserve_balance)::numeric AS total_tracked_assets,
      (b.owner_liquidity_available + b.reward_reserve_balance)::numeric AS liquidity_buffer,
      pol.staking_enabled, pol.approval_status, pol.minimum_liquidity, pol.treasury_status
    FROM ledger_balances b
    CROSS JOIN stake_liabilities sl
    CROSS JOIN pending_intents pi
    LEFT JOIN policy pol ON true
  )
  SELECT
    p_project_id, 'testnet'::text,
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
    CASE WHEN c.outstanding_principal + c.outstanding_rewards = 0 THEN NULL
      ELSE round(c.total_tracked_assets / (c.outstanding_principal + c.outstanding_rewards), 7) END,
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

CREATE OR REPLACE FUNCTION public.create_testnet_stake_intent(
  p_project_id uuid,
  p_project_code text,
  p_pi_uid text,
  p_amount numeric,
  p_duration_days integer
)
RETURNS public.testnet_stake_intents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_project public.projects%rowtype;
  v_treasury public.project_treasury%rowtype;
  v_term public.project_staking_terms%rowtype;
  v_control public.project_staking_risk_controls%rowtype;
  v_coverage record;
  v_expired public.testnet_stake_intents%rowtype;
  v_intent public.testnet_stake_intents%rowtype;
  v_amount numeric := round(coalesce(p_amount, 0)::numeric, 7);
  v_uid text := nullif(trim(p_pi_uid), '');
  v_reward numeric;
  v_pending_principal numeric;
  v_pending_rewards numeric;
  v_deployment_percent numeric;
BEGIN
  IF p_project_id IS NULL OR nullif(trim(p_project_code), '') IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PROJECT_ID_AND_CODE_REQUIRED';
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PI_UID_REQUIRED';
  END IF;
  IF v_amount <= 0 OR p_duration_days IS NULL OR p_duration_days <= 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_AMOUNT_AND_DURATION_REQUIRED';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('albukhr:testnet:staking:' || p_project_id::text, 0)
  );

  -- Expire only intents with no Pi payment ID bound. Bound intents may have
  -- a payment in flight and are held for explicit completion/cancellation.
  FOR v_expired IN
    SELECT * FROM public.testnet_stake_intents
    WHERE project_id = p_project_id AND network = 'testnet'
      AND status = 'pending_payment' AND payment_id IS NULL AND expires_at <= now()
    FOR UPDATE
  LOOP
    IF v_expired.reward_amount > 0 THEN
      INSERT INTO public.project_staking_ledger (
        network, project_id, bucket, movement, event_type, amount,
        source_type, source_id, idempotency_key, metadata
      )
      VALUES
      (
        'testnet', v_expired.project_id, 'reward_reserve', 'debit', 'admin_adjustment',
        v_expired.reward_amount, 'stake_intent', v_expired.id::text,
        'intent:' || v_expired.id::text || ':expire-reward-debit',
        jsonb_build_object('reason', 'intent_expired_before_payment', 'network', 'testnet')
      ),
      (
        'testnet', v_expired.project_id, 'owner_liquidity', 'credit', 'admin_adjustment',
        v_expired.reward_amount, 'stake_intent', v_expired.id::text,
        'intent:' || v_expired.id::text || ':expire-liquidity-credit',
        jsonb_build_object('reason', 'intent_expired_before_payment', 'network', 'testnet')
      );
    END IF;

    UPDATE public.testnet_stake_intents
    SET status = 'expired', updated_at = now()
    WHERE id = v_expired.id AND network = 'testnet';
  END LOOP;

  SELECT * INTO v_project
  FROM public.projects
  WHERE id = p_project_id AND project_code = trim(p_project_code)
    AND network = 'testnet' AND status = 'approved'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PROJECT_NOT_APPROVED_FOR_TESTNET_STAKING';
  END IF;

  SELECT * INTO v_treasury
  FROM public.project_treasury
  WHERE project_id = p_project_id AND network = 'testnet'
  FOR SHARE;
  IF NOT FOUND OR v_treasury.status <> 'active'
     OR v_treasury.verified_liquidity < v_treasury.required_liquidity THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PROJECT_LIQUIDITY_REQUIREMENT_NOT_MET';
  END IF;

  SELECT * INTO v_term
  FROM public.project_staking_terms
  WHERE project_code = v_project.project_code AND network = 'testnet'
    AND duration_days = p_duration_days AND active = true
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKING_TERM_NOT_ACTIVE';
  END IF;
  IF v_amount < v_term.min_stake THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_AMOUNT_BELOW_TERM_MINIMUM';
  END IF;

  SELECT * INTO v_control
  FROM public.project_staking_risk_controls
  WHERE project_id = p_project_id AND network = 'testnet'
  FOR UPDATE;
  IF NOT FOUND OR NOT v_control.staking_enabled OR v_control.approval_status <> 'approved'
     OR v_control.capital_reserve_percent IS NULL
     OR v_control.maximum_deployment_percent IS NULL
     OR v_control.max_reward_rate IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKING_NOT_ENABLED_OR_NOT_APPROVED';
  END IF;
  IF v_term.reward_rate <= 0 OR v_term.reward_rate > v_control.max_reward_rate THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKING_REWARD_RATE_OUTSIDE_POLICY';
  END IF;
  IF v_control.capital_reserve_percent + v_control.maximum_deployment_percent > 100 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKING_RESERVE_DEPLOYMENT_POLICY_INVALID';
  END IF;

  v_reward := round(v_amount * v_term.reward_rate, 7);
  IF v_reward <= 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_REWARD_MUST_BE_POSITIVE';
  END IF;

  SELECT * INTO v_coverage
  FROM public.get_testnet_staking_coverage(p_project_id);
  IF coalesce(v_coverage.staking_eligible, false) IS NOT TRUE THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'STAKING_LIQUIDITY_COVERAGE_NOT_ELIGIBLE';
  END IF;
  IF coalesce(v_coverage.owner_liquidity_available, 0) < v_reward THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'REWARD_LIQUIDITY_RESERVE_INSUFFICIENT';
  END IF;

  SELECT coalesce(sum(i.amount), 0), coalesce(sum(i.reward_amount), 0)
  INTO v_pending_principal, v_pending_rewards
  FROM public.testnet_stake_intents i
  WHERE i.project_id = p_project_id AND i.network = 'testnet'
    AND i.status = 'pending_payment' AND (i.expires_at > now() OR i.payment_id IS NOT NULL);

  IF v_control.max_active_principal IS NOT NULL
     AND v_coverage.outstanding_principal + v_amount > v_control.max_active_principal THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'PROJECT_ACTIVE_STAKING_CAP_REACHED';
  END IF;

  -- Incoming principal covers the matching principal obligation. Existing
  -- assets must cover prior liabilities and this new immediate reward.
  IF coalesce(v_coverage.total_tracked_assets, 0) <
       coalesce(v_coverage.total_liability, 0) + v_reward THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'STAKING_COVERAGE_INSUFFICIENT';
  END IF;

  v_deployment_percent := least(
    v_control.maximum_deployment_percent,
    100 - v_control.capital_reserve_percent
  );

  INSERT INTO public.testnet_stake_intents (
    project_id, project_code, pi_uid, network, amount, duration_days,
    reward_rate, reward_amount, capital_reserve_percent,
    maximum_deployment_percent, status, expires_at, metadata
  )
  VALUES (
    v_project.id, v_project.project_code, v_uid, 'testnet', v_amount, p_duration_days,
    v_term.reward_rate, v_reward, v_control.capital_reserve_percent,
    v_deployment_percent, 'pending_payment', now() + interval '20 minutes',
    jsonb_build_object('origin', 'testnet_staking', 'reward_withdrawal', 'immediate',
      'capital_unlock_days', p_duration_days)
  )
  RETURNING * INTO v_intent;

  -- Reserve the entire reward before a Pi payment is approved. This reserve
  -- is returned if the payment is officially cancelled or an unbound intent expires.
  INSERT INTO public.project_staking_ledger (
    network, project_id, bucket, movement, event_type, amount,
    source_type, source_id, idempotency_key, metadata
  )
  VALUES
  (
    'testnet', v_project.id, 'owner_liquidity', 'debit', 'reward_reserved',
    v_reward, 'stake_intent_reward', v_intent.id::text,
    'intent:' || v_intent.id::text || ':reward-source',
    jsonb_build_object('pi_uid', v_uid, 'payment_intent', v_intent.id, 'network', 'testnet')
  ),
  (
    'testnet', v_project.id, 'reward_reserve', 'credit', 'reward_reserved',
    v_reward, 'stake_intent_reward', v_intent.id::text,
    'intent:' || v_intent.id::text || ':reward-reserve',
    jsonb_build_object('pi_uid', v_uid, 'payment_intent', v_intent.id, 'network', 'testnet')
  );

  RETURN v_intent;
END;
$function$;

CREATE OR REPLACE FUNCTION public.bind_testnet_stake_intent_payment(
  p_intent_id uuid, p_pi_uid text, p_payment_id text
)
RETURNS public.testnet_stake_intents
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_intent public.testnet_stake_intents%rowtype;
  v_payment_id text := nullif(trim(p_payment_id), '');
BEGIN
  IF p_intent_id IS NULL OR nullif(trim(p_pi_uid), '') IS NULL OR v_payment_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_INTENT_BIND_FIELDS_REQUIRED';
  END IF;

  SELECT * INTO v_intent
  FROM public.testnet_stake_intents
  WHERE id = p_intent_id AND network = 'testnet'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'STAKE_INTENT_NOT_FOUND';
  END IF;
  IF v_intent.pi_uid IS DISTINCT FROM trim(p_pi_uid) THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'STAKE_INTENT_USER_MISMATCH';
  END IF;
  IF v_intent.status <> 'pending_payment' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_INTENT_NOT_PENDING';
  END IF;
  IF v_intent.payment_id IS NOT NULL AND v_intent.payment_id <> v_payment_id THEN
    RAISE EXCEPTION USING errcode = '23505', message = 'STAKE_INTENT_ALREADY_BOUND_TO_PAYMENT';
  END IF;
  IF v_intent.payment_id IS NULL AND v_intent.expires_at <= now() THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_INTENT_EXPIRED';
  END IF;

  UPDATE public.testnet_stake_intents
  SET payment_id = v_payment_id, updated_at = now()
  WHERE id = v_intent.id AND network = 'testnet'
  RETURNING * INTO v_intent;

  RETURN v_intent;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_testnet_stake_intent(
  p_intent_id uuid, p_pi_uid text, p_payment_id text DEFAULT NULL
)
RETURNS public.testnet_stake_intents
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_intent public.testnet_stake_intents%rowtype;
BEGIN
  SELECT * INTO v_intent
  FROM public.testnet_stake_intents
  WHERE id = p_intent_id AND network = 'testnet'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'STAKE_INTENT_NOT_FOUND';
  END IF;
  IF v_intent.pi_uid IS DISTINCT FROM nullif(trim(p_pi_uid), '') THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'STAKE_INTENT_USER_MISMATCH';
  END IF;
  IF v_intent.status = 'cancelled' OR v_intent.status = 'expired' THEN
    RETURN v_intent;
  END IF;
  IF v_intent.status <> 'pending_payment' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_INTENT_NOT_CANCELLABLE';
  END IF;
  IF v_intent.payment_id IS NOT NULL
     AND v_intent.payment_id IS DISTINCT FROM nullif(trim(p_payment_id), '') THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'STAKE_INTENT_PAYMENT_MISMATCH';
  END IF;

  IF v_intent.reward_amount > 0 THEN
    INSERT INTO public.project_staking_ledger (
      network, project_id, bucket, movement, event_type, amount,
      source_type, source_id, idempotency_key, metadata
    )
    VALUES
    (
      'testnet', v_intent.project_id, 'reward_reserve', 'debit', 'admin_adjustment',
      v_intent.reward_amount, 'stake_intent', v_intent.id::text,
      'intent:' || v_intent.id::text || ':cancel-reward-debit',
      jsonb_build_object('reason', 'pi_payment_cancelled', 'network', 'testnet')
    ),
    (
      'testnet', v_intent.project_id, 'owner_liquidity', 'credit', 'admin_adjustment',
      v_intent.reward_amount, 'stake_intent', v_intent.id::text,
      'intent:' || v_intent.id::text || ':cancel-liquidity-credit',
      jsonb_build_object('reason', 'pi_payment_cancelled', 'network', 'testnet')
    );
  END IF;

  UPDATE public.testnet_stake_intents
  SET status = 'cancelled', updated_at = now()
  WHERE id = v_intent.id AND network = 'testnet'
  RETURNING * INTO v_intent;

  RETURN v_intent;
END;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_testnet_stake_intent(
  p_intent_id uuid, p_pi_uid text, p_payment_id text
)
RETURNS public.stakes
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_intent public.testnet_stake_intents%rowtype;
  v_payment public.testnet_stake_payments%rowtype;
  v_user_id uuid;
  v_existing public.stakes%rowtype;
  v_stake public.stakes%rowtype;
  v_deploy_amount numeric;
  v_coverage record;
BEGIN
  SELECT * INTO v_intent
  FROM public.testnet_stake_intents
  WHERE id = p_intent_id AND network = 'testnet'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'STAKE_INTENT_NOT_FOUND';
  END IF;
  IF v_intent.pi_uid IS DISTINCT FROM nullif(trim(p_pi_uid), '') THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'STAKE_INTENT_USER_MISMATCH';
  END IF;
  IF v_intent.payment_id IS DISTINCT FROM nullif(trim(p_payment_id), '') THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'STAKE_INTENT_PAYMENT_MISMATCH';
  END IF;

  IF v_intent.status = 'created' AND v_intent.stake_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.stakes
    WHERE id = v_intent.stake_id AND network = 'testnet';
    IF FOUND THEN RETURN v_existing; END IF;
    RAISE EXCEPTION USING errcode = 'P0002', message = 'CREATED_STAKE_NOT_FOUND';
  END IF;
  IF v_intent.status <> 'pending_payment' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_INTENT_NOT_PENDING';
  END IF;

  SELECT * INTO v_payment
  FROM public.testnet_stake_payments
  WHERE payment_id = v_intent.payment_id AND network = 'testnet'
  FOR UPDATE;
  IF NOT FOUND OR v_payment.action <> 'stake'
     OR v_payment.pi_status <> 'completed'
     OR v_payment.verification_status <> 'verified'
     OR v_payment.payer_pi_uid IS DISTINCT FROM v_intent.pi_uid
     OR v_payment.project_id IS DISTINCT FROM v_intent.project_id
     OR v_payment.project_code IS DISTINCT FROM v_intent.project_code
     OR round(v_payment.amount, 7) IS DISTINCT FROM round(v_intent.amount, 7) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'VERIFIED_PAYMENT_DOES_NOT_MATCH_STAKE_INTENT';
  END IF;

  SELECT * INTO v_existing
  FROM public.stakes
  WHERE payment_id = v_payment.payment_id AND network = 'testnet';
  IF FOUND THEN
    IF v_existing.pi_uid IS DISTINCT FROM v_intent.pi_uid
       OR v_existing.project_id IS DISTINCT FROM v_intent.project_id
       OR v_existing.duration_days IS DISTINCT FROM v_intent.duration_days THEN
      RAISE EXCEPTION USING errcode = '23505', message = 'STAKE_PAYMENT_IDEMPOTENCY_MISMATCH';
    END IF;
    UPDATE public.testnet_stake_intents
    SET status = 'created', stake_id = v_existing.id, updated_at = now()
    WHERE id = v_intent.id AND network = 'testnet';
    RETURN v_existing;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('albukhr:testnet:staking:' || v_intent.project_id::text, 0)
  );

  SELECT u.id INTO v_user_id
  FROM public.users u
  WHERE u.pi_uid = v_intent.pi_uid AND u.network = 'testnet'
  LIMIT 1;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'TESTNET_USER_NOT_FOUND';
  END IF;

  INSERT INTO public.stakes (
    project_id, project_code, user_id, pi_uid, network, amount,
    duration_days, reward_rate, reward_amount, status,
    payment_record_id, payment_id, start_at, unlock_at, created_at, updated_at
  )
  VALUES (
    v_intent.project_id, v_intent.project_code, v_user_id, v_intent.pi_uid, 'testnet',
    v_intent.amount, v_intent.duration_days, v_intent.reward_rate, v_intent.reward_amount, 'active',
    v_payment.id, v_payment.payment_id, now(),
    now() + make_interval(days => v_intent.duration_days), now(), now()
  )
  RETURNING * INTO v_stake;

  INSERT INTO public.project_staking_ledger (
    network, project_id, stake_id, stake_payment_id, bucket, movement, event_type,
    amount, source_type, source_id, idempotency_key, metadata
  )
  VALUES (
    'testnet', v_intent.project_id, v_stake.id, v_payment.id, 'capital_reserve',
    'credit', 'stake_principal_received', v_intent.amount,
    'stake_payment', v_payment.payment_id, 'stake:' || v_payment.payment_id || ':principal',
    jsonb_build_object('intent_id', v_intent.id, 'duration_days', v_intent.duration_days,
      'reward_rate', v_intent.reward_rate)
  );

  v_deploy_amount := round(
    v_intent.amount * least(v_intent.maximum_deployment_percent, 100-v_intent.capital_reserve_percent) / 100,
    7
  );
  IF v_deploy_amount > 0 THEN
    INSERT INTO public.project_staking_ledger (
      network, project_id, stake_id, stake_payment_id, bucket, movement, event_type,
      amount, source_type, source_id, idempotency_key, metadata
    )
    VALUES
    (
      'testnet', v_intent.project_id, v_stake.id, v_payment.id, 'capital_reserve',
      'debit', 'capital_released_to_project', v_deploy_amount,
      'stake_payment', v_payment.payment_id, 'stake:' || v_payment.payment_id || ':reserve-debit',
      jsonb_build_object('deployment_percent', v_intent.maximum_deployment_percent)
    ),
    (
      'testnet', v_intent.project_id, v_stake.id, v_payment.id, 'project_operating',
      'credit', 'capital_released_to_project', v_deploy_amount,
      'stake_payment', v_payment.payment_id, 'stake:' || v_payment.payment_id || ':operating-credit',
      jsonb_build_object('deployment_percent', v_intent.maximum_deployment_percent)
    );
  END IF;

  -- The reward was reserved when the intent was created. Attach those ledger
  -- rows to the finalized stake instead of reserving the same reward twice.
  UPDATE public.project_staking_ledger
  SET stake_id = v_stake.id, stake_payment_id = v_payment.id
  WHERE network = 'testnet'
    AND project_id = v_intent.project_id
    AND source_type = 'stake_intent_reward'
    AND source_id = v_intent.id::text
    AND idempotency_key IN (
      'intent:' || v_intent.id::text || ':reward-source',
      'intent:' || v_intent.id::text || ':reward-reserve'
    );

  UPDATE public.testnet_stake_intents
  SET status = 'created', stake_id = v_stake.id, updated_at = now()
  WHERE id = v_intent.id AND network = 'testnet';

  SELECT * INTO v_coverage
  FROM public.get_testnet_staking_coverage(v_intent.project_id);

  IF coalesce(v_coverage.total_tracked_assets, 0) < coalesce(v_coverage.total_liability, 0)
     OR coalesce(v_coverage.reward_reserve_balance, 0) < coalesce(v_coverage.outstanding_rewards, 0) THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'POST_STAKE_COVERAGE_CHECK_FAILED';
  END IF;

  RETURN v_stake;
END;
$function$;

-- Keep the older function name safe: direct stake creation now requires a bound,
-- pre-funded intent, so a backend cannot accidentally bypass reward reservation.
CREATE OR REPLACE FUNCTION public.create_testnet_stake_from_verified_payment(
  p_payment_id text, p_pi_uid text, p_duration_days integer
)
RETURNS public.stakes
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_intent public.testnet_stake_intents%rowtype;
BEGIN
  SELECT * INTO v_intent
  FROM public.testnet_stake_intents
  WHERE payment_id = nullif(trim(p_payment_id), '')
    AND pi_uid = nullif(trim(p_pi_uid), '')
    AND duration_days = p_duration_days
    AND network = 'testnet'
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'STAKE_INTENT_REQUIRED';
  END IF;

  RETURN public.finalize_testnet_stake_intent(v_intent.id, p_pi_uid, p_payment_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_testnet_staking_coverage(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_testnet_staking_coverage(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.create_testnet_stake_intent(uuid,text,text,numeric,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_testnet_stake_intent(uuid,text,text,numeric,integer) TO service_role;

REVOKE ALL ON FUNCTION public.bind_testnet_stake_intent_payment(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_testnet_stake_intent_payment(uuid,text,text) TO service_role;

REVOKE ALL ON FUNCTION public.cancel_testnet_stake_intent(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_testnet_stake_intent(uuid,text,text) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_testnet_stake_intent(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_testnet_stake_intent(uuid,text,text) TO service_role;

REVOKE ALL ON FUNCTION public.create_testnet_stake_from_verified_payment(text,text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_testnet_stake_from_verified_payment(text,text,integer) TO service_role;
