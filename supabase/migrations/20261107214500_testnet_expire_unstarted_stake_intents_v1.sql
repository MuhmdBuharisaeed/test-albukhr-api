-- ALBUKHR Testnet: safely expire only stale staking intents that never entered Pi payment.
-- This migration is Testnet-project-specific. Do not apply to Mainnet.
--
-- Payment lifecycle hardening:
--   * a pending intent may receive a Pi payment ID only after /arm has marked
--     metadata.payment_started = true;
--   * a pending intent may transition to created only after the same marker;
--   * cancellation and expiry remain allowed without the marker.
--
-- Expiry safety boundary:
--   * pending_payment only
--   * expires_at <= now()
--   * payment_id IS NULL
--   * payment_started absent/false AND payment_armed absent/false
--   * armed/payment-started intents are deliberately excluded and require Pi reconciliation
--
-- Expiry never deletes ledger history. It writes balanced reversal entries and
-- marks the intent expired in the same transaction.

-- DB-level guard: do not allow payment binding or stake finalization to bypass /arm.
CREATE OR REPLACE FUNCTION public.guard_testnet_stake_intent_payment_arm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.network <> 'testnet' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.payment_id IS NOT NULL
       AND NEW.metadata ->> 'payment_started' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'STAKE_INTENT_PAYMENT_NOT_ARMED';
    END IF;

    IF NEW.status = 'created'
       AND NEW.metadata ->> 'payment_started' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'STAKE_INTENT_PAYMENT_NOT_ARMED';
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.payment_id IS DISTINCT FROM OLD.payment_id
       AND NEW.payment_id IS NOT NULL
       AND NEW.metadata ->> 'payment_started' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'STAKE_INTENT_PAYMENT_NOT_ARMED';
    END IF;

    IF OLD.status IS DISTINCT FROM 'created'
       AND NEW.status = 'created'
       AND NEW.metadata ->> 'payment_started' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'STAKE_INTENT_PAYMENT_NOT_ARMED';
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL PRIVILEGES
  ON FUNCTION public.guard_testnet_stake_intent_payment_arm()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS testnet_stake_intent_payment_arm_guard
  ON public.testnet_stake_intents;

CREATE TRIGGER testnet_stake_intent_payment_arm_guard
BEFORE INSERT OR UPDATE OF payment_id, status
ON public.testnet_stake_intents
FOR EACH ROW
EXECUTE FUNCTION public.guard_testnet_stake_intent_payment_arm();

-- Expire pending intents which never entered Pi payment and return their reward
-- reservation to owner liquidity without deleting ledger history.
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

  -- Candidate scan is intentionally unlocked. Acquire the same per-project
  -- advisory lock used by create_testnet_stake_intent before locking the row.
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
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'albukhr:testnet:staking:' || v_candidate.project_id::text,
        0
      )
    );

    -- Re-check every safety predicate after acquiring the project lock.
    -- SKIP LOCKED avoids blocking live payment/cancellation operations.
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

    -- Reverse the exact reward reservation written at intent creation.
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
    v_released_reward_amount :=
      v_released_reward_amount + v_intent.reward_amount;
  END LOOP;

  RETURN QUERY
  SELECT v_expired_count, v_released_reward_amount;
END;
$function$;

-- The scheduled job executes as postgres. No browser/API role can invoke this.
REVOKE ALL PRIVILEGES
  ON FUNCTION public.expire_testnet_unstarted_stake_intents(integer)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE
  ON FUNCTION public.expire_testnet_unstarted_stake_intents(integer)
  TO postgres;

-- Replace only this named Testnet job; do not touch unrelated scheduled jobs.
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
