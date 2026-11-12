
CREATE OR REPLACE FUNCTION public.arm_testnet_stake_intent_payment(
  p_intent_id uuid,
  p_pi_uid text
)
RETURNS public.testnet_stake_intents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_intent public.testnet_stake_intents%rowtype;
  v_uid text := nullif(trim(p_pi_uid), '');
BEGIN
  IF p_intent_id IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_INTENT_ARM_FIELDS_REQUIRED';
  END IF;

  SELECT * INTO v_intent
  FROM public.testnet_stake_intents
  WHERE id = p_intent_id AND network = 'testnet'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'STAKE_INTENT_NOT_FOUND';
  END IF;
  IF v_intent.pi_uid IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'STAKE_INTENT_USER_MISMATCH';
  END IF;
  IF v_intent.status <> 'pending_payment' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_INTENT_NOT_PENDING';
  END IF;

  IF v_intent.payment_id IS NULL AND v_intent.expires_at <= now() THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'STAKE_INTENT_EXPIRED';
  END IF;

  IF coalesce((v_intent.metadata->>'payment_started')::boolean, false) THEN
    RETURN v_intent;
  END IF;

  UPDATE public.testnet_stake_intents
  SET metadata = coalesce(metadata, '{}'::jsonb) ||
      jsonb_build_object('payment_started', true, 'payment_started_at', now()),
      updated_at = now()
  WHERE id = v_intent.id AND network = 'testnet'
  RETURNING * INTO v_intent;

  RETURN v_intent;
END;
$function$;

REVOKE ALL ON FUNCTION public.arm_testnet_stake_intent_payment(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arm_testnet_stake_intent_payment(uuid, text) TO service_role;

DO $fix$
DECLARE
  ddl text;
  anchor text := E'  IF v_intent.status = \'cancelled\' OR v_intent.status = \'expired\' THEN\n    RETURN v_intent;\n  END IF;\n  IF v_intent.status <> \'pending_payment\' THEN';
  replacement text := E'  IF v_intent.status = \'cancelled\' OR v_intent.status = \'expired\' THEN\n    RETURN v_intent;\n  END IF;\n  IF v_intent.payment_id IS NULL\n     AND nullif(trim(coalesce(p_payment_id, \'\')), \'\') IS NULL\n     AND coalesce((v_intent.metadata->>\'payment_started\')::boolean, false) THEN\n    RAISE EXCEPTION USING errcode = \'22023\', message = \'PI_PAYMENT_ID_REQUIRED_FOR_CANCELLATION\';\n  END IF;\n  IF v_intent.status <> \'pending_payment\' THEN';
BEGIN
  SELECT pg_get_functiondef(
    'public.cancel_testnet_stake_intent(uuid,text,text)'::regprocedure
  ) INTO ddl;
  IF position(anchor IN ddl) = 0 THEN
    RAISE EXCEPTION 'SAFE_FIX_ABORT: cancellation guard insertion point mismatch';
  END IF;
  EXECUTE replace(ddl, anchor, replacement);
END
$fix$;
