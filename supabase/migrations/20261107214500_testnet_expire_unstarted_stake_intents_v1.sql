-- ALBUKHR Testnet: expire only stale staking intents that never entered Pi payment.
-- This migration is Testnet-project-specific. Do not apply to Mainnet.
--
-- Safety boundary:
--   * pending_payment only
--   * expired_at <= now()
--   * payment_id IS NULL
--   * payment_started is absent/false AND payment_armed is absent/false
--   * armed or payment-started intents are deliberately excluded and require Pi reconciliation
--
-- Expiry does not DELETE ledger history. It writes balanced admin_adjustment entries
-- to reverse the temporary reward reservation, then marks the intent expired.

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

  -- Candidate scan is intentionally unlocked. The per-project advisory lock is
  -- acquired before taking the intent row lock, matching the staking guard's
  -- project-level serialization order.
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

    -- Re-check every safety predicate after obtaining the project lock.
    -- SKIP LOCKED prevents competing cleanup/admin work from blocking this job.
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

    -- The create-intent transaction writes exactly this reward-reservation pair.
    -- Reverse it with its own idempotency keys; never delete or rewrite history.
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

-- This function is for the database scheduler only. It is not a public API.
REVOKE ALL PRIVILEGES
  ON FUNCTION public.expire_testnet_unstarted_stake_intents(integer)
  FROM PUBLIC, anon, authenticated, service_role;

-- Existing Testnet cron jobs run as postgres; grant only that scheduler role.
GRANT EXECUTE
  ON FUNCTION public.expire_testnet_unstarted_stake_intents(integer)
  TO postgres;

-- Replace only this named Testnet job, without touching other scheduled jobs.
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
