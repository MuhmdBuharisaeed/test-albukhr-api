
CREATE OR REPLACE FUNCTION public.validate_testnet_global_staking_policy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_key text;
  v_value jsonb;
  v_rate numeric;
  v_duration integer;
  v_stage text;
  v_stage_value jsonb;
  v_reserve numeric;
  v_deploy numeric;
  v_max_principal numeric;
BEGIN
  IF NEW.network <> 'testnet' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'TESTNET_GLOBAL_POLICY_NETWORK_INVALID';
  END IF;

  IF NEW.staking_policy_active IS DISTINCT FROM true THEN
    RETURN NEW;
  END IF;

  IF nullif(trim(NEW.treasury_wallet), '') IS NULL
     OR NEW.minimum_project_liquidity < 100
     OR NEW.staking_minimum_stake_amount <= 0
     OR jsonb_typeof(NEW.staking_reward_rates_by_duration) <> 'object'
     OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(NEW.staking_reward_rates_by_duration))
     OR jsonb_typeof(NEW.staking_stage_policies) <> 'object'
     OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(NEW.staking_stage_policies))
     OR NEW.staking_reward_reserve_coverage_percent < 100 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'GLOBAL_STAKING_POLICY_CONFIGURATION_INCOMPLETE';
  END IF;

  FOR v_key, v_value IN
    SELECT key, value FROM jsonb_each(NEW.staking_reward_rates_by_duration)
  LOOP
    IF v_key !~ '^[0-9]+$' THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'GLOBAL_STAKING_DURATION_INVALID';
    END IF;
    v_duration := v_key::integer;
    IF NOT (v_duration = ANY(NEW.allowed_duration_days)) THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'GLOBAL_STAKING_DURATION_NOT_ALLOWED';
    END IF;
    IF jsonb_typeof(v_value) <> 'number' THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'GLOBAL_STAKING_REWARD_RATE_INVALID';
    END IF;
    v_rate := (v_value #>> '{}')::numeric;
    IF v_rate <= 0 OR v_rate > 1 THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'GLOBAL_STAKING_REWARD_RATE_INVALID';
    END IF;
  END LOOP;

  FOR v_stage, v_stage_value IN
    SELECT key, value FROM jsonb_each(NEW.staking_stage_policies)
  LOOP
    IF v_stage NOT IN ('setup_pre_operation', 'construction_fit_out', 'operating_expansion')
       OR jsonb_typeof(v_stage_value) <> 'object'
       OR jsonb_typeof(v_stage_value->'capital_reserve_percent') <> 'number'
       OR jsonb_typeof(v_stage_value->'maximum_deployment_percent') <> 'number'
       OR jsonb_typeof(v_stage_value->'max_active_principal') <> 'number' THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'GLOBAL_STAKING_STAGE_POLICY_INVALID';
    END IF;

    v_reserve := (v_stage_value->>'capital_reserve_percent')::numeric;
    v_deploy := (v_stage_value->>'maximum_deployment_percent')::numeric;
    v_max_principal := (v_stage_value->>'max_active_principal')::numeric;

    IF v_reserve < 0 OR v_reserve > 100
       OR v_deploy < 0 OR v_deploy > 100
       OR v_reserve + v_deploy > 100
       OR v_max_principal <= 0 THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'GLOBAL_STAKING_STAGE_POLICY_INVALID';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_testnet_staking_coverage(p_project_id uuid)
RETURNS TABLE(
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
      t.verified_liquidity AS treasury_verified_liquidity
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
      pol.treasury_verified_liquidity
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
      AND c.treasury_verified_liquidity >= c.minimum_project_liquidity
      AND c.verified_liquidity_contributed >= c.minimum_project_liquidity
      AND c.liquidity_buffer >= c.minimum_project_liquidity
      AND c.total_tracked_assets >= c.outstanding_principal + c.outstanding_rewards
      AND c.reward_reserve_balance >= c.outstanding_rewards
         * coalesce(c.staking_reward_reserve_coverage_percent, 100) / 100
  FROM stage_policy c;
END;
$function$;
