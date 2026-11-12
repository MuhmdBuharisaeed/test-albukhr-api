
CREATE OR REPLACE FUNCTION public.refresh_testnet_project_treasury_verified_liquidity(
  p_project_id uuid
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_project_status text;
  v_global_wallet text;
  v_minimum numeric;
  v_project_treasury_id uuid;
  v_project_wallet text;
  v_verified numeric := 0;
BEGIN
  IF p_project_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PROJECT_ID_REQUIRED';
  END IF;

  SELECT p.status
    INTO v_project_status
  FROM public.projects AS p
  WHERE p.id = p_project_id
    AND p.network = 'testnet'
  FOR SHARE;

  IF NOT FOUND OR v_project_status <> 'approved' THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'TESTNET_PROJECT_NOT_APPROVED';
  END IF;

  SELECT g.treasury_wallet, g.minimum_project_liquidity
    INTO v_global_wallet, v_minimum
  FROM public.testnet_global_treasury_policy AS g
  WHERE g.singleton_id = 1
    AND g.network = 'testnet'
  FOR SHARE;

  IF NOT FOUND
     OR NULLIF(pg_catalog.btrim(COALESCE(v_global_wallet, '')), '') IS NULL
     OR v_minimum IS NULL
     OR v_minimum < 100 THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'TESTNET_GLOBAL_TREASURY_CONFIGURATION_INCOMPLETE';
  END IF;

  SELECT t.id, t.treasury_wallet
    INTO v_project_treasury_id, v_project_wallet
  FROM public.project_treasury AS t
  WHERE t.project_id = p_project_id
    AND t.network = 'testnet'
    AND t.status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'TESTNET_PROJECT_TREASURY_NOT_ACTIVE';
  END IF;

  IF v_project_wallet IS DISTINCT FROM v_global_wallet THEN
    RAISE EXCEPTION USING errcode = '23514', message = 'TESTNET_PROJECT_GLOBAL_TREASURY_MISMATCH';
  END IF;

  -- A Pi payment contributes to verified liquidity only when its authoritative
  -- completed/verified record has the matching idempotent owner-liquidity ledger credit.
  SELECT pg_catalog.round(
           COALESCE(pg_catalog.sum(lp.amount), 0)::numeric,
           7
         )
    INTO v_verified
  FROM public.project_liquidity_payments AS lp
  WHERE lp.project_id = p_project_id
    AND lp.network = 'testnet'
    AND lp.action = 'add_liquidity'
    AND lp.pi_status = 'completed'
    AND lp.verification_status = 'verified'
    AND EXISTS (
      SELECT 1
      FROM public.project_staking_ledger AS ledger
      WHERE ledger.network = 'testnet'
        AND ledger.project_id = lp.project_id
        AND ledger.bucket = 'owner_liquidity'
        AND ledger.movement = 'credit'
        AND ledger.event_type = 'liquidity_verified'
        AND ledger.source_type = 'project_liquidity_payment'
        AND ledger.source_id = lp.payment_id
        AND ledger.idempotency_key = 'liquidity:' || lp.payment_id
        AND ledger.amount = lp.amount
    );

  UPDATE public.project_treasury AS t
  SET verified_liquidity = v_verified,
      updated_at = pg_catalog.now()
  WHERE t.id = v_project_treasury_id
    AND t.project_id = p_project_id
    AND t.network = 'testnet';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '40001', message = 'TESTNET_TREASURY_VERIFIED_LIQUIDITY_REFRESH_FAILED';
  END IF;

  RETURN v_verified;
END;
$function$;

CREATE OR REPLACE FUNCTION public.on_testnet_owner_liquidity_ledger_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_old_project_id uuid;
  v_new_project_id uuid;
  v_old_relevant boolean := false;
  v_new_relevant boolean := false;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old_project_id := OLD.project_id;
    v_old_relevant :=
      OLD.network = 'testnet'
      AND OLD.bucket = 'owner_liquidity'
      AND OLD.event_type = 'liquidity_verified';
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new_project_id := NEW.project_id;
    v_new_relevant :=
      NEW.network = 'testnet'
      AND NEW.bucket = 'owner_liquidity'
      AND NEW.event_type = 'liquidity_verified';
  END IF;

  IF v_old_relevant AND (
       TG_OP = 'DELETE'
       OR NOT v_new_relevant
       OR OLD.project_id IS DISTINCT FROM NEW.project_id
  ) THEN
    PERFORM public.refresh_testnet_project_treasury_verified_liquidity(
      v_old_project_id
    );
  END IF;

  IF v_new_relevant THEN
    PERFORM public.refresh_testnet_project_treasury_verified_liquidity(
      v_new_project_id
    );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_testnet_project_treasury_verified_liquidity(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_testnet_project_treasury_verified_liquidity(uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.on_testnet_owner_liquidity_ledger_change()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS testnet_owner_liquidity_treasury_sync
  ON public.project_staking_ledger;

CREATE TRIGGER testnet_owner_liquidity_treasury_sync
AFTER INSERT OR UPDATE OR DELETE
ON public.project_staking_ledger
FOR EACH ROW
EXECUTE FUNCTION public.on_testnet_owner_liquidity_ledger_change();

COMMENT ON FUNCTION public.refresh_testnet_project_treasury_verified_liquidity(uuid)
  IS 'Testnet-only reconciliation from payment records with a matching idempotent verified owner-liquidity ledger credit; no Mainnet reads or writes.';

COMMENT ON FUNCTION public.on_testnet_owner_liquidity_ledger_change()
  IS 'Maintains Testnet project Treasury verified liquidity after owner-liquidity ledger changes.';
