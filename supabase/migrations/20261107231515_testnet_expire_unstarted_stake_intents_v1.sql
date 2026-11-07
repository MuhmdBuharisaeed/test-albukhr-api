-- ALBUKHR Testnet: expire only stale staking intents that never entered Pi payment.
-- TESTNET ONLY. Do not apply this migration to Mainnet.
--
-- Safety boundary:
--   * pending_payment only
--   * expires_at <= now()
--   * payment_id IS NULL
--   * payment_started absent/false AND payment_armed absent/false
--   * armed or payment-started intents are excluded for Pi reconciliation
--
-- Lock order is INTENT ROW -> PROJECT ADVISORY LOCK. This matches
-- finalize_testnet_stake_intent(), avoiding a row/advisory-lock inversion.
-- The expiry operation writes balanced audit ledger entries; it never deletes history.

CREATE OR REPLACE FUNCTION public.expire_testnet_unstarted_stake_intents(
  p_batch_size integer DEFAULT 100
)
RETURNS TABLE (
  expired_count integer,
  released_reward_amount numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_candidate record;
  v_intent public.testnet_stake_intents%ROWTYPE;
  v_expired_count integer := 0;
  v_released_reward_amount numeric := 0;
  v_updated_rows integer := 0;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 500 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'TESTNET_STAKE_INTENT_EXPIRY_BATCH_SIZE_INVALID';
  END IF;

  FOR v_candidate IN
    SELECT i.id, i.project_id
    FROM public.testnet_stake_intents AS i
    JOIN public.projects AS p
      ON p.id = i.project_id
     AND p.network = 'testnet'
    WHERE i.network = 'testnet'
      AND i.status = 'pending_payment'
      AND i.payment_id IS NULL
      AND i.expires_at IS NOT NULL
      AND i.expires_at <= pg_catalog.now()
      AND (
        i.metadata ->> 'payment_started' IS NULL
        OR i.metadata ->> 'payment_started' = 'false'
      )
      AND (
        i.metadata ->> 'payment_armed' IS NULL
        OR i.metadata ->> 'payment_armed' = 'false'
      )
    ORDER BY i.project_id, i.expires_at, i.id
    LIMIT p_batch_size
  LOOP
    -- Acquire the row lock FIRST. SKIP LOCKED lets another transaction
    -- (e.g. finalization) own the intent without blocking the whole batch.
    SELECT i.*
      INTO v_intent
    FROM public.testnet_stake_intents AS i
    WHERE i.id = v_candidate.id
      AND i.project_id = v_candidate.project_id
      AND i.network = 'testnet'
      AND i.status = 'pending_payment'
      AND i.payment_id IS NULL
      AND i.expires_at IS NOT NULL
      AND i.expires_at <= pg_catalog.now()
      AND (
        i.metadata ->> 'payment_started' IS NULL
        OR i.metadata ->> 'payment_started' = 'false'
      )
      AND (
        i.metadata ->> 'payment_armed' IS NULL
        OR i.metadata ->> 'payment_armed' = 'false'
      )
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    -- Match the lock order used by finalize_testnet_stake_intent().
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'albukhr:testnet:staking:' || v_intent.project_id::text,
        0
      )
    );

    -- Recheck the protected state after acquiring both locks.
    IF v_intent.status <> 'pending_payment'
       OR v_intent.payment_id IS NOT NULL
       OR v_intent.expires_at IS NULL
       OR v_intent.expires_at > pg_catalog.now()
       OR coalesce(v_intent.metadata ->> 'payment_started', 'false') <> 'false'
       OR coalesce(v_intent.metadata ->> 'payment_armed', 'false') <> 'false' THEN
      CONTINUE;
    END IF;

    -- Reverse the exact reward reservation pair from create_testnet_stake_intent.
    INSERT INTO public.project_staking_ledger (
      network,
      project_id,
      bucket,
      movement,
      event_type,
      amount,
      source_type,
      source_id,
      idempotency_key,
      metadata
    )
    VALUES
    (
      'testnet',
      v_intent.project_id,
      'reward_reserve',
      'debit',
      'admin_adjustment',
      v_intent.reward_amount,
      'stake_intent_expiry',
      v_intent.id::text,
      'intent:' || v_intent.id::text || ':expiry-reward-debit',
      pg_catalog.jsonb_build_object(
        'reason', 'expired_before_payment',
        'intent_id', v_intent.id,
        'project_code', v_intent.project_code,
        'network', 'testnet',
        'payment_id', NULL,
        'payment_started', false,
        'payment_armed', false
      )
    ),
    (
      'testnet',
      v_intent.project_id,
      'owner_liquidity',
      'credit',
      'admin_adjustment',
      v_intent.reward_amount,
      'stake_intent_expiry',
      v_intent.id::text,
      'intent:' || v_intent.id::text || ':expiry-liquidity-credit',
      pg_catalog.jsonb_build_object(
        'reason', 'expired_before_payment',
        'intent_id', v_intent.id,
        'project_code', v_intent.project_code,
        'network', 'testnet',
        'payment_id', NULL,
        'payment_started', false,
        'payment_armed', false
      )
    );

    UPDATE public.testnet_stake_intents
    SET status = 'expired',
        metadata = coalesce(metadata, '{}'::jsonb)
          || pg_catalog.jsonb_build_object(
            'expiry_reason', 'expired_before_payment',
            'expiry_processed_at', pg_catalog.now()
          ),
        updated_at = pg_catalog.now()
    WHERE id = v_intent.id
      AND project_id = v_intent.project_id
      AND network = 'testnet'
      AND status = 'pending_payment'
      AND payment_id IS NULL;

    GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
    IF v_updated_rows <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'TESTNET_STAKE_INTENT_EXPIRY_STATE_CHANGED';
    END IF;

    v_expired_count := v_expired_count + 1;
    v_released_reward_amount := v_released_reward_amount + v_intent.reward_amount;
  END LOOP;

  RETURN QUERY
  SELECT v_expired_count, v_released_reward_amount;
END;
$function$;

REVOKE ALL PRIVILEGES
  ON FUNCTION public.expire_testnet_unstarted_stake_intents(integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE
  ON FUNCTION public.expire_testnet_unstarted_stake_intents(integer)
  TO postgres;

-- A second database-level guard: an intent cannot bind a Pi payment or become
-- created unless /arm has marked payment_started=true. This protects against
-- bypassing the API and calling a SECURITY DEFINER RPC directly.
CREATE OR REPLACE FUNCTION public.guard_testnet_stake_intent_payment_arming()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $trigger$
BEGIN
  IF NEW.network = 'testnet' THEN
    IF NEW.payment_id IS NOT NULL
       AND OLD.payment_id IS DISTINCT FROM NEW.payment_id
       AND NEW.metadata ->> 'payment_started' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'STAKE_INTENT_PAYMENT_NOT_ARMED';
    END IF;

    IF NEW.status = 'created'
       AND OLD.status IS DISTINCT FROM 'created'
       AND NEW.metadata ->> 'payment_started' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'STAKE_INTENT_PAYMENT_NOT_ARMED';
    END IF;
  END IF;

  RETURN NEW;
END;
$trigger$;

DROP TRIGGER IF EXISTS testnet_stake_intent_payment_arm_guard
  ON public.testnet_stake_intents;
CREATE TRIGGER testnet_stake_intent_payment_arm_guard
  BEFORE UPDATE OF payment_id, status, metadata
  ON public.testnet_stake_intents
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_testnet_stake_intent_payment_arming();

-- Scheduler runs as postgres in this Testnet project; replace only this named job.
DO $schedule$
DECLARE
  v_job_id bigint;
BEGIN
  FOR v_job_id IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'albukhr-testnet-expire-unstarted-stake-intents'
  LOOP
    PERFORM cron.unschedule(v_job_id);
  END LOOP;

  PERFORM cron.schedule(
    'albukhr-testnet-expire-unstarted-stake-intents',
    '*/5 * * * *',
    'SELECT public.expire_testnet_unstarted_stake_intents(100);'
  );
END;
$schedule$;
