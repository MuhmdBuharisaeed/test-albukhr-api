-- ALBUKHR Testnet — Staking Governance Foundation (Migration A)
-- Scope: Testnet governance metadata only. Do not run against Mainnet.
-- This migration does NOT enable staking, alter treasury balances, rewrite stakes,
-- create a financial ledger, or change existing payment/finalization RPCs.
-- Create the timestamped file with:
--   supabase migration new testnet_staking_governance_foundation_v1
-- Then place this complete SQL in the generated file.

BEGIN;

-- Fail closed if the current Testnet identity and policy dependencies differ
-- from the audited schema. No schema changes occur before this preflight passes.
DO $preflight$
BEGIN
  IF to_regclass('public.projects') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regclass('public.testnet_sessions') IS NULL
     OR to_regclass('public.testnet_global_treasury_policy') IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_A_PRECHECK_REQUIRED_RELATION_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='projects'
      AND column_name='owner_user_id' AND data_type='uuid'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='projects'
      AND column_name='project_code'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='projects'
      AND column_name='network'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='projects'
      AND column_name='project_type'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users'
      AND column_name='pi_uid'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users'
      AND column_name='network'
  ) THEN
    RAISE EXCEPTION 'MIGRATION_A_PRECHECK_IDENTITY_SCHEMA_MISMATCH';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='testnet_sessions'
      AND column_name='pi_uid'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='testnet_sessions'
      AND column_name='expires_at'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='testnet_sessions'
      AND column_name='revoked_at'
  ) THEN
    RAISE EXCEPTION 'MIGRATION_A_PRECHECK_TESTNET_SESSION_SCHEMA_MISMATCH';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='testnet_global_treasury_policy'
      AND column_name='allowed_duration_days'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='testnet_global_treasury_policy'
      AND column_name='staking_reward_rates_by_duration'
  ) THEN
    RAISE EXCEPTION 'MIGRATION_A_PRECHECK_GLOBAL_STAKING_POLICY_SCHEMA_MISMATCH';
  END IF;
END;
$preflight$;

-- 1) Owner-selected governance configuration. The network constraint prevents
-- accidental reuse for Mainnet. Business classification is independent from
-- projects.project_type and projects.staking_stage.
CREATE TABLE public.project_staking_governance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  project_code text NOT NULL,
  network text NOT NULL DEFAULT 'testnet' CHECK (network = 'testnet'),
  owner_user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  owner_pi_uid text CHECK (owner_pi_uid IS NULL OR length(btrim(owner_pi_uid)) > 0),
  business_classification text
    CHECK (business_classification IS NULL OR business_classification IN ('startup', 'business_expansion', 'working_capital')),
  configuration_status text NOT NULL DEFAULT 'awaiting_owner_selection'
    CHECK (configuration_status IN ('awaiting_owner_link', 'awaiting_owner_selection', 'configured')),
  reward_arrangement text
    CHECK (reward_arrangement IS NULL OR reward_arrangement IN ('immediate_fixed', 'deferred_fixed')),
  selected_duration_days integer[] NOT NULL DEFAULT '{}'::integer[],
  reward_rate_choices jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_version text NOT NULL DEFAULT 'ALBUKHR_PROJECT_CLASSIFICATION_STAKING_REWARD_POLICY_v1.0',
  selection_revision integer NOT NULL DEFAULT 1 CHECK (selection_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_staking_governance_project_network_uniq UNIQUE (project_id, network),
  CONSTRAINT project_staking_governance_owner_pair_check
    CHECK ((owner_user_id IS NULL) = (owner_pi_uid IS NULL)),
  CONSTRAINT project_staking_governance_duration_count_check
    CHECK (cardinality(selected_duration_days) <= 3),
  CONSTRAINT project_staking_governance_duration_positive_check
    CHECK (array_position(selected_duration_days, NULL::integer) IS NULL),
  CONSTRAINT project_staking_governance_rates_object_check
    CHECK (jsonb_typeof(reward_rate_choices) = 'object')
);

CREATE INDEX project_staking_governance_owner_idx
  ON public.project_staking_governance (owner_user_id, network);
CREATE INDEX project_staking_governance_project_code_idx
  ON public.project_staking_governance (project_code, network);

-- 2) Immutable evidence that the verified project owner explicitly accepted
-- a particular policy version and exact configuration snapshot.
CREATE TABLE public.project_staking_policy_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acceptance_request_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  governance_id uuid NOT NULL
    REFERENCES public.project_staking_governance(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  project_code text NOT NULL,
  network text NOT NULL DEFAULT 'testnet' CHECK (network = 'testnet'),
  owner_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  owner_pi_uid text NOT NULL CHECK (length(btrim(owner_pi_uid)) > 0),
  owner_session_id uuid NOT NULL,
  policy_version text NOT NULL,
  policy_snapshot jsonb NOT NULL CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  acceptance_method text NOT NULL DEFAULT 'explicit_owner_button'
    CHECK (acceptance_method = 'explicit_owner_button'),
  accepted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_staking_policy_acceptances_project_time_idx
  ON public.project_staking_policy_acceptances (project_id, network, accepted_at DESC);
CREATE INDEX project_staking_policy_acceptances_owner_time_idx
  ON public.project_staking_policy_acceptances (owner_user_id, network, accepted_at DESC);

-- 3) Append-only record of each automated eligibility evaluation. It stores
-- decision evidence, not money movements and not a replacement financial ledger.
CREATE TABLE public.project_staking_engine_evaluation_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engine_run_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  governance_id uuid NOT NULL
    REFERENCES public.project_staking_governance(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  project_code text NOT NULL,
  network text NOT NULL DEFAULT 'testnet' CHECK (network = 'testnet'),
  policy_version text NOT NULL,
  engine_version text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('eligible', 'ineligible', 'blocked', 'error')),
  reason_codes text[] NOT NULL DEFAULT '{}'::text[],
  input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(input_snapshot) = 'object'),
  decision_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(decision_snapshot) = 'object'),
  trigger_source text NOT NULL
    CHECK (trigger_source IN ('owner_submission', 'owner_change', 'scheduled_recheck', 'manual_recheck', 'system_reconcile')),
  evaluated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_staking_engine_audit_project_time_idx
  ON public.project_staking_engine_evaluation_audit (project_id, network, evaluated_at DESC);
CREATE INDEX project_staking_engine_audit_outcome_time_idx
  ON public.project_staking_engine_evaluation_audit (network, outcome, evaluated_at DESC);

-- All three tables are protected even if the public schema is exposed through
-- a Data API configuration. Browser roles receive no table privileges.
ALTER TABLE public.project_staking_governance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_staking_policy_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_staking_engine_evaluation_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.project_staking_governance
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.project_staking_policy_acceptances
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.project_staking_engine_evaluation_audit
  FROM PUBLIC, anon, authenticated, service_role;

-- The API service-role is the only application writer. Acceptance and engine
-- evidence are append-only; neither receives UPDATE or DELETE privileges.
GRANT SELECT, INSERT, UPDATE ON TABLE public.project_staking_governance TO service_role;
GRANT SELECT, INSERT ON TABLE public.project_staking_policy_acceptances TO service_role;
GRANT SELECT, INSERT ON TABLE public.project_staking_engine_evaluation_audit TO service_role;

-- Database-side owner verification for governance writes. This checks the
-- Testnet project owner against public.users; it does not trust a browser-supplied
-- owner ID. It also prevents project/network/owner identity from being reassigned.
CREATE OR REPLACE FUNCTION public.guard_testnet_project_staking_governance_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_project public.projects%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_policy public.testnet_global_treasury_policy%ROWTYPE;
  v_key text;
  v_value jsonb;
  v_rate numeric;
  v_cap numeric;
  v_duration integer;
  v_distinct_count integer;
  v_total_count integer;
  v_rate_count integer;
  v_has_configuration boolean;
BEGIN
  IF NEW.network IS DISTINCT FROM 'testnet' THEN
    RAISE EXCEPTION USING errcode='22023', message='TESTNET_STAKING_GOVERNANCE_NETWORK_INVALID';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.project_code IS DISTINCT FROM OLD.project_code
    OR NEW.network IS DISTINCT FROM OLD.network
  ) THEN
    RAISE EXCEPTION USING errcode='42501', message='TESTNET_STAKING_GOVERNANCE_PROJECT_IDENTITY_IMMUTABLE';
  END IF;

  SELECT * INTO v_project
  FROM public.projects p
  WHERE p.id = NEW.project_id
    AND p.project_code = NEW.project_code
    AND p.network = 'testnet'
    AND p.status = 'approved'
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='42501', message='TESTNET_STAKING_GOVERNANCE_APPROVED_PROJECT_REQUIRED';
  END IF;

  v_has_configuration := NEW.business_classification IS NOT NULL
    OR NEW.reward_arrangement IS NOT NULL
    OR cardinality(NEW.selected_duration_days) > 0
    OR NEW.reward_rate_choices <> '{}'::jsonb;

  -- Six of the currently approved Core mirrors have no owner_user_id in the
  -- audited Testnet registry. Keep them visible as awaiting_owner_link; do not
  -- invent an owner, classification, reward choice, or acceptance.
  IF v_project.owner_user_id IS NULL THEN
    IF v_project.project_type IS DISTINCT FROM 'core'
       OR v_has_configuration THEN
      RAISE EXCEPTION USING errcode='42501', message='TESTNET_CORE_PROJECT_OWNER_LINK_REQUIRED';
    END IF;
    NEW.owner_user_id := NULL;
    NEW.owner_pi_uid := NULL;
    NEW.configuration_status := 'awaiting_owner_link';
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  -- Derive owner identity from the authoritative project/user records. Never
  -- trust owner_user_id or pi_uid supplied by the browser payload.
  SELECT * INTO v_user
  FROM public.users u
  WHERE u.id = v_project.owner_user_id
    AND u.network = 'testnet'
    AND nullif(btrim(u.pi_uid), '') IS NOT NULL
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='42501', message='TESTNET_STAKING_GOVERNANCE_OWNER_IDENTITY_INVALID';
  END IF;

  NEW.owner_user_id := v_project.owner_user_id;
  NEW.owner_pi_uid := v_user.pi_uid;

  IF cardinality(NEW.selected_duration_days) > 3
     OR array_position(NEW.selected_duration_days, NULL::integer) IS NOT NULL
     OR EXISTS (SELECT 1 FROM unnest(NEW.selected_duration_days) AS u(duration_value) WHERE duration_value <= 0) THEN
    RAISE EXCEPTION USING errcode='22023', message='TESTNET_STAKING_GOVERNANCE_DURATION_SELECTION_INVALID';
  END IF;

  SELECT count(*), count(DISTINCT duration_value)
    INTO v_total_count, v_distinct_count
  FROM unnest(NEW.selected_duration_days) AS u(duration_value);
  IF v_total_count <> v_distinct_count THEN
    RAISE EXCEPTION USING errcode='22023', message='TESTNET_STAKING_GOVERNANCE_DUPLICATE_DURATION';
  END IF;

  SELECT count(*) INTO v_rate_count
  FROM jsonb_object_keys(NEW.reward_rate_choices);

  IF NOT v_has_configuration THEN
    NEW.configuration_status := 'awaiting_owner_selection';
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF NEW.business_classification IS NULL
     OR NEW.reward_arrangement IS NULL
     OR cardinality(NEW.selected_duration_days) NOT BETWEEN 1 AND 3
     OR v_rate_count <> cardinality(NEW.selected_duration_days)
     OR v_rate_count > 3 THEN
    RAISE EXCEPTION USING errcode='22023', message='TESTNET_STAKING_GOVERNANCE_CONFIGURATION_INCOMPLETE';
  END IF;

  SELECT * INTO v_policy
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id=1 AND network='testnet'
  FOR KEY SHARE;

  IF NOT FOUND OR v_policy.allowed_duration_days IS NULL
     OR jsonb_typeof(v_policy.staking_reward_rates_by_duration) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING errcode='55000', message='TESTNET_STAKING_GOVERNANCE_GLOBAL_POLICY_MISSING';
  END IF;

  FOREACH v_duration IN ARRAY NEW.selected_duration_days LOOP
    IF NOT (v_duration = ANY(v_policy.allowed_duration_days)) THEN
      RAISE EXCEPTION USING errcode='22023', message='TESTNET_STAKING_GOVERNANCE_DURATION_NOT_ALLOWED';
    END IF;
  END LOOP;

  FOR v_key, v_value IN SELECT key, value FROM jsonb_each(NEW.reward_rate_choices)
  LOOP
    IF v_key !~ '^[0-9]+$' OR jsonb_typeof(v_value) <> 'number' THEN
      RAISE EXCEPTION USING errcode='22023', message='TESTNET_STAKING_GOVERNANCE_REWARD_RATE_INVALID';
    END IF;
    v_duration := v_key::integer;
    IF NOT (v_duration = ANY(NEW.selected_duration_days)) THEN
      RAISE EXCEPTION USING errcode='22023', message='TESTNET_STAKING_GOVERNANCE_REWARD_DURATION_MISMATCH';
    END IF;
    v_rate := (v_value #>> '{}')::numeric;
    v_cap := nullif(v_policy.staking_reward_rates_by_duration ->> v_key, '')::numeric;
    IF v_rate <= 0 OR v_cap IS NULL OR v_rate > v_cap THEN
      RAISE EXCEPTION USING errcode='22023', message='TESTNET_STAKING_GOVERNANCE_REWARD_RATE_ABOVE_GLOBAL_CAP';
    END IF;
  END LOOP;

  NEW.configuration_status := 'configured';
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS testnet_project_staking_governance_owner_guard
  ON public.project_staking_governance;
CREATE TRIGGER testnet_project_staking_governance_owner_guard
BEFORE INSERT OR UPDATE ON public.project_staking_governance
FOR EACH ROW EXECUTE FUNCTION public.guard_testnet_project_staking_governance_owner();

-- Seed governance placeholders for all approved Testnet mirrors. Existing owner
-- links become awaiting_owner_selection; ownerless Core mirrors become
-- awaiting_owner_link. No classification, reward, or staking permission is seeded.
INSERT INTO public.project_staking_governance (project_id, project_code, network)
SELECT p.id, p.project_code, 'testnet'
FROM public.projects p
WHERE p.network='testnet'
  AND p.status='approved'
ON CONFLICT (project_id, network) DO NOTHING;

-- Acceptance is immutable and must be created by the verified current owner
-- while the referenced Testnet session remains valid. Snapshot fields must
-- exactly match the stored governance selection at acceptance time.
CREATE OR REPLACE FUNCTION public.guard_testnet_staking_policy_acceptance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_governance public.project_staking_governance%ROWTYPE;
  v_project public.projects%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_session public.testnet_sessions%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING errcode='42501', message='TESTNET_STAKING_POLICY_ACCEPTANCE_IMMUTABLE';
  END IF;

  IF NEW.network IS DISTINCT FROM 'testnet' THEN
    RAISE EXCEPTION USING errcode='22023', message='TESTNET_STAKING_POLICY_ACCEPTANCE_NETWORK_INVALID';
  END IF;

  SELECT * INTO v_governance
  FROM public.project_staking_governance g
  WHERE g.id = NEW.governance_id
    AND g.project_id = NEW.project_id
    AND g.project_code = NEW.project_code
    AND g.network = 'testnet'
  FOR KEY SHARE;

  IF NOT FOUND OR v_governance.configuration_status IS DISTINCT FROM 'configured' THEN
    RAISE EXCEPTION USING errcode='42501', message='TESTNET_STAKING_POLICY_ACCEPTANCE_GOVERNANCE_NOT_CONFIGURED';
  END IF;

  SELECT * INTO v_project
  FROM public.projects p
  WHERE p.id=NEW.project_id AND p.project_code=NEW.project_code
    AND p.network='testnet' AND p.status='approved'
  FOR KEY SHARE;

  SELECT * INTO v_user
  FROM public.users u
  WHERE u.id=NEW.owner_user_id AND u.pi_uid=NEW.owner_pi_uid AND u.network='testnet'
  FOR KEY SHARE;

  IF NOT FOUND OR v_project.owner_user_id IS DISTINCT FROM NEW.owner_user_id
     OR v_governance.owner_user_id IS DISTINCT FROM NEW.owner_user_id
     OR v_governance.owner_pi_uid IS DISTINCT FROM NEW.owner_pi_uid THEN
    RAISE EXCEPTION USING errcode='42501', message='TESTNET_STAKING_POLICY_ACCEPTANCE_OWNER_MISMATCH';
  END IF;

  SELECT * INTO v_session
  FROM public.testnet_sessions s
  WHERE s.id=NEW.owner_session_id
    AND s.network='testnet'
    AND s.pi_uid=NEW.owner_pi_uid
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='42501', message='TESTNET_STAKING_POLICY_ACCEPTANCE_SESSION_INVALID';
  END IF;

  IF NEW.policy_version IS DISTINCT FROM v_governance.policy_version
     OR NEW.policy_snapshot ->> 'business_classification' IS DISTINCT FROM v_governance.business_classification
     OR NEW.policy_snapshot ->> 'reward_arrangement' IS DISTINCT FROM v_governance.reward_arrangement
     OR NEW.policy_snapshot -> 'selected_duration_days' IS DISTINCT FROM to_jsonb(v_governance.selected_duration_days)
     OR NEW.policy_snapshot -> 'reward_rate_choices' IS DISTINCT FROM v_governance.reward_rate_choices THEN
    RAISE EXCEPTION USING errcode='22023', message='TESTNET_STAKING_POLICY_ACCEPTANCE_SNAPSHOT_MISMATCH';
  END IF;

  -- Use database time; do not permit a client timestamp to backdate or
  -- forward-date the explicit acceptance evidence.
  NEW.accepted_at := now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS testnet_staking_policy_acceptance_guard
  ON public.project_staking_policy_acceptances;
CREATE TRIGGER testnet_staking_policy_acceptance_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.project_staking_policy_acceptances
FOR EACH ROW EXECUTE FUNCTION public.guard_testnet_staking_policy_acceptance();

-- Engine evaluation evidence is append-only. Correct a bad evaluation by
-- writing a new evaluation with a new engine_run_id, never by rewriting history.
CREATE OR REPLACE FUNCTION public.guard_testnet_staking_engine_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  RAISE EXCEPTION USING errcode='42501', message='TESTNET_STAKING_ENGINE_AUDIT_APPEND_ONLY';
END;
$function$;

DROP TRIGGER IF EXISTS testnet_staking_engine_audit_immutable
  ON public.project_staking_engine_evaluation_audit;
CREATE TRIGGER testnet_staking_engine_audit_immutable
BEFORE UPDATE OR DELETE ON public.project_staking_engine_evaluation_audit
FOR EACH ROW EXECUTE FUNCTION public.guard_testnet_staking_engine_audit_immutable();

-- The trigger functions are callable only by the trusted backend role; they
-- are not exposed as public RPC endpoints. Trigger invocation itself remains
-- controlled by the table triggers above.
REVOKE ALL ON FUNCTION public.guard_testnet_project_staking_governance_owner() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_testnet_staking_policy_acceptance() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_testnet_staking_engine_audit_immutable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_testnet_project_staking_governance_owner() TO service_role;
GRANT EXECUTE ON FUNCTION public.guard_testnet_staking_policy_acceptance() TO service_role;
GRANT EXECUTE ON FUNCTION public.guard_testnet_staking_engine_audit_immutable() TO service_role;

-- Postflight invariants. Any failure rolls back the entire migration.
DO $postflight$
DECLARE
  v_name text;
  v_rls boolean;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'project_staking_governance',
    'project_staking_policy_acceptances',
    'project_staking_engine_evaluation_audit'
  ] LOOP
    SELECT c.relrowsecurity INTO v_rls
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=v_name AND c.relkind='r';
    IF v_rls IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'MIGRATION_A_POSTCHECK_RLS_NOT_ENABLED: %', v_name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM public.projects p
    LEFT JOIN public.project_staking_governance g
      ON g.project_id=p.id AND g.network='testnet'
    WHERE p.network='testnet' AND p.status='approved' AND g.id IS NULL
  ) THEN
    RAISE EXCEPTION 'MIGRATION_A_POSTCHECK_APPROVED_PROJECT_MISSING_GOVERNANCE_ROW';
  END IF;

  IF has_table_privilege('anon', 'public.project_staking_governance', 'SELECT')
     OR has_table_privilege('authenticated', 'public.project_staking_governance', 'SELECT')
     OR has_table_privilege('anon', 'public.project_staking_policy_acceptances', 'SELECT')
     OR has_table_privilege('authenticated', 'public.project_staking_policy_acceptances', 'SELECT')
     OR has_table_privilege('anon', 'public.project_staking_engine_evaluation_audit', 'SELECT')
     OR has_table_privilege('authenticated', 'public.project_staking_engine_evaluation_audit', 'SELECT') THEN
    RAISE EXCEPTION 'MIGRATION_A_POSTCHECK_BROWSER_TABLE_ACCESS_PRESENT';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.project_staking_governance', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.project_staking_governance', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.project_staking_governance', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.project_staking_policy_acceptances', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.project_staking_policy_acceptances', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.project_staking_engine_evaluation_audit', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.project_staking_engine_evaluation_audit', 'INSERT') THEN
    RAISE EXCEPTION 'MIGRATION_A_POSTCHECK_SERVICE_ROLE_PRIVILEGES_INVALID';
  END IF;

  IF has_table_privilege('service_role', 'public.project_staking_policy_acceptances', 'UPDATE')
     OR has_table_privilege('service_role', 'public.project_staking_policy_acceptances', 'DELETE')
     OR has_table_privilege('service_role', 'public.project_staking_engine_evaluation_audit', 'UPDATE')
     OR has_table_privilege('service_role', 'public.project_staking_engine_evaluation_audit', 'DELETE') THEN
    RAISE EXCEPTION 'MIGRATION_A_POSTCHECK_APPEND_ONLY_PRIVILEGES_INVALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='project_staking_governance'
      AND t.tgname='testnet_project_staking_governance_owner_guard'
      AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='project_staking_policy_acceptances'
      AND t.tgname='testnet_staking_policy_acceptance_guard'
      AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='project_staking_engine_evaluation_audit'
      AND t.tgname='testnet_staking_engine_audit_immutable'
      AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')
  ) THEN
    RAISE EXCEPTION 'MIGRATION_A_POSTCHECK_REQUIRED_TRIGGER_MISSING';
  END IF;
END;
$postflight$;

COMMIT;
