-- ALBUKHR Testnet: harden verified stake-payment evidence at the database boundary.
-- TESTNET ONLY. No payment is initiated and no existing stake/accounting row is changed.
-- Adds independent database validation for verified payment evidence and TXID uniqueness.

BEGIN;

DO $preflight$
DECLARE
  v_duplicate_txids integer;
  v_invalid_verified_rows integer;
  v_rls_enabled boolean;
  v_security_definer boolean;
  v_anon_execute boolean;
  v_authenticated_execute boolean;
  v_service_execute boolean;
BEGIN
  IF to_regclass('public.testnet_stake_payments') IS NULL
     OR to_regclass('public.testnet_stake_intents') IS NULL
     OR to_regclass('public.stakes') IS NULL
     OR to_regclass('public.project_treasury') IS NULL
     OR to_regclass('public.testnet_global_treasury_policy') IS NULL
     OR to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: required Testnet payment table is missing';
  END IF;

  SELECT c.relrowsecurity INTO v_rls_enabled
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname='testnet_stake_payments';
  IF v_rls_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: RLS must remain enabled on testnet_stake_payments';
  END IF;

  SELECT count(*)::integer INTO v_duplicate_txids
  FROM (
    SELECT network,btrim(txid) AS txid
    FROM public.testnet_stake_payments
    WHERE network='testnet' AND nullif(btrim(txid),'') IS NOT NULL
    GROUP BY network,btrim(txid) HAVING count(*)>1
  ) duplicates;
  IF v_duplicate_txids>0 THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: duplicate Testnet TXIDs already exist';
  END IF;

  SELECT count(*)::integer INTO v_invalid_verified_rows
  FROM public.testnet_stake_payments p
  WHERE p.network='testnet' AND p.verification_status='verified'
    AND (
      p.pi_status IS DISTINCT FROM 'completed'
      OR nullif(btrim(p.txid),'') IS NULL
      OR p.verified_at IS NULL
      OR nullif(btrim(p.verification_reference),'') IS NULL
      OR btrim(p.verification_reference) IS DISTINCT FROM btrim(p.txid)
      OR nullif(btrim(p.recipient_wallet),'') IS NULL
      OR p.metadata->>'network' IS DISTINCT FROM 'testnet'
      OR p.metadata->>'action' IS DISTINCT FROM 'stake'
      OR nullif(btrim(p.metadata->>'testnet_pi_uid'),'') IS NULL
      OR nullif(btrim(p.metadata->>'stake_intent_id'),'') IS NULL
      OR p.metadata->>'txid' IS DISTINCT FROM p.txid
    );
  IF v_invalid_verified_rows>0 THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: % verified payment row(s) lack required evidence',v_invalid_verified_rows;
  END IF;

  SELECT p.prosecdef,
         has_function_privilege('anon',p.oid,'EXECUTE'),
         has_function_privilege('authenticated',p.oid,'EXECUTE'),
         has_function_privilege('service_role',p.oid,'EXECUTE')
    INTO v_security_definer,v_anon_execute,v_authenticated_execute,v_service_execute
  FROM pg_proc p
  WHERE p.oid='public.finalize_testnet_stake_intent(uuid,text,text)'::regprocedure;
  IF NOT FOUND OR v_security_definer IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: finalizer missing or not SECURITY DEFINER';
  END IF;
  IF v_anon_execute OR v_authenticated_execute OR NOT v_service_execute THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: finalizer is not service_role-only';
  END IF;
END;
$preflight$;

-- A verified Pi payment must not reuse a Testnet blockchain transaction ID.
CREATE UNIQUE INDEX testnet_stake_payments_network_txid_uidx
  ON public.testnet_stake_payments(network,txid)
  WHERE network='testnet' AND txid IS NOT NULL AND btrim(txid)<>'';

-- New rows cannot be labelled verified unless the underlying evidence is complete.
ALTER TABLE public.testnet_stake_payments
  ADD CONSTRAINT testnet_stake_payments_verified_evidence_check
  CHECK (
    verification_status <> 'verified'
    OR (
      pi_status IS NOT DISTINCT FROM 'completed'
      AND nullif(btrim(txid),'') IS NOT NULL
      AND verified_at IS NOT NULL
      AND nullif(btrim(verification_reference),'') IS NOT NULL
      AND btrim(verification_reference)=btrim(txid)
      AND nullif(btrim(recipient_wallet),'') IS NOT NULL
      AND metadata->>'network' IS NOT DISTINCT FROM 'testnet'
      AND metadata->>'action' IS NOT DISTINCT FROM 'stake'
      AND nullif(btrim(metadata->>'testnet_pi_uid'),'') IS NOT NULL
      AND nullif(btrim(metadata->>'stake_intent_id'),'') IS NOT NULL
      AND metadata->>'txid' IS NOT DISTINCT FROM txid
    )
  ) NOT VALID;
ALTER TABLE public.testnet_stake_payments
  VALIDATE CONSTRAINT testnet_stake_payments_verified_evidence_check;

DO $function_patch$
DECLARE
  v_function regprocedure := 'public.finalize_testnet_stake_intent(uuid,text,text)'::regprocedure;
  v_definition text;
  v_patched_definition text;
  v_after_definition text;
  v_security_definer boolean;
  v_function_config text[];
  v_owner_before text;
  v_owner_after text;
  v_anon_execute boolean;
  v_authenticated_execute boolean;
  v_service_execute boolean;
  v_payment_guard text := $guard$
  IF NOT FOUND OR v_payment.action <> 'stake'
     OR v_payment.pi_status <> 'completed'
     OR v_payment.verification_status <> 'verified'
     OR v_payment.payer_pi_uid IS DISTINCT FROM v_intent.pi_uid
     OR v_payment.project_id IS DISTINCT FROM v_intent.project_id
     OR v_payment.project_code IS DISTINCT FROM v_intent.project_code
     OR round(v_payment.amount, 7) IS DISTINCT FROM round(v_intent.amount, 7) THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'VERIFIED_PAYMENT_DOES_NOT_MATCH_STAKE_INTENT';
  END IF;

$guard$;
  v_evidence_guard text := $evidence$
  IF nullif(btrim(v_payment.txid),'') IS NULL
     OR v_payment.verified_at IS NULL
     OR nullif(btrim(v_payment.verification_reference),'') IS DISTINCT FROM nullif(btrim(v_payment.txid),'')
     OR v_payment.metadata->>'network' IS DISTINCT FROM 'testnet'
     OR v_payment.metadata->>'action' IS DISTINCT FROM 'stake'
     OR v_payment.metadata->>'stake_intent_id' IS DISTINCT FROM v_intent.id::text
     OR v_payment.metadata->>'project_id' IS DISTINCT FROM v_intent.project_id::text
     OR v_payment.metadata->>'project_code' IS DISTINCT FROM v_intent.project_code
     OR v_payment.metadata->>'duration_days' IS DISTINCT FROM v_intent.duration_days::text
     OR v_payment.metadata->>'txid' IS DISTINCT FROM v_payment.txid
     OR NOT EXISTS (
       SELECT 1
       FROM public.project_treasury t
       JOIN public.testnet_global_treasury_policy g
         ON g.singleton_id=1 AND g.network='testnet' AND g.active IS TRUE
       JOIN public.users u
         ON u.pi_uid=v_intent.pi_uid AND u.network='testnet'
       WHERE t.project_id=v_intent.project_id
         AND t.network='testnet'
         AND t.status='active'
         AND nullif(btrim(t.treasury_wallet),'') IS NOT NULL
         AND btrim(v_payment.recipient_wallet)=btrim(t.treasury_wallet)
         AND btrim(v_payment.recipient_wallet)=btrim(g.treasury_wallet)
         AND nullif(btrim(u.testnet_pi_uid),'') IS NOT NULL
         AND btrim(v_payment.metadata->>'testnet_pi_uid')=btrim(u.testnet_pi_uid)
     ) THEN
    RAISE EXCEPTION USING errcode='22023', message='VERIFIED_PAYMENT_EVIDENCE_INVALID';
  END IF;

$evidence$;
  v_search_path_old text := $old$ SET search_path TO 'public'$old$;
  v_search_path_new text := $new$ SET search_path TO ''$new$;
BEGIN
  SELECT pg_get_functiondef(p.oid),p.prosecdef,p.proconfig,
         pg_get_userbyid(p.proowner),
         has_function_privilege('anon',p.oid,'EXECUTE'),
         has_function_privilege('authenticated',p.oid,'EXECUTE'),
         has_function_privilege('service_role',p.oid,'EXECUTE')
    INTO v_definition,v_security_definer,v_function_config,v_owner_before,
         v_anon_execute,v_authenticated_execute,v_service_execute
  FROM pg_proc p WHERE p.oid=v_function::oid;

  IF NOT FOUND OR v_security_definer IS DISTINCT FROM true
     OR NOT coalesce(v_function_config @> ARRAY['search_path=public']::text[],false) THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: finalizer security definition differs from reviewed state';
  END IF;
  IF v_anon_execute OR v_authenticated_execute OR NOT v_service_execute THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: finalizer privileges are not service_role-only';
  END IF;
  IF length(v_definition)-length(replace(v_definition,v_payment_guard,''))<>length(v_payment_guard) THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: exact payment validation block not found exactly once';
  END IF;

  v_patched_definition:=replace(v_definition,v_payment_guard,v_payment_guard||v_evidence_guard);
  IF length(v_patched_definition)=length(v_definition) THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: evidence guard insertion failed';
  END IF;
  IF length(v_patched_definition)-length(replace(v_patched_definition,v_search_path_old,''))<>length(v_search_path_old) THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: expected function search_path was not found exactly once';
  END IF;
  v_patched_definition:=replace(v_patched_definition,v_search_path_old,v_search_path_new);
  v_patched_definition:=replace(v_patched_definition,' RETURNS stakes',' RETURNS public.stakes');
  IF position(' RETURNS public.stakes' IN v_patched_definition)=0
     OR position(' SET search_path TO ''public''' IN v_patched_definition)>0 THEN
    RAISE EXCEPTION 'PRECHECK_FAILED: safe return type/search_path replacement failed';
  END IF;

  EXECUTE v_patched_definition;

  SELECT pg_get_functiondef(p.oid),p.prosecdef,p.proconfig,
         pg_get_userbyid(p.proowner),
         has_function_privilege('anon',p.oid,'EXECUTE'),
         has_function_privilege('authenticated',p.oid,'EXECUTE'),
         has_function_privilege('service_role',p.oid,'EXECUTE')
    INTO v_after_definition,v_security_definer,v_function_config,v_owner_after,
         v_anon_execute,v_authenticated_execute,v_service_execute
  FROM pg_proc p WHERE p.oid=v_function::oid;

  IF v_security_definer IS DISTINCT FROM true
     OR NOT coalesce(v_function_config @> ARRAY['search_path=""']::text[],false)
     OR v_owner_after IS DISTINCT FROM v_owner_before THEN
    RAISE EXCEPTION 'POSTCHECK_FAILED: finalizer owner/security/search_path changed unexpectedly';
  END IF;
  IF v_anon_execute OR v_authenticated_execute OR NOT v_service_execute THEN
    RAISE EXCEPTION 'POSTCHECK_FAILED: finalizer privileges changed unexpectedly';
  END IF;
  IF position('VERIFIED_PAYMENT_EVIDENCE_INVALID' IN v_after_definition)=0
     OR position('v_payment.recipient_wallet' IN v_after_definition)=0
     OR position('v_payment.txid' IN v_after_definition)=0
     OR position('v_payment.verification_reference' IN v_after_definition)=0
     OR position('v_payment.metadata' IN v_after_definition)=0 THEN
    RAISE EXCEPTION 'POSTCHECK_FAILED: payment evidence guard missing after replacement';
  END IF;
END;
$function_patch$;

COMMIT;
