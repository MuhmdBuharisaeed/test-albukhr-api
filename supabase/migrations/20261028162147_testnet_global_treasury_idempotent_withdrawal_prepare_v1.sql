-- Add a Testnet-only idempotency key for withdrawal preparation.
-- Existing rows are retained and leave the new nullable key empty.
ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS client_request_key text;

CREATE UNIQUE INDEX IF NOT EXISTS withdrawal_requests_testnet_client_key_uidx
ON public.withdrawal_requests (network, pi_uid, client_request_key)
WHERE network = 'testnet' AND client_request_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.create_testnet_withdrawal_idempotent(
  p_pi_uid text,
  p_stake_id uuid,
  p_withdrawal_type text,
  p_requested_amount numeric,
  p_wallet_address text,
  p_client_request_key text
)
RETURNS public.withdrawal_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := nullif(trim(p_pi_uid), '');
  v_key text := nullif(trim(p_client_request_key), '');
  v_existing public.withdrawal_requests%ROWTYPE;
  v_created public.withdrawal_requests%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'PI_UID_REQUIRED';
  END IF;

  IF v_key IS NULL OR length(v_key) < 16 OR length(v_key) > 128
     OR v_key !~ '^[A-Za-z0-9._:-]+$' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'WITHDRAWAL_IDEMPOTENCY_KEY_INVALID';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('albukhr:testnet:withdraw-request-key:' || v_uid || ':' || v_key, 0)
  );

  SELECT * INTO v_existing
  FROM public.withdrawal_requests
  WHERE network = 'testnet'
    AND pi_uid = v_uid
    AND client_request_key = v_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.stake_id IS DISTINCT FROM p_stake_id
       OR lower(v_existing.withdrawal_type) IS DISTINCT FROM lower(trim(coalesce(p_withdrawal_type, '')))
       OR round(v_existing.requested_amount, 7) IS DISTINCT FROM round(coalesce(p_requested_amount, 0)::numeric, 7)
       OR v_existing.wallet_address IS DISTINCT FROM nullif(trim(coalesce(p_wallet_address, '')), '') THEN
      RAISE EXCEPTION USING errcode = '23505', message = 'WITHDRAWAL_IDEMPOTENCY_KEY_REUSED';
    END IF;
    RETURN v_existing;
  END IF;

  v_created := public.create_testnet_withdrawal(
    p_pi_uid,
    p_stake_id,
    p_withdrawal_type,
    p_requested_amount,
    p_wallet_address
  );

  UPDATE public.withdrawal_requests
  SET client_request_key = v_key,
      updated_at = now()
  WHERE id = v_created.id AND network = 'testnet'
  RETURNING * INTO v_created;

  IF v_created.id IS NULL THEN
    RAISE EXCEPTION USING errcode = 'P0001', message = 'WITHDRAWAL_IDEMPOTENCY_KEY_WRITE_FAILED';
  END IF;

  RETURN v_created;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_testnet_withdrawal_idempotent(text, uuid, text, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_testnet_withdrawal_idempotent(text, uuid, text, numeric, text, text) TO service_role;
