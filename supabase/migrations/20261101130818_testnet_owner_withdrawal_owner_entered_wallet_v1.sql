-- Owner withdrawals must use the wallet explicitly entered for this
-- project-owner withdrawal request. Never inherit a global users.wallet_address,
-- which can be shared by owners who manage multiple projects.
CREATE OR REPLACE FUNCTION public.create_testnet_project_owner_withdrawal(
  p_project_id uuid,
  p_owner_user_id uuid,
  p_requested_amount numeric,
  p_wallet_address text,
  p_fee_rate numeric DEFAULT 0
)
RETURNS public.project_owner_withdrawals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_project public.projects%ROWTYPE;
  v_owner public.users%ROWTYPE;
  v_available numeric;
  v_policy_active boolean := false;
  v_requested numeric := round(coalesce(p_requested_amount, 0)::numeric, 7);
  v_row public.project_owner_withdrawals%ROWTYPE;
  v_wallet text := upper(nullif(trim(coalesce(p_wallet_address, '')), ''));
BEGIN
  SELECT active INTO v_policy_active
  FROM public.testnet_global_treasury_policy
  WHERE singleton_id = 1 AND network = 'testnet';

  IF NOT FOUND OR v_policy_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'TESTNET_GLOBAL_TREASURY_POLICY_INACTIVE';
  END IF;

  IF v_requested IS NULL OR v_requested <= 0
     OR v_requested::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OWNER_WITHDRAWAL_AMOUNT_INVALID';
  END IF;

  IF p_fee_rate IS NOT NULL AND p_fee_rate <> 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OWNER_WITHDRAWAL_FEE_MUST_BE_PAID_SEPARATELY';
  END IF;

  IF v_wallet IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OWNER_WITHDRAWAL_WALLET_REQUIRED';
  END IF;

  IF v_wallet !~ '^G[A-Z2-7]{55}$' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OWNER_WITHDRAWAL_WALLET_INVALID';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_project_id::text || ':' || p_owner_user_id::text, 0)
  );

  SELECT * INTO v_project
  FROM public.projects
  WHERE id = p_project_id AND network = 'testnet' AND status = 'approved'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'PROJECT_NOT_APPROVED';
  END IF;

  SELECT * INTO v_owner
  FROM public.users
  WHERE id = p_owner_user_id AND network = 'testnet'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'OWNER_USER_NOT_FOUND';
  END IF;

  IF v_project.owner_user_id IS DISTINCT FROM v_owner.id THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'PROJECT_OWNER_ACCESS_DENIED';
  END IF;

  v_available := public.get_testnet_project_owner_balance(p_project_id, p_owner_user_id);
  IF v_available < v_requested THEN
    RAISE EXCEPTION USING errcode = '22003', message = 'OWNER_BALANCE_INSUFFICIENT';
  END IF;

  INSERT INTO public.project_owner_withdrawals (
    project_id, owner_user_id, network, requested_amount,
    fee_rate, fee_amount, net_amount, wallet_address, status, metadata
  )
  VALUES (
    p_project_id, p_owner_user_id, 'testnet', v_requested,
    0, 0, v_requested, v_wallet, 'pending',
    jsonb_build_object('source', 'project_owner', 'network', 'testnet',
      'fee_paid_separately', true, 'wallet_source', 'owner_submitted_withdrawal_request')
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_testnet_project_owner_withdrawal(uuid, uuid, numeric, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_testnet_project_owner_withdrawal(uuid, uuid, numeric, text, numeric) TO service_role;
