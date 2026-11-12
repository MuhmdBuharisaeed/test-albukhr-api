
CREATE OR REPLACE FUNCTION public.refresh_testnet_project_treasury_verified_liquidity(
  p_project_id uuid
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_role text;
  v_project_status text;
  v_global_wallet text;
  v_minimum numeric;
  v_project_treasury_id uuid;
  v_project_wallet text;
  v_verified numeric := 0;
BEGIN
  v_role := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    NULLIF(
      pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'role',
      ''
    ),
    ''
  );

  IF v_role <> 'service_role' THEN
    RAISE EXCEPTION USING
      errcode = '42501',
      message = 'SERVICE_ROLE_REQUIRED';
  END IF;

  IF p_project_id IS NULL THEN
    RAISE EXCEPTION USING
      errcode = '22023',
      message = 'PROJECT_ID_REQUIRED';
  END IF;

  SELECT p.status
    INTO v_project_status
  FROM public.projects AS p
  WHERE p.id = p_project_id
    AND p.network = 'testnet'
  FOR SHARE;

  IF NOT FOUND OR v_project_status <> 'approved' THEN
    RAISE EXCEPTION USING
      errcode = 'P0002',
      message = 'TESTNET_PROJECT_NOT_APPROVED';
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
    RAISE EXCEPTION USING
      errcode = '55000',
      message = 'TESTNET_GLOBAL_TREASURY_CONFIGURATION_INCOMPLETE';
  END IF;

  SELECT t.id, t.treasury_wallet
    INTO v_project_treasury_id, v_project_wallet
  FROM public.project_treasury AS t
  WHERE t.project_id = p_project_id
    AND t.network = 'testnet'
    AND t.status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      errcode = 'P0002',
      message = 'TESTNET_PROJECT_TREASURY_NOT_ACTIVE';
  END IF;

  IF v_project_wallet IS DISTINCT FROM v_global_wallet THEN
    RAISE EXCEPTION USING
      errcode = '23514',
      message = 'TESTNET_PROJECT_GLOBAL_TREASURY_MISMATCH';
  END IF;

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
    AND lp.verification_status = 'verified';

  UPDATE public.project_treasury AS t
  SET verified_liquidity = v_verified,
      updated_at = pg_catalog.now()
  WHERE t.id = v_project_treasury_id
    AND t.project_id = p_project_id
    AND t.network = 'testnet';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      errcode = '40001',
      message = 'TESTNET_TREASURY_VERIFIED_LIQUIDITY_REFRESH_FAILED';
  END IF;

  RETURN v_verified;
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_testnet_project_treasury_verified_liquidity(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_testnet_project_treasury_verified_liquidity(uuid)
  TO service_role;

COMMENT ON FUNCTION public.refresh_testnet_project_treasury_verified_liquidity(uuid)
  IS 'Testnet-only idempotent reconciliation of project_treasury.verified_liquidity from server-verified, completed project liquidity payments. Requires service_role and enforces the Global Treasury wallet.';
