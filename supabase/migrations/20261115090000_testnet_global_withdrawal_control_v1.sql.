-- ALBUKHR Testnet Global Withdrawal Control v1
-- TESTNET ONLY. Mainnet is intentionally untouched.
--
-- Adds a third independently controlled global flag without changing the
-- existing Treasury or Staking flags. The flag defaults to FALSE so new
-- withdrawal requests/claims fail closed until the Super Admin control is
-- enabled through the updated API and Admin UI.
--
-- Existing fee-payment callbacks, payout reconciliation, and settlement of
-- already-processing withdrawals are deliberately NOT gated by this flag.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.testnet_global_treasury_policy') IS NULL
     OR to_regclass('public.testnet_global_transaction_control_audit') IS NULL
     OR to_regclass('public.withdrawal_requests') IS NULL
     OR to_regclass('public.project_owner_withdrawals') IS NULL
     OR to_regclass('public.testnet_outflow_fee_assessments') IS NULL
     OR to_regclass('public.testnet_platform_fee_ledger') IS NULL THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: required Testnet withdrawal/global-control table is missing';
  END IF;

  IF to_regprocedure('public.create_testnet_withdrawal(text,uuid,text,numeric,text)') IS NULL
     OR to_regprocedure('public.create_testnet_withdrawal_idempotent(text,uuid,text,numeric,text,text)') IS NULL
     OR to_regprocedure('public.create_testnet_project_owner_withdrawal(uuid,uuid,numeric,text,numeric)') IS NULL
     OR to_regprocedure('public.create_testnet_outflow_fee_assessment(text,uuid)') IS NULL
     OR to_regprocedure('public.claim_testnet_withdrawal(uuid,text)') IS NULL
     OR to_regprocedure('public.set_testnet_global_transaction_control(uuid,text,boolean,text,text,boolean,boolean)') IS NULL THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: one or more reviewed Testnet RPC signatures are missing';
  END IF;

  IF (SELECT count(*) FROM public.testnet_global_treasury_policy
      WHERE singleton_id = 1 AND network = 'testnet') <> 1 THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: expected exactly one Testnet global policy row';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'testnet_global_treasury_policy'
      AND column_name = 'withdrawal_enabled'
      AND data_type <> 'boolean'
  ) THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: existing withdrawal_enabled column is not boolean';
  END IF;
END;
$preflight$;

-- Existing policy rows receive FALSE. No Treasury/Staking value is modified.
ALTER TABLE public.testnet_global_treasury_policy
  ADD COLUMN IF NOT EXISTS withdrawal_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.testnet_global_treasury_policy.withdrawal_enabled IS
  'Testnet-only Super Admin switch for starting new withdrawal requests and payout claims. Does not block fee-payment recovery, payout reconciliation, or settlement of already-processing withdrawals.';

-- The audit trail now accepts the third independent global control.
ALTER TABLE public.testnet_global_transaction_control_audit
  DROP CONSTRAINT IF EXISTS testnet_global_transaction_control_audit_control_check;

ALTER TABLE public.testnet_global_transaction_control_audit
  ADD CONSTRAINT testnet_global_transaction_control_audit_control_check
  CHECK (control IN ('treasury', 'staking', 'withdrawals'));

-- Shared database guard. FOR SHARE serializes new withdrawal operations against
-- the Super Admin's FOR UPDATE policy-row lock when pausing/resuming withdrawals.
CREATE OR REPLACE FUNCTION public.assert_testnet_global_withdrawals_enabled()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_enabled boolean;
BEGIN
  SELECT p.withdrawal_enabled
    INTO v_enabled
  FROM public.testnet_global_treasury_policy AS p
  WHERE p.singleton_id = 1
    AND p.network = 'testnet'
  FOR SHARE;

  IF NOT FOUND OR v_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'GLOBAL_WITHDRAWALS_PAUSED';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.assert_testnet_global_withdrawals_enabled()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_testnet_global_withdrawals_enabled()
  TO service_role;

-- Patch the current staker withdrawal creator without replacing unrelated
-- balance, maturity, ownership, reserve, fee, or idempotency logic.
DO $patch_staker_create$
DECLARE
  v_signature regprocedure :=
    'public.create_testnet_withdrawal(text,uuid,text,numeric,text)'::regprocedure;
  v_definition text;
  v_old text := $old$
  SELECT active INTO v_policy_active
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1 AND network = 'testnet';

  IF NOT FOUND OR v_policy_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'TESTNET_GLOBAL_TREASURY_POLICY_INACTIVE';
  END IF;
$old$;
  v_new text := $new$
  SELECT active INTO v_policy_active
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1 AND network = 'testnet'
  FOR SHARE;

  IF NOT FOUND OR v_policy_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'TESTNET_GLOBAL_TREASURY_POLICY_INACTIVE';
  END IF;

  PERFORM public.assert_testnet_global_withdrawals_enabled();
$new$;
BEGIN
  SELECT pg_get_functiondef(v_signature) INTO v_definition;
  IF v_definition IS NULL OR position(v_old IN v_definition) = 0 THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: reviewed staker withdrawal policy guard was not found';
  END IF;
  IF length(v_definition) - length(replace(v_definition, v_old, '')) <> length(v_old) THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: staker withdrawal policy guard is not unique';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  IF position('assert_testnet_global_withdrawals_enabled' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'POSTCHECK_FAILED: staker withdrawal global-control guard insertion failed';
  END IF;
  EXECUTE v_definition;
END;
$patch_staker_create$;

-- Patch the Project Owner request creator. The owner identity, approved-project,
-- wallet validation, owner balance, and owner-entered-wallet semantics remain.
DO $patch_owner_create$
DECLARE
  v_signature regprocedure :=
    'public.create_testnet_project_owner_withdrawal(uuid,uuid,numeric,text,numeric)'::regprocedure;
  v_definition text;
  v_old text := $old$
  SELECT active INTO v_policy_active
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1 AND network = 'testnet';

  IF NOT FOUND OR v_policy_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'TESTNET_GLOBAL_TREASURY_POLICY_INACTIVE';
  END IF;
$old$;
  v_new text := $new$
  SELECT active INTO v_policy_active
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1 AND network = 'testnet'
  FOR SHARE;

  IF NOT FOUND OR v_policy_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'TESTNET_GLOBAL_TREASURY_POLICY_INACTIVE';
  END IF;

  PERFORM public.assert_testnet_global_withdrawals_enabled();
$new$;
BEGIN
  SELECT pg_get_functiondef(v_signature) INTO v_definition;
  IF v_definition IS NULL OR position(v_old IN v_definition) = 0 THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: reviewed Project Owner withdrawal policy guard was not found';
  END IF;
  IF length(v_definition) - length(replace(v_definition, v_old, '')) <> length(v_old) THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: Project Owner withdrawal policy guard is not unique';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  IF position('assert_testnet_global_withdrawals_enabled' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'POSTCHECK_FAILED: Project Owner withdrawal global-control guard insertion failed';
  END IF;
  EXECUTE v_definition;
END;
$patch_owner_create$;

-- Existing fee assessments remain readable/retryable while withdrawals are
-- paused. Only creation of a NEW assessment is blocked. This permits a fee
-- payment already in progress to be completed/cancelled safely.
DO $patch_fee_assessment$
DECLARE
  v_signature regprocedure :=
    'public.create_testnet_outflow_fee_assessment(text,uuid)'::regprocedure;
  v_definition text;
  v_old text := $old$
  IF FOUND THEN
    IF v_existing.actor_user_id IS DISTINCT FROM v_actor_user_id
       OR v_existing.actor_pi_uid IS DISTINCT FROM v_actor_pi_uid
       OR round(v_existing.requested_amount, 7) IS DISTINCT FROM round(v_requested, 7) THEN
      RAISE EXCEPTION USING errcode = '23514', message = 'OUTFLOW_FEE_EXISTING_ASSESSMENT_MISMATCH';
    END IF;
    RETURN v_existing;
  END IF;
$old$;
  v_new text := $new$
  IF FOUND THEN
    IF v_existing.actor_user_id IS DISTINCT FROM v_actor_user_id
       OR v_existing.actor_pi_uid IS DISTINCT FROM v_actor_pi_uid
       OR round(v_existing.requested_amount, 7) IS DISTINCT FROM round(v_requested, 7) THEN
      RAISE EXCEPTION USING errcode = '23514', message = 'OUTFLOW_FEE_EXISTING_ASSESSMENT_MISMATCH';
    END IF;
    RETURN v_existing;
  END IF;

  PERFORM public.assert_testnet_global_withdrawals_enabled();
$new$;
BEGIN
  SELECT pg_get_functiondef(v_signature) INTO v_definition;
  IF v_definition IS NULL OR position(v_old IN v_definition) = 0 THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: reviewed existing-fee-assessment return block was not found';
  END IF;
  IF length(v_definition) - length(replace(v_definition, v_old, '')) <> length(v_old) THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: existing-fee-assessment return block is not unique';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  IF position('assert_testnet_global_withdrawals_enabled' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'POSTCHECK_FAILED: new fee-assessment global-control guard insertion failed';
  END IF;
  EXECUTE v_definition;
END;
$patch_fee_assessment$;

-- Rebuild the staker claim RPC with the same public signature and stricter
-- execution boundary. Reconciliation/settlement functions are not changed.
CREATE OR REPLACE FUNCTION public.claim_testnet_withdrawal(
  p_request_id uuid,
  p_pi_uid text
)
RETURNS public.withdrawal_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_result public.withdrawal_requests;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'SERVICE_ROLE_REQUIRED';
  END IF;

  IF p_request_id IS NULL OR nullif(trim(coalesce(p_pi_uid, '')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'WITHDRAWAL_CLAIM_FIELDS_REQUIRED';
  END IF;

  PERFORM public.assert_testnet_global_withdrawals_enabled();

  UPDATE public.withdrawal_requests AS w
  SET status = 'processing',
      updated_at = pg_catalog.now()
  WHERE w.id = p_request_id
    AND w.pi_uid = nullif(trim(p_pi_uid), '')
    AND w.network = 'testnet'
    AND w.status = 'pending'
  RETURNING w.* INTO v_result;

  IF v_result.id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'WITHDRAWAL_NOT_PENDING_OR_NOT_FOUND';
  END IF;

  RETURN v_result;
END;
$function$;

-- Atomic claim for the owner self-service payout route. Only a separately
-- approved request can be claimed, and only while the global switch is open.
CREATE OR REPLACE FUNCTION public.claim_testnet_project_owner_withdrawal(
  p_request_id uuid,
  p_owner_user_id uuid
)
RETURNS public.project_owner_withdrawals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_result public.project_owner_withdrawals;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'SERVICE_ROLE_REQUIRED';
  END IF;

  IF p_request_id IS NULL OR p_owner_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'OWNER_WITHDRAWAL_CLAIM_FIELDS_REQUIRED';
  END IF;

  PERFORM public.assert_testnet_global_withdrawals_enabled();

  UPDATE public.project_owner_withdrawals AS w
  SET status = 'processing',
      updated_at = pg_catalog.now()
  WHERE w.id = p_request_id
    AND w.owner_user_id = p_owner_user_id
    AND w.network = 'testnet'
    AND w.status = 'approved'
    AND w.reviewed_by IS NOT NULL
    AND w.reviewed_at IS NOT NULL
  RETURNING w.* INTO v_result;

  IF v_result.id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'OWNER_WITHDRAWAL_NOT_APPROVED_OR_NOT_CLAIMABLE';
  END IF;

  RETURN v_result;
END;
$function$;

-- Atomic claim for the existing Super Admin /pay-withdraw route. The API still
-- enforces its existing administrator authentication before invoking this RPC.
CREATE OR REPLACE FUNCTION public.claim_testnet_admin_withdrawal(
  p_request_id uuid
)
RETURNS public.withdrawal_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_result public.withdrawal_requests;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'SERVICE_ROLE_REQUIRED';
  END IF;

  IF p_request_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'WITHDRAWAL_ID_REQUIRED';
  END IF;

  PERFORM public.assert_testnet_global_withdrawals_enabled();

  UPDATE public.withdrawal_requests AS w
  SET status = 'processing',
      updated_at = pg_catalog.now()
  WHERE w.id = p_request_id
    AND w.network = 'testnet'
    AND w.status = 'approved'
  RETURNING w.* INTO v_result;

  IF v_result.id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'WITHDRAWAL_NOT_APPROVED_OR_NOT_CLAIMABLE';
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_testnet_withdrawal(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_testnet_withdrawal(uuid, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.claim_testnet_project_owner_withdrawal(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_testnet_project_owner_withdrawal(uuid, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.claim_testnet_admin_withdrawal(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_testnet_admin_withdrawal(uuid)
  TO service_role;

-- Defense in depth for any future service-role path that inserts a new
-- Testnet withdrawal row or changes a not-yet-processing request to processing.
-- Updates to already-processing rows (A2U IDs, TXIDs, completion/settlement) are
-- intentionally not blocked by this trigger.
CREATE OR REPLACE FUNCTION public.guard_testnet_withdrawal_global_control()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NEW.network IS DISTINCT FROM 'testnet' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM public.assert_testnet_global_withdrawals_enabled();
  ELSIF NEW.status = 'processing'
        AND OLD.status IS DISTINCT FROM 'processing' THEN
    PERFORM public.assert_testnet_global_withdrawals_enabled();
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_testnet_withdrawal_global_control()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS testnet_withdrawal_global_control_guard
  ON public.withdrawal_requests;
CREATE TRIGGER testnet_withdrawal_global_control_guard
  BEFORE INSERT OR UPDATE OF status
  ON public.withdrawal_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_testnet_withdrawal_global_control();

DROP TRIGGER IF EXISTS testnet_owner_withdrawal_global_control_guard
  ON public.project_owner_withdrawals;
CREATE TRIGGER testnet_owner_withdrawal_global_control_guard
  BEFORE INSERT OR UPDATE OF status
  ON public.project_owner_withdrawals
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_testnet_withdrawal_global_control();

-- Add a dedicated withdrawals branch to the existing Super Admin control RPC.
-- Treasury and Staking logic is retained verbatim.
DO $patch_global_control$
DECLARE
  v_signature regprocedure :=
    'public.set_testnet_global_transaction_control(uuid,text,boolean,text,text,boolean,boolean)'::regprocedure;
  v_definition text;
  v_old_control_list text := $old$p_control NOT IN ('treasury', 'staking')$old$;
  v_new_control_list text := $new$p_control NOT IN ('treasury', 'staking', 'withdrawals')$new$;
  v_old_anchor text := $old$  v_previous := v_policy.staking_policy_active;$old$;
  v_new_branch text := $branch$
  IF p_control = 'withdrawals' THEN
    v_previous := v_policy.withdrawal_enabled;

    IF p_enabled THEN
      IF v_policy.active IS DISTINCT FROM true THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'GLOBAL_TREASURY_NOT_READY';
      END IF;

      IF p_pi_api_configured IS DISTINCT FROM true THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'GLOBAL_TREASURY_PAYMENT_RAILS_NOT_READY';
      END IF;

      IF p_payout_wallet_configured IS DISTINCT FROM true THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'GLOBAL_TREASURY_PAYOUT_WALLET_NOT_READY';
      END IF;

      IF nullif(trim(coalesce(v_policy.treasury_wallet, '')), '') IS NULL
         OR nullif(trim(coalesce(p_pi_testnet_app_wallet, '')), '') IS NULL
         OR trim(v_policy.treasury_wallet) IS DISTINCT FROM trim(p_pi_testnet_app_wallet) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'GLOBAL_TREASURY_WALLET_MISMATCH';
      END IF;

      IF coalesce(v_policy.minimum_project_liquidity, 0) < 100
         OR coalesce(v_policy.fee_tier_size, 0) <= 0
         OR coalesce(v_policy.fee_per_tier, -1) < 0
         OR coalesce(v_policy.sub_tier_fee_free_count, -1) < 0
         OR coalesce(v_policy.sub_tier_fee_after_quota, -1) < 0
         OR coalesce(v_policy.minimum_staker_withdrawal, 0) <= 0
         OR v_policy.business_day_timezone IS DISTINCT FROM 'Africa/Lagos' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'GLOBAL_TREASURY_CONFIGURATION_INCOMPLETE';
      END IF;

      IF to_regclass('public.testnet_outflow_fee_assessments') IS NULL
         OR to_regclass('public.testnet_platform_fee_ledger') IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'GLOBAL_TREASURY_PAYMENT_RAILS_NOT_READY';
      END IF;
    END IF;

    -- Pausing is always permitted. Existing fee callbacks, payout reconciliation,
    -- and settlement remain available and are not touched by this flag change.
    IF v_previous IS DISTINCT FROM p_enabled THEN
      UPDATE public.testnet_global_treasury_policy
      SET withdrawal_enabled = p_enabled,
          updated_at = pg_catalog.now()
      WHERE singleton_id = 1
        AND network = 'testnet';

      INSERT INTO public.testnet_global_transaction_control_audit (
        network, singleton_id, control, action, previous_enabled, enabled,
        admin_session_id, admin_actor_id, admin_email, reason,
        previous_state, after_state
      ) VALUES (
        'testnet', 1, 'withdrawals',
        CASE WHEN p_enabled THEN 'enabled' ELSE 'disabled' END,
        coalesce(v_previous, false), p_enabled,
        v_admin.id, v_admin.admin_user_id, v_admin.email, trim(p_reason),
        jsonb_build_object(
          'active', v_policy.active,
          'staking_policy_active', v_policy.staking_policy_active,
          'withdrawal_enabled', coalesce(v_previous, false)
        ),
        jsonb_build_object(
          'active', v_policy.active,
          'staking_policy_active', v_policy.staking_policy_active,
          'withdrawal_enabled', p_enabled
        )
      );
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'network', 'testnet',
      'control', 'withdrawals',
      'previous_enabled', coalesce(v_previous, false),
      'enabled', p_enabled,
      'changed', v_previous IS DISTINCT FROM p_enabled
    );
  END IF;

  v_previous := v_policy.staking_policy_active;
$branch$;
BEGIN
  SELECT pg_get_functiondef(v_signature) INTO v_definition;
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: global transaction-control RPC definition not found';
  END IF;

  IF position(v_old_control_list IN v_definition) = 0
     OR length(v_definition) - length(replace(v_definition, v_old_control_list, '')) <> length(v_old_control_list) THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: expected two-control validation was not found exactly once';
  END IF;

  IF position(v_old_anchor IN v_definition) = 0
     OR length(v_definition) - length(replace(v_definition, v_old_anchor, '')) <> length(v_old_anchor) THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: exact staking-branch insertion point was not found exactly once';
  END IF;

  v_definition := replace(v_definition, v_old_control_list, v_new_control_list);
  v_definition := replace(v_definition, v_old_anchor, v_new_branch);

  IF position('control' IN v_definition) = 0
     OR position('withdrawal_enabled = p_enabled' IN v_definition) = 0
     OR position($needle$'control', 'withdrawals'$needle$ IN v_definition) = 0 THEN
    RAISE EXCEPTION 'POSTCHECK_FAILED: withdrawals control branch insertion failed';
  END IF;

  EXECUTE v_definition;
END;
$patch_global_control$;

REVOKE ALL ON FUNCTION public.set_testnet_global_transaction_control(
  uuid, text, boolean, text, text, boolean, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_testnet_global_transaction_control(
  uuid, text, boolean, text, text, boolean, boolean
) TO service_role;

COMMENT ON FUNCTION public.set_testnet_global_transaction_control(
  uuid, text, boolean, text, text, boolean, boolean
) IS 'Testnet Super Admin control for independent Treasury, Staking, and Withdrawals flags. Pausing withdrawals blocks new withdrawal creation/claims but does not block fee-payment recovery, payout reconciliation, or settlement of already-processing withdrawals.';

-- Postflight: fail the transaction if the new column, guarded RPCs, audit
-- constraint, or trigger installations do not match the reviewed design.
DO $postflight$
DECLARE
  v_type text;
  v_not_null boolean;
  v_default text;
BEGIN
  SELECT data_type, is_nullable = 'NO', column_default
    INTO v_type, v_not_null, v_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'testnet_global_treasury_policy'
    AND column_name = 'withdrawal_enabled';

  IF v_type IS DISTINCT FROM 'boolean'
     OR v_not_null IS DISTINCT FROM true
     OR v_default IS NULL
     OR position('false' IN lower(v_default)) = 0 THEN
    RAISE EXCEPTION 'POSTCHECK_FAILED: withdrawal_enabled must be NOT NULL BOOLEAN DEFAULT FALSE';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.testnet_global_transaction_control_audit'::regclass
      AND conname = 'testnet_global_transaction_control_audit_control_check'
      AND pg_get_constraintdef(oid) LIKE '%withdrawals%'
  ) THEN
    RAISE EXCEPTION 'POSTCHECK_FAILED: global control audit does not accept withdrawals';
  END IF;

  IF to_regprocedure('public.claim_testnet_project_owner_withdrawal(uuid,uuid)') IS NULL
     OR to_regprocedure('public.claim_testnet_admin_withdrawal(uuid)') IS NULL THEN
    RAISE EXCEPTION 'POSTCHECK_FAILED: owner/admin atomic claim RPC missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'withdrawal_requests'
      AND t.tgname = 'testnet_withdrawal_global_control_guard'
      AND NOT t.tgisinternal
      AND t.tgenabled IN ('O', 'A')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'project_owner_withdrawals'
      AND t.tgname = 'testnet_owner_withdrawal_global_control_guard'
      AND NOT t.tgisinternal
      AND t.tgenabled IN ('O', 'A')
  ) THEN
    RAISE EXCEPTION 'POSTCHECK_FAILED: one or more Testnet withdrawal guard triggers are missing or disabled';
  END IF;

  IF has_function_privilege('anon', 'public.claim_testnet_project_owner_withdrawal(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.claim_testnet_project_owner_withdrawal(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.claim_testnet_project_owner_withdrawal(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.claim_testnet_admin_withdrawal(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.claim_testnet_admin_withdrawal(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.claim_testnet_admin_withdrawal(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCHECK_FAILED: claim RPC privileges are not service_role-only';
  END IF;
END;
$postflight$;

COMMIT;
