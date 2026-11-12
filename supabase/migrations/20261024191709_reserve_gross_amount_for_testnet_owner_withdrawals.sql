CREATE OR REPLACE FUNCTION public.get_testnet_project_owner_balance(
  p_project_id uuid,
  p_owner_user_id uuid
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_project_network text;
  v_owner_network text;
  v_credits numeric := 0;
  v_debits numeric := 0;
  v_reserved numeric := 0;
BEGIN
  SELECT network INTO v_project_network
  FROM public.projects
  WHERE id = p_project_id;

  SELECT network INTO v_owner_network
  FROM public.users
  WHERE id = p_owner_user_id;

  IF v_project_network IS DISTINCT FROM 'testnet'
     OR v_owner_network IS DISTINCT FROM 'testnet' THEN
    RAISE EXCEPTION 'TESTNET_OWNER_NETWORK_MISMATCH';
  END IF;

  SELECT COALESCE(SUM(amount), 0)
    INTO v_credits
  FROM public.project_owner_ledger_entries
  WHERE project_id = p_project_id
    AND owner_user_id = p_owner_user_id
    AND network = 'testnet'
    AND entry_type = 'credit';

  SELECT COALESCE(SUM(amount), 0)
    INTO v_debits
  FROM public.project_owner_ledger_entries
  WHERE project_id = p_project_id
    AND owner_user_id = p_owner_user_id
    AND network = 'testnet'
    AND entry_type = 'debit';

  -- Reserve the gross requested amount because completion debits
  -- requested_amount from the ledger; fees affect only the net payout.
  SELECT COALESCE(SUM(requested_amount), 0)
    INTO v_reserved
  FROM public.project_owner_withdrawals
  WHERE project_id = p_project_id
    AND owner_user_id = p_owner_user_id
    AND network = 'testnet'
    AND status IN ('pending', 'approved', 'processing');

  RETURN GREATEST(0, v_credits - v_debits - v_reserved);
END;
$function$;
