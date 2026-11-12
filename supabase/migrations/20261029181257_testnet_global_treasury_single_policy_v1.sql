
ALTER TABLE public.testnet_global_treasury_policy
  ADD COLUMN IF NOT EXISTS treasury_wallet text,
  ADD COLUMN IF NOT EXISTS staking_policy_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS staking_policy_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS staking_minimum_stake_amount numeric NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS staking_reward_rates_by_duration jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS staking_stage_policies jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS staking_reward_reserve_coverage_percent numeric NOT NULL DEFAULT 100;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS staking_stage text;

DO $block$
DECLARE
  v_wallet_count bigint;
  v_wallet text;
BEGIN
  SELECT count(DISTINCT nullif(trim(treasury_wallet), '')),
         min(nullif(trim(treasury_wallet), ''))
    INTO v_wallet_count, v_wallet
  FROM public.project_treasury
  WHERE network = 'testnet';

  IF v_wallet_count <> 1 OR v_wallet IS NULL THEN
    RAISE EXCEPTION 'TESTNET_GLOBAL_TREASURY_WALLET_NOT_UNAMBIGUOUS';
  END IF;

  UPDATE public.testnet_global_treasury_policy
  SET treasury_wallet = v_wallet
  WHERE singleton_id = 1 AND network = 'testnet';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TESTNET_GLOBAL_TREASURY_POLICY_ROW_MISSING';
  END IF;
END;
$block$;

ALTER TABLE public.testnet_global_treasury_policy
  ALTER COLUMN treasury_wallet SET NOT NULL;

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.testnet_global_treasury_policy'::regclass
      AND conname = 'testnet_global_treasury_policy_staking_minimum_check'
  ) THEN
    ALTER TABLE public.testnet_global_treasury_policy
      ADD CONSTRAINT testnet_global_treasury_policy_staking_minimum_check
      CHECK (staking_minimum_stake_amount > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.testnet_global_treasury_policy'::regclass
      AND conname = 'testnet_global_treasury_policy_reward_rates_object_check'
  ) THEN
    ALTER TABLE public.testnet_global_treasury_policy
      ADD CONSTRAINT testnet_global_treasury_policy_reward_rates_object_check
      CHECK (jsonb_typeof(staking_reward_rates_by_duration) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.testnet_global_treasury_policy'::regclass
      AND conname = 'testnet_global_treasury_policy_stage_policies_object_check'
  ) THEN
    ALTER TABLE public.testnet_global_treasury_policy
      ADD CONSTRAINT testnet_global_treasury_policy_stage_policies_object_check
      CHECK (jsonb_typeof(staking_stage_policies) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.testnet_global_treasury_policy'::regclass
      AND conname = 'testnet_global_treasury_policy_reserve_coverage_check'
  ) THEN
    ALTER TABLE public.testnet_global_treasury_policy
      ADD CONSTRAINT testnet_global_treasury_policy_reserve_coverage_check
      CHECK (staking_reward_reserve_coverage_percent >= 100 AND staking_reward_reserve_coverage_percent <= 1000);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.projects'::regclass
      AND conname = 'projects_staking_stage_check'
  ) THEN
    ALTER TABLE public.projects
      ADD CONSTRAINT projects_staking_stage_check
      CHECK (staking_stage IS NULL OR staking_stage IN (
        'setup_pre_operation', 'construction_fit_out', 'operating_expansion'
      ));
  END IF;
END;
$block$;

CREATE UNIQUE INDEX IF NOT EXISTS project_treasury_project_network_uidx
  ON public.project_treasury(project_id, network);

-- Normalize existing Testnet Treasury records from the authoritative global floor
-- and verified payment records. This never credits unverified incoming payments.
UPDATE public.project_treasury t
SET treasury_wallet = g.treasury_wallet,
    required_liquidity = GREATEST(g.minimum_project_liquidity, COALESCE(t.required_liquidity, 0)),
    verified_liquidity = COALESCE((
      SELECT SUM(lp.amount)
      FROM public.project_liquidity_payments lp
      WHERE lp.project_id = t.project_id
        AND lp.network = 'testnet'
        AND lp.verification_status = 'verified'
    ), 0),
    updated_at = now()
FROM public.testnet_global_treasury_policy g
WHERE t.network = 'testnet'
  AND g.singleton_id = 1
  AND g.network = 'testnet';

-- Provision a uniform Treasury shell for all current Testnet projects missing one.
-- It starts with zero verified liquidity; the global floor is not treated as paid.
INSERT INTO public.project_treasury (
  project_id, network, treasury_wallet, required_liquidity, verified_liquidity, status
)
SELECT p.id, 'testnet', g.treasury_wallet, g.minimum_project_liquidity, 0, 'active'
FROM public.projects p
JOIN public.testnet_global_treasury_policy g
  ON g.singleton_id = 1 AND g.network = 'testnet'
WHERE p.network = 'testnet'
  AND NOT EXISTS (
    SELECT 1 FROM public.project_treasury t
    WHERE t.project_id = p.id AND t.network = 'testnet'
  );

-- Historical project-level terms are retained but cannot become active offers.
-- No Testnet stakes or intents existed at migration time, so no accepted contract is rewritten.
UPDATE public.project_staking_terms
SET active = false, updated_at = now()
WHERE network = 'testnet' AND active = true;

CREATE OR REPLACE FUNCTION public.guard_testnet_project_local_staking_policy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.network = 'testnet' THEN
      RAISE EXCEPTION USING errcode = '42501', message = 'GLOBAL_TESTNET_POLICY_AUTHORITATIVE';
    END IF;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.network = 'testnet' OR NEW.network = 'testnet' THEN
      RAISE EXCEPTION USING errcode = '42501', message = 'GLOBAL_TESTNET_POLICY_AUTHORITATIVE';
    END IF;
    RETURN NEW;
  ELSE
    IF NEW.network = 'testnet' THEN
      RAISE EXCEPTION USING errcode = '42501', message = 'GLOBAL_TESTNET_POLICY_AUTHORITATIVE';
    END IF;
    RETURN NEW;
  END IF;
END;
$function$;

DROP TRIGGER IF EXISTS testnet_project_staking_terms_global_policy_guard
  ON public.project_staking_terms;
CREATE TRIGGER testnet_project_staking_terms_global_policy_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.project_staking_terms
FOR EACH ROW EXECUTE FUNCTION public.guard_testnet_project_local_staking_policy();

DROP TRIGGER IF EXISTS testnet_project_staking_risk_controls_global_policy_guard
  ON public.project_staking_risk_controls;
CREATE TRIGGER testnet_project_staking_risk_controls_global_policy_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.project_staking_risk_controls
FOR EACH ROW EXECUTE FUNCTION public.guard_testnet_project_local_staking_policy();

CREATE OR REPLACE FUNCTION public.enforce_testnet_global_treasury_values()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_wallet text;
  v_minimum numeric;
BEGIN
  IF NEW.network <> 'testnet' THEN
    RETURN NEW;
  END IF;

  SELECT treasury_wallet, minimum_project_liquidity
    INTO v_wallet, v_minimum
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1 AND network = 'testnet';

  IF NOT FOUND OR nullif(trim(v_wallet), '') IS NULL THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'TESTNET_GLOBAL_TREASURY_CONFIGURATION_INCOMPLETE';
  END IF;

  NEW.treasury_wallet := v_wallet;
  NEW.required_liquidity := GREATEST(COALESCE(NEW.required_liquidity, 0), v_minimum);
  NEW.verified_liquidity := GREATEST(COALESCE(NEW.verified_liquidity, 0), 0);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS project_treasury_global_testnet_guard
  ON public.project_treasury;
CREATE TRIGGER project_treasury_global_testnet_guard
BEFORE INSERT OR UPDATE ON public.project_treasury
FOR EACH ROW EXECUTE FUNCTION public.enforce_testnet_global_treasury_values();

CREATE OR REPLACE FUNCTION public.bootstrap_testnet_project_treasury()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_wallet text;
  v_minimum numeric;
BEGIN
  IF NEW.network <> 'testnet' THEN
    RETURN NEW;
  END IF;

  SELECT treasury_wallet, minimum_project_liquidity
    INTO v_wallet, v_minimum
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1 AND network = 'testnet';

  IF NOT FOUND OR nullif(trim(v_wallet), '') IS NULL THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'TESTNET_GLOBAL_TREASURY_CONFIGURATION_INCOMPLETE';
  END IF;

  INSERT INTO public.project_treasury (
    project_id, network, treasury_wallet, required_liquidity,
    verified_liquidity, status
  )
  VALUES (NEW.id, 'testnet', v_wallet, v_minimum, 0, 'active')
  ON CONFLICT (project_id, network) DO NOTHING;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS projects_bootstrap_testnet_global_treasury
  ON public.projects;
CREATE TRIGGER projects_bootstrap_testnet_global_treasury
AFTER INSERT ON public.projects
FOR EACH ROW EXECUTE FUNCTION public.bootstrap_testnet_project_treasury();

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
     OR jsonb_object_length(NEW.staking_reward_rates_by_duration) = 0
     OR jsonb_typeof(NEW.staking_stage_policies) <> 'object'
     OR jsonb_object_length(NEW.staking_stage_policies) = 0
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

DROP TRIGGER IF EXISTS testnet_global_staking_policy_validation
  ON public.testnet_global_treasury_policy;
CREATE TRIGGER testnet_global_staking_policy_validation
BEFORE INSERT OR UPDATE ON public.testnet_global_treasury_policy
FOR EACH ROW EXECUTE FUNCTION public.validate_testnet_global_staking_policy();

-- Return coverage using the singleton global policy. Legacy project risk-control
-- rows are no longer consulted.
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
    SELECT c.*,
      c.staking_stage_policies -> c.staking_stage AS stage_rule
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
      AND jsonb_object_length(c.staking_reward_rates_by_duration) > 0
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

-- New stake intents must use the single global duration/rate schedule and
-- the centrally approved risk policy for the project's ALBUKHR-assigned stage.
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
SET search_path TO 'public'
AS $function$
DECLARE
  v_project public.projects%ROWTYPE;
  v_treasury public.project_treasury%ROWTYPE;
  v_policy public.testnet_global_treasury_policy%ROWTYPE;
  v_stage_policy jsonb;
  v_coverage record;
  v_intent public.testnet_stake_intents%ROWTYPE;
  v_amount numeric := round(coalesce(p_amount, 0)::numeric, 7);
  v_uid text := nullif(trim(p_pi_uid), '');
  v_reward_rate numeric;
  v_min_stake numeric;
  v_reward numeric;
  v_capital_reserve_percent numeric;
  v_maximum_deployment_percent numeric;
  v_max_active_principal numeric;
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

  IF jsonb_typeof(v_policy.staking_reward_rates_by_duration) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_STAKING_TERMS_NOT_CONFIGURED';
  END IF;

  IF nullif(v_policy.staking_reward_rates_by_duration ->> p_duration_days::text, '') IS NULL THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_STAKING_TERM_NOT_CONFIGURED';
  END IF;

  v_reward_rate := (v_policy.staking_reward_rates_by_duration ->> p_duration_days::text)::numeric;
  IF v_reward_rate <= 0 OR v_reward_rate > 1 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'GLOBAL_STAKING_REWARD_RATE_INVALID';
  END IF;

  IF v_project.staking_stage IS NULL THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'PROJECT_STAKING_STAGE_NOT_CONFIGURED';
  END IF;

  v_stage_policy := v_policy.staking_stage_policies -> v_project.staking_stage;
  IF jsonb_typeof(v_stage_policy) <> 'object' THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'GLOBAL_STAKING_STAGE_POLICY_NOT_CONFIGURED';
  END IF;

  v_capital_reserve_percent := (v_stage_policy ->> 'capital_reserve_percent')::numeric;
  v_maximum_deployment_percent := (v_stage_policy ->> 'maximum_deployment_percent')::numeric;
  v_max_active_principal := (v_stage_policy ->> 'max_active_principal')::numeric;
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
     OR v_treasury.verified_liquidity < v_policy.minimum_project_liquidity
     OR v_treasury.required_liquidity < v_policy.minimum_project_liquidity THEN
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
$function$;

-- Per-project owner proposal endpoint is intentionally retired for Testnet.
CREATE OR REPLACE FUNCTION public.update_testnet_project_staking_offer(
  p_project_id uuid,
  p_pi_uid text,
  p_duration_days integer,
  p_reward_rate numeric
)
RETURNS public.project_staking_terms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION USING errcode = '42501', message = 'GLOBAL_TESTNET_POLICY_AUTHORITATIVE';
END;
$function$;
