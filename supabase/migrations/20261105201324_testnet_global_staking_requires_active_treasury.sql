
-- ALBUKHR Testnet: Global staking requires active treasury.

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'testnet_global_treasury_policy'
      AND c.conname =
        'testnet_global_staking_requires_active_treasury'
  ) THEN
    ALTER TABLE public.testnet_global_treasury_policy
      ADD CONSTRAINT
        testnet_global_staking_requires_active_treasury
      CHECK (
        COALESCE(staking_policy_active, false) IS FALSE
        OR COALESCE(active, false) IS TRUE
      ) NOT VALID;
  END IF;
END
$migration$;

ALTER TABLE public.testnet_global_treasury_policy
  VALIDATE CONSTRAINT
    testnet_global_staking_requires_active_treasury;

COMMENT ON CONSTRAINT
  testnet_global_staking_requires_active_treasury
ON public.testnet_global_treasury_policy IS
'Global Testnet staking cannot be active unless the Testnet global treasury is active.';
