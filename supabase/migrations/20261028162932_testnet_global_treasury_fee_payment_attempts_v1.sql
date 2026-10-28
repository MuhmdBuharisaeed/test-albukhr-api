-- Testnet-only fee payment attempt locking.
-- Applied to Testnet Supabase as migration 20261028162932.

CREATE TABLE IF NOT EXISTS public.testnet_outflow_fee_payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network text NOT NULL DEFAULT 'testnet' CHECK (network = 'testnet'),
  assessment_id uuid NOT NULL REFERENCES public.testnet_outflow_fee_assessments(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  actor_pi_uid text NOT NULL,
  payment_id text NOT NULL,
  status text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'approved', 'paid', 'cancelled', 'failed')),
  transaction_txid text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  CONSTRAINT testnet_outflow_fee_payment_attempts_payment_unique UNIQUE (payment_id),
  CONSTRAINT testnet_outflow_fee_payment_attempts_assessment_payment_unique UNIQUE (assessment_id, payment_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS testnet_outflow_fee_one_active_attempt_per_assessment
ON public.testnet_outflow_fee_payment_attempts (assessment_id)
WHERE status IN ('reserved', 'approved');

CREATE INDEX IF NOT EXISTS testnet_outflow_fee_attempt_actor_created_idx
ON public.testnet_outflow_fee_payment_attempts (actor_user_id, created_at DESC);

ALTER TABLE public.testnet_outflow_fee_payment_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.testnet_outflow_fee_payment_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.testnet_outflow_fee_payment_attempts TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_testnet_outflow_fee_payment(
  p_assessment_id uuid,
  p_actor_pi_uid text,
  p_fee_payment_id text
)
RETURNS public.testnet_outflow_fee_payment_attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_assessment public.testnet_outflow_fee_assessments%ROWTYPE;
  v_attempt public.testnet_outflow_fee_payment_attempts%ROWTYPE;
  v_pi_uid text := nullif(trim(coalesce(p_actor_pi_uid, '')), '');
  v_payment_id text := nullif(trim(coalesce(p_fee_payment_id, '')), '');
BEGIN
  IF p_assessment_id IS NULL OR v_pi_uid IS NULL OR v_payment_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OUTFLOW_FEE_ATTEMPT_FIELDS_REQUIRED';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('albukhr:testnet:fee-attempt:' || p_assessment_id::text, 0)
  );

  SELECT * INTO v_assessment
  FROM public.testnet_outflow_fee_assessments
  WHERE id = p_assessment_id AND network = 'testnet'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'FEE_ASSESSMENT_NOT_FOUND';
  END IF;
  IF v_assessment.actor_pi_uid IS DISTINCT FROM v_pi_uid THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'FEE_ASSESSMENT_ACTOR_MISMATCH';
  END IF;
  IF v_assessment.fee_amount <= 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'FEE_PAYMENT_NOT_REQUIRED';
  END IF;
  IF v_assessment.fee_status = 'paid' THEN
    IF v_assessment.fee_payment_id = v_payment_id THEN
      SELECT * INTO v_attempt
      FROM public.testnet_outflow_fee_payment_attempts
      WHERE assessment_id = p_assessment_id AND payment_id = v_payment_id;
      IF FOUND THEN RETURN v_attempt; END IF;
    END IF;
    RAISE EXCEPTION USING errcode = '23505', message = 'FEE_ALREADY_PAID_DIFFERENT_PAYMENT';
  END IF;
  IF v_assessment.fee_status <> 'payment_pending' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'FEE_PAYMENT_NOT_PENDING';
  END IF;

  SELECT * INTO v_attempt
  FROM public.testnet_outflow_fee_payment_attempts
  WHERE assessment_id = p_assessment_id AND payment_id = v_payment_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_attempt.actor_pi_uid IS DISTINCT FROM v_pi_uid THEN
      RAISE EXCEPTION USING errcode = '42501', message = 'OUTFLOW_FEE_ATTEMPT_ACTOR_MISMATCH';
    END IF;
    IF v_attempt.status IN ('reserved', 'approved') THEN RETURN v_attempt; END IF;
    RAISE EXCEPTION USING errcode = '55000', message = 'OUTFLOW_FEE_ATTEMPT_NOT_REUSABLE';
  END IF;

  SELECT * INTO v_attempt
  FROM public.testnet_outflow_fee_payment_attempts
  WHERE assessment_id = p_assessment_id
    AND status IN ('reserved', 'approved')
  FOR UPDATE;

  IF FOUND THEN
    RAISE EXCEPTION USING errcode = '55000', message = 'OUTFLOW_FEE_PAYMENT_ATTEMPT_ACTIVE';
  END IF;

  INSERT INTO public.testnet_outflow_fee_payment_attempts (
    network, assessment_id, actor_user_id, actor_pi_uid, payment_id, status, metadata
  )
  VALUES (
    'testnet', v_assessment.id, v_assessment.actor_user_id, v_pi_uid, v_payment_id, 'reserved',
    jsonb_build_object('network', 'testnet', 'reserved_at', now())
  )
  RETURNING * INTO v_attempt;

  RETURN v_attempt;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_testnet_outflow_fee_payment_attempt_approved(
  p_assessment_id uuid,
  p_actor_pi_uid text,
  p_fee_payment_id text
)
RETURNS public.testnet_outflow_fee_payment_attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_assessment public.testnet_outflow_fee_assessments%ROWTYPE;
  v_attempt public.testnet_outflow_fee_payment_attempts%ROWTYPE;
  v_pi_uid text := nullif(trim(coalesce(p_actor_pi_uid, '')), '');
  v_payment_id text := nullif(trim(coalesce(p_fee_payment_id, '')), '');
BEGIN
  SELECT * INTO v_assessment
  FROM public.testnet_outflow_fee_assessments
  WHERE id = p_assessment_id AND network = 'testnet'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'FEE_ASSESSMENT_NOT_FOUND'; END IF;
  IF v_assessment.actor_pi_uid IS DISTINCT FROM v_pi_uid THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'FEE_ASSESSMENT_ACTOR_MISMATCH';
  END IF;
  IF v_assessment.fee_status <> 'payment_pending' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'FEE_PAYMENT_NOT_PENDING';
  END IF;

  SELECT * INTO v_attempt
  FROM public.testnet_outflow_fee_payment_attempts
  WHERE assessment_id = p_assessment_id AND payment_id = v_payment_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'OUTFLOW_FEE_ATTEMPT_NOT_FOUND'; END IF;
  IF v_attempt.actor_pi_uid IS DISTINCT FROM v_pi_uid THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'OUTFLOW_FEE_ATTEMPT_ACTOR_MISMATCH';
  END IF;
  IF v_attempt.status = 'approved' THEN RETURN v_attempt; END IF;
  IF v_attempt.status <> 'reserved' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OUTFLOW_FEE_ATTEMPT_NOT_APPROVABLE';
  END IF;

  UPDATE public.testnet_outflow_fee_payment_attempts
  SET status = 'approved', updated_at = now(),
      metadata = metadata || jsonb_build_object('approved_at', now())
  WHERE id = v_attempt.id
  RETURNING * INTO v_attempt;
  RETURN v_attempt;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_testnet_outflow_fee_payment_attempt(
  p_assessment_id uuid,
  p_actor_pi_uid text,
  p_fee_payment_id text
)
RETURNS public.testnet_outflow_fee_payment_attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_assessment public.testnet_outflow_fee_assessments%ROWTYPE;
  v_attempt public.testnet_outflow_fee_payment_attempts%ROWTYPE;
  v_pi_uid text := nullif(trim(coalesce(p_actor_pi_uid, '')), '');
  v_payment_id text := nullif(trim(coalesce(p_fee_payment_id, '')), '');
BEGIN
  IF p_assessment_id IS NULL OR v_pi_uid IS NULL OR v_payment_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OUTFLOW_FEE_ATTEMPT_FIELDS_REQUIRED';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('albukhr:testnet:fee-attempt:' || p_assessment_id::text, 0)
  );

  SELECT * INTO v_assessment
  FROM public.testnet_outflow_fee_assessments
  WHERE id = p_assessment_id AND network = 'testnet'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'FEE_ASSESSMENT_NOT_FOUND'; END IF;
  IF v_assessment.actor_pi_uid IS DISTINCT FROM v_pi_uid THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'FEE_ASSESSMENT_ACTOR_MISMATCH';
  END IF;
  IF v_assessment.fee_status <> 'payment_pending' THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'FEE_PAYMENT_NOT_PENDING';
  END IF;

  SELECT * INTO v_attempt
  FROM public.testnet_outflow_fee_payment_attempts
  WHERE assessment_id = p_assessment_id AND payment_id = v_payment_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_attempt.actor_pi_uid IS DISTINCT FROM v_pi_uid THEN
      RAISE EXCEPTION USING errcode = '42501', message = 'OUTFLOW_FEE_ATTEMPT_ACTOR_MISMATCH';
    END IF;
    IF v_attempt.status = 'cancelled' THEN RETURN v_attempt; END IF;
    IF v_attempt.status NOT IN ('reserved', 'approved') THEN
      RAISE EXCEPTION USING errcode = '22023', message = 'OUTFLOW_FEE_ATTEMPT_NOT_CANCELLABLE';
    END IF;

    UPDATE public.testnet_outflow_fee_payment_attempts
    SET status = 'cancelled', cancelled_at = now(), updated_at = now(),
        metadata = metadata || jsonb_build_object('cancelled_at', now())
    WHERE id = v_attempt.id
    RETURNING * INTO v_attempt;
    RETURN v_attempt;
  END IF;

  -- A Pi user can cancel before the approval callback creates a reservation.
  INSERT INTO public.testnet_outflow_fee_payment_attempts (
    network, assessment_id, actor_user_id, actor_pi_uid, payment_id, status,
    cancelled_at, metadata
  )
  VALUES (
    'testnet', v_assessment.id, v_assessment.actor_user_id, v_pi_uid,
    v_payment_id, 'cancelled', now(),
    jsonb_build_object('network', 'testnet', 'cancelled_before_reservation', true)
  )
  RETURNING * INTO v_attempt;

  RETURN v_attempt;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_testnet_outflow_fee_paid(
  p_assessment_id uuid,
  p_actor_pi_uid text,
  p_fee_payment_id text,
  p_fee_payment_txid text
)
RETURNS public.testnet_outflow_fee_assessments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.testnet_outflow_fee_assessments%ROWTYPE;
  v_attempt public.testnet_outflow_fee_payment_attempts%ROWTYPE;
  v_payment_id text := nullif(trim(coalesce(p_fee_payment_id, '')), '');
  v_txid text := nullif(trim(coalesce(p_fee_payment_txid, '')), '');
  v_pi_uid text := nullif(trim(coalesce(p_actor_pi_uid, '')), '');
BEGIN
  IF p_assessment_id IS NULL OR v_payment_id IS NULL OR v_txid IS NULL OR v_pi_uid IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OUTFLOW_FEE_PAYMENT_FIELDS_REQUIRED';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('albukhr:testnet:fee-attempt:' || p_assessment_id::text, 0)
  );

  SELECT * INTO v_row
  FROM public.testnet_outflow_fee_assessments
  WHERE id = p_assessment_id AND network = 'testnet'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'OUTFLOW_FEE_ASSESSMENT_NOT_FOUND'; END IF;
  IF v_row.actor_pi_uid IS DISTINCT FROM v_pi_uid THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'OUTFLOW_FEE_ACTOR_MISMATCH';
  END IF;

  IF v_row.fee_status = 'paid' THEN
    IF v_row.fee_payment_id = v_payment_id AND v_row.fee_payment_txid = v_txid THEN RETURN v_row; END IF;
    RAISE EXCEPTION USING errcode = '23505', message = 'OUTFLOW_FEE_ALREADY_PAID_WITH_DIFFERENT_PAYMENT';
  END IF;
  IF v_row.fee_status <> 'payment_pending' OR v_row.fee_amount <= 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OUTFLOW_FEE_PAYMENT_NOT_PENDING';
  END IF;

  SELECT * INTO v_attempt
  FROM public.testnet_outflow_fee_payment_attempts
  WHERE assessment_id = p_assessment_id AND payment_id = v_payment_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode = 'P0002', message = 'OUTFLOW_FEE_ATTEMPT_NOT_FOUND'; END IF;
  IF v_attempt.actor_pi_uid IS DISTINCT FROM v_pi_uid THEN
    RAISE EXCEPTION USING errcode = '42501', message = 'OUTFLOW_FEE_ATTEMPT_ACTOR_MISMATCH';
  END IF;
  IF v_attempt.status NOT IN ('reserved', 'approved') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'OUTFLOW_FEE_ATTEMPT_NOT_PAYABLE';
  END IF;

  UPDATE public.testnet_outflow_fee_payment_attempts
  SET status = 'paid', transaction_txid = v_txid, completed_at = now(), updated_at = now(),
      metadata = metadata || jsonb_build_object('paid_at', now(), 'transaction_txid', v_txid)
  WHERE id = v_attempt.id;

  UPDATE public.testnet_outflow_fee_assessments
  SET fee_status = 'paid',
      fee_payment_id = v_payment_id,
      fee_payment_txid = v_txid,
      updated_at = now()
  WHERE id = p_assessment_id AND network = 'testnet'
  RETURNING * INTO v_row;

  INSERT INTO public.testnet_platform_fee_ledger (
    network, assessment_id, entry_type, movement, amount, payment_txid,
    idempotency_key, metadata
  )
  VALUES (
    'testnet', v_row.id, 'fee_collected', 'credit', v_row.fee_amount, v_txid,
    'testnet-outflow-fee:' || v_row.id::text || ':collected',
    jsonb_build_object(
      'fee_payment_id', v_payment_id,
      'source_type', v_row.source_type,
      'source_id', v_row.source_id,
      'actor_user_id', v_row.actor_user_id,
      'actor_pi_uid', v_row.actor_pi_uid,
      'network', 'testnet'
    )
  )
  ON CONFLICT (assessment_id, entry_type) DO NOTHING;

  RETURN v_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.reserve_testnet_outflow_fee_payment(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_testnet_outflow_fee_payment_attempt_approved(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_testnet_outflow_fee_payment_attempt(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_testnet_outflow_fee_paid(uuid, text, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_testnet_outflow_fee_payment(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_testnet_outflow_fee_payment_attempt_approved(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_testnet_outflow_fee_payment_attempt(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_testnet_outflow_fee_paid(uuid, text, text, text) TO service_role;
