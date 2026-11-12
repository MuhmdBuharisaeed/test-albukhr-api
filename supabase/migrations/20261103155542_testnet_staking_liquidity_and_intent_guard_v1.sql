-- Testnet-only staking safety corrections. No global policy flag is activated.
CREATE OR REPLACE FUNCTION public.get_testnet_staking_coverage(p_project_id uuid)
 RETURNS TABLE(project_id uuid, network text, verified_liquidity_contributed numeric, owner_liquidity_available numeric, capital_reserve_balance numeric, project_operating_balance numeric, reward_reserve_balance numeric, total_tracked_assets numeric, outstanding_principal numeric, outstanding_rewards numeric, total_liability numeric, surplus numeric, coverage_ratio numeric, liquidity_buffer numeric, staking_eligible boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_project_network text;
BEGIN
  SELECT p.network INTO v_project_network
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
      coalesce(sum(greatest(s.amount - coalesce(c.completed_deduction, 0), 0)), 0)::numeric AS stake_principal,
      coalesce(sum(greatest(s.reward_amount - coalesce(r.completed_deduction, 0), 0)), 0)::numeric AS stake_rewards
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
    SELECT coalesce(sum(i.amount), 0)::numeric AS pending_principal,
           coalesce(sum(i.reward_amount), 0)::numeric AS pending_rewards
    FROM public.testnet_stake_intents i
    WHERE i.project_id = p_project_id AND i.network = 'testnet'
      AND i.status = 'pending_payment'
  ),
  policy AS (
    SELECT
      g.staking_policy_active,
      g.minimum_project_liquidity,
      g.staking_reward_rates_by_duration,
      g.staking_stage_policies,
      g.staking_minimum_stake_amount,
      g.staking_reward_reserve_coverage_percent,
      p.staking_stage,
      t.status AS treasury_status,
      t.treasury_wallet,
      t.verified_liquidity AS treasury_verified_liquidity,
      t.required_liquidity AS treasury_required_liquidity
    FROM public.projects p
    JOIN public.testnet_global_treasury_policy g
      ON g.singleton_id = 1 AND g.network = 'testnet'
    LEFT JOIN public.project_treasury t
      ON t.project_id = p.id AND t.network = 'testnet'
    WHERE p.id = p_project_id AND p.network = 'testnet'
  ),
  combined AS (
    SELECT
      b.*,
      (sl.stake_principal + pi.pending_principal)::numeric AS outstanding_principal,
      (sl.stake_rewards + pi.pending_rewards)::numeric AS outstanding_rewards,
      (b.owner_liquidity_available + b.capital_reserve_balance
        + b.project_operating_balance + b.reward_reserve_balance)::numeric AS total_tracked_assets,
      (b.owner_liquidity_available + b.reward_reserve_balance)::numeric AS liquidity_buffer,
      pol.staking_policy_active,
      pol.minimum_project_liquidity,
      pol.staking_reward_rates_by_duration,
      pol.staking_stage_policies,
      pol.staking_reward_reserve_coverage_percent,
      pol.staking_stage,
      pol.treasury_status,
      pol.treasury_wallet,
      pol.treasury_verified_liquidity,
      pol.treasury_required_liquidity
    FROM ledger_balances b
    CROSS JOIN stake_liabilities sl
    CROSS JOIN pending_intents pi
    LEFT JOIN policy pol ON true
  ),
  stage_policy AS (
    SELECT c.*, c.staking_stage_policies -> c.staking_stage AS stage_rule
    FROM combined c
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
    CASE WHEN c.outstanding_principal + c.outstanding_rewards = 0 THEN NULL
      ELSE round(c.total_tracked_assets / (c.outstanding_principal + c.outstanding_rewards), 7) END,
    c.liquidity_buffer,
    coalesce(c.staking_policy_active, false)
      AND c.staking_stage IS NOT NULL
      AND c.stage_rule IS NOT NULL
      AND jsonb_typeof(c.staking_reward_rates_by_duration) = 'object'
      AND (SELECT count(*) FROM jsonb_object_keys(c.staking_reward_rates_by_duration)) > 0
      AND jsonb_typeof(c.stage_rule) = 'object'
      AND c.stage_rule ? 'capital_reserve_percent'
      AND c.stage_rule ? 'maximum_deployment_percent'
      AND c.stage_rule ? 'max_active_principal'
      AND c.treasury_status = 'active'
      AND nullif(trim(coalesce(c.treasury_wallet, '')), '') IS NOT NULL
      AND c.treasury_required_liquidity >= c.minimum_project_liquidity
      AND c.treasury_verified_liquidity >= c.treasury_required_liquidity
      AND c.verified_liquidity_contributed >= c.treasury_required_liquidity
      AND c.liquidity_buffer >= c.minimum_project_liquidity
      AND c.total_tracked_assets >= c.outstanding_principal + c.outstanding_rewards
      AND c.reward_reserve_balance >= c.outstanding_rewards
         * coalesce(c.staking_reward_reserve_coverage_percent, 100) / 100
  FROM stage_policy c;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.create_testnet_stake_intent(p_project_id uuid, p_project_code text, p_pi_uid text, p_amount numeric, p_duration_days integer)
 RETURNS testnet_stake_intents
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_project public.projects%ROWTYPE;
  v_treasury public.project_treasury%ROWTYPE;
  v_policy public.testnet_global_treasury_policy%ROWTYPE;
  v_stage_policy jsonb;
  v_coverage record;
  v_intent public.testnet_stake_intents%ROWTYPE;
  v_term public.project_staking_terms%ROWTYPE;
  v_reward_cap numeric;
  v_amount numeric := round(coalesce(p_amount, 0)::numeric, 7);
  v_uid text := nullif(trim(p_pi_uid), '');
  v_reward_rate numeric;
  v_min_stake numeric;
  v_reward numeric;
  v_capital_reserve_percent numeric;
  v_maximum_deployment_percent numeric;
  v_max_active_principal numeric;
  v_deployment_percent numeric;
  v_controls public.project_staking_risk_controls%ROWTYPE;
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

  IF EXISTS (
    SELECT 1 FROM public.testnet_stake_intents
    WHERE project_id = p_project_id AND network = 'testnet'
      AND pi_uid = v_uid AND status = 'pending_payment'
  ) THEN
    RAISE EXCEPTION USING errcode = '23505', message = 'STAKE_INTENT_ALREADY_PENDING';
  END IF;

  SELECT * INTO v_project
  FROM public.projects
  WHERE id = p_project_id AND project_code = trim(p_project_code)
    AND network = 'testnet' AND status = 'approved'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PROJECT_NOT_APPROVED_FOR_TESTNET_STAKING';
  END IF;

  SELECT * INTO v_controls
  FROM public.project_staking_risk_controls
  WHERE project_id = p_project_id AND network = 'testnet'
  FOR SHARE;
  IF NOT FOUND
     OR v_controls.staking_enabled IS DISTINCT FROM true
     OR v_controls.approval_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'STAKING_NOT_ENABLED_OR_NOT_APPROVED';
  END IF;
  IF v_controls.minimum_liquidity IS NULL
     OR v_controls.capital_reserve_percent IS NULL
     OR v_controls.maximum_deployment_percent IS NULL
     OR v_controls.max_reward_rate IS NULL
     OR v_controls.max_active_principal IS NULL
     OR v_controls.reward_reserve_coverage_percent IS NULL THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'PROJECT_STAKING_RISK_LIMITS_NOT_CONFIGURED';
  END IF;

  SELECT * INTO v_policy
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1 AND network = 'testnet'
  FOR SHARE;
  IF NOT FOUND OR v_policy.staking_policy_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_STAKING_POLICY_INACTIVE';
  END IF;

  IF NOT (p_duration_days = ANY(v_policy.allowed_duration_days)) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKING_DURATION_NOT_ALLOWED';
  END IF;

  SELECT * INTO v_term
  FROM public.project_staking_terms
  WHERE project_code = v_project.project_code AND network = 'testnet'
    AND duration_days = p_duration_days AND active IS TRUE
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'STAKING_OFFER_NOT_CONFIGURED';
  END IF;

  IF jsonb_typeof(v_policy.staking_reward_rates_by_duration) <> 'object'
     OR nullif(v_policy.staking_reward_rates_by_duration ->> p_duration_days::text, '') IS NULL THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'STAKING_REWARD_LIMIT_NOT_CONFIGURED';
  END IF;

  v_reward_cap := (v_policy.staking_reward_rates_by_duration ->> p_duration_days::text)::numeric;
  v_reward_cap := least(v_reward_cap, v_controls.max_reward_rate);
  v_reward_rate := v_term.reward_rate;
  IF v_reward_cap <= 0 OR v_reward_cap > 1 OR v_reward_rate <= 0 OR v_reward_rate > v_reward_cap THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKING_REWARD_RATE_EXCEEDS_ALBUKHR_LIMIT';
  END IF;

  IF v_project.staking_stage IS NULL THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'PROJECT_STAKING_STAGE_NOT_CONFIGURED';
  END IF;

  v_stage_policy := v_policy.staking_stage_policies -> v_project.staking_stage;
  IF jsonb_typeof(v_stage_policy) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_STAKING_STAGE_POLICY_NOT_CONFIGURED';
  END IF;

  v_capital_reserve_percent := greatest(
    (v_stage_policy ->> 'capital_reserve_percent')::numeric,
    v_controls.capital_reserve_percent
  );
  v_maximum_deployment_percent := least(
    (v_stage_policy ->> 'maximum_deployment_percent')::numeric,
    v_controls.maximum_deployment_percent
  );
  v_max_active_principal := least(
    (v_stage_policy ->> 'max_active_principal')::numeric,
    v_controls.max_active_principal
  );
  IF v_capital_reserve_percent < 0 OR v_capital_reserve_percent > 100
     OR v_maximum_deployment_percent < 0 OR v_maximum_deployment_percent > 100
     OR v_capital_reserve_percent + v_maximum_deployment_percent > 100
     OR v_max_active_principal <= 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'GLOBAL_STAKING_STAGE_POLICY_INVALID';
  END IF;

  v_min_stake := v_policy.staking_minimum_stake_amount;
  IF v_amount < v_min_stake THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_AMOUNT_BELOW_GLOBAL_MINIMUM';
  END IF;

  SELECT * INTO v_treasury
  FROM public.project_treasury
  WHERE project_id = p_project_id AND network = 'testnet'
  FOR SHARE;

  IF NOT FOUND
     OR v_treasury.status <> 'active'
     OR nullif(trim(coalesce(v_treasury.treasury_wallet, '')), '') IS NULL
     OR v_treasury.required_liquidity < greatest(v_policy.minimum_project_liquidity, v_controls.minimum_liquidity)
     OR v_treasury.verified_liquidity < greatest(v_policy.minimum_project_liquidity, v_controls.minimum_liquidity, v_treasury.required_liquidity) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PROJECT_LIQUIDITY_REQUIREMENT_NOT_MET';
  END IF;

  v_reward := round(v_amount * v_reward_rate, 7);
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
  IF coalesce(v_coverage.outstanding_principal, 0) + v_amount > v_max_active_principal THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'PROJECT_ACTIVE_STAKING_CAP_REACHED';
  END IF;
  IF coalesce(v_coverage.total_tracked_assets, 0) <
       coalesce(v_coverage.total_liability, 0) + v_reward THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'STAKING_COVERAGE_INSUFFICIENT';
  END IF;

  v_deployment_percent := least(
    v_maximum_deployment_percent,
    100 - v_capital_reserve_percent
  );

  INSERT INTO public.testnet_stake_intents (
    project_id, project_code, pi_uid, network, amount, duration_days,
    reward_rate, reward_amount, capital_reserve_percent,
    maximum_deployment_percent, status, expires_at, metadata
  )
  VALUES (
    v_project.id, v_project.project_code, v_uid, 'testnet', v_amount, p_duration_days,
    v_reward_rate, v_reward, v_capital_reserve_percent,
    v_deployment_percent, 'pending_payment', now() + interval '20 minutes',
    jsonb_build_object(
      'origin', 'testnet_staking',
      'policy_version', v_policy.staking_policy_version,
      'reward_withdrawal', 'immediate',
      'capital_unlock_days', p_duration_days,
      'policy_source', 'testnet_global_treasury_policy'
    )
  )
  RETURNING * INTO v_intent;

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
    jsonb_build_object('pi_uid', v_uid, 'payment_intent', v_intent.id, 'network', 'testnet',
      'policy_version', v_policy.staking_policy_version)
  );

  RETURN v_intent;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.finalize_testnet_stake_intent(p_intent_id uuid, p_pi_uid text, p_payment_id text)
 RETURNS stakes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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

  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = v_intent.project_id AND p.project_code = v_intent.project_code
      AND p.network = 'testnet' AND p.status = 'approved'
  ) THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'PROJECT_NOT_APPROVED_FOR_TESTNET_STAKING';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.testnet_global_treasury_policy g
    WHERE g.singleton_id = 1 AND g.network = 'testnet'
      AND g.staking_policy_active IS TRUE
  ) THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_STAKING_POLICY_INACTIVE';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.project_staking_risk_controls r
    WHERE r.project_id = v_intent.project_id AND r.network = 'testnet'
      AND r.staking_enabled IS TRUE AND r.approval_status = 'approved'
  ) THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'STAKING_NOT_ENABLED_OR_NOT_APPROVED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.project_treasury t
    JOIN public.testnet_global_treasury_policy g ON g.singleton_id = 1 AND g.network = 'testnet'
    WHERE t.project_id = v_intent.project_id AND t.network = 'testnet'
      AND t.status = 'active'
      AND t.required_liquidity >= g.minimum_project_liquidity
      AND t.verified_liquidity >= t.required_liquidity
  ) THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'PROJECT_LIQUIDITY_REQUIREMENT_NOT_MET';
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

  IF coalesce(v_coverage.staking_eligible, false) IS NOT TRUE
     OR coalesce(v_coverage.total_tracked_assets, 0) < coalesce(v_coverage.total_liability, 0)
     OR coalesce(v_coverage.reward_reserve_balance, 0) < coalesce(v_coverage.outstanding_rewards, 0) THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'POST_STAKE_COVERAGE_CHECK_FAILED';
  END IF;

  RETURN v_stake;
END;
$function$
;
