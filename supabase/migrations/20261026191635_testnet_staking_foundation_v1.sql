
DO $safe$
BEGIN
  IF EXISTS (SELECT 1 FROM public.stakes LIMIT 1) THEN
    RAISE EXCEPTION 'SAFE_GUARD_ABORT: public.stakes is not empty; do not switch payment foreign key automatically';
  END IF;
END
$safe$;

CREATE TABLE public.testnet_stake_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id text NOT NULL UNIQUE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  project_code text NOT NULL REFERENCES public.projects(project_code) ON UPDATE CASCADE ON DELETE RESTRICT,
  payer_pi_uid text NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  recipient_wallet text NOT NULL,
  network text NOT NULL DEFAULT 'testnet' CHECK (network = 'testnet'),
  action text NOT NULL DEFAULT 'stake' CHECK (action = 'stake'),
  pi_status text,
  verification_status text NOT NULL DEFAULT 'pending',
  txid text,
  verified_at timestamptz,
  verification_reference text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX testnet_stake_payments_project_verify_idx
  ON public.testnet_stake_payments (project_id, network, verification_status, pi_status);

CREATE TABLE public.project_staking_risk_controls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL UNIQUE REFERENCES public.projects(id) ON DELETE RESTRICT,
  project_code text NOT NULL REFERENCES public.projects(project_code) ON UPDATE CASCADE ON DELETE RESTRICT,
  network text NOT NULL DEFAULT 'testnet' CHECK (network = 'testnet'),
  staking_enabled boolean NOT NULL DEFAULT false,
  approval_status text NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('pending', 'approved', 'rejected', 'suspended')),
  minimum_liquidity numeric NOT NULL DEFAULT 100 CHECK (minimum_liquidity >= 100),
  capital_reserve_percent numeric
    CHECK (capital_reserve_percent IS NULL OR capital_reserve_percent BETWEEN 1 AND 99),
  maximum_deployment_percent numeric
    CHECK (maximum_deployment_percent IS NULL OR maximum_deployment_percent BETWEEN 1 AND 99),
  max_reward_rate numeric
    CHECK (max_reward_rate IS NULL OR max_reward_rate BETWEEN 0 AND 1),
  max_active_principal numeric
    CHECK (max_active_principal IS NULL OR max_active_principal > 0),
  reward_reserve_coverage_percent numeric NOT NULL DEFAULT 100
    CHECK (reward_reserve_coverage_percent = 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_staking_reserve_deployment_sum_check
    CHECK (
      capital_reserve_percent IS NULL
      OR maximum_deployment_percent IS NULL
      OR capital_reserve_percent + maximum_deployment_percent <= 100
    ),
  CONSTRAINT project_staking_activation_guard_check
    CHECK (
      NOT staking_enabled
      OR (
        approval_status = 'approved'
        AND capital_reserve_percent IS NOT NULL
        AND maximum_deployment_percent IS NOT NULL
        AND max_reward_rate IS NOT NULL
      )
    )
);

CREATE TABLE public.project_staking_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network text NOT NULL DEFAULT 'testnet' CHECK (network = 'testnet'),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  stake_id uuid REFERENCES public.stakes(id) ON DELETE RESTRICT,
  stake_payment_id uuid REFERENCES public.testnet_stake_payments(id) ON DELETE RESTRICT,
  withdrawal_request_id uuid REFERENCES public.withdrawal_requests(id) ON DELETE RESTRICT,
  bucket text NOT NULL
    CHECK (bucket IN ('owner_liquidity', 'capital_reserve', 'project_operating', 'reward_reserve', 'platform_fees')),
  movement text NOT NULL CHECK (movement IN ('credit', 'debit')),
  event_type text NOT NULL
    CHECK (event_type IN (
      'liquidity_verified',
      'stake_principal_received',
      'capital_reserved',
      'capital_released_to_project',
      'capital_returned',
      'reward_reserved',
      'reward_paid',
      'reward_reserve_replenished',
      'withdrawal_fee_collected',
      'admin_adjustment'
    )),
  amount numeric NOT NULL CHECK (amount > 0),
  source_type text,
  source_id text,
  idempotency_key text NOT NULL UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_staking_ledger_project_date_idx
  ON public.project_staking_ledger (project_id, network, created_at DESC);
CREATE INDEX project_staking_ledger_stake_idx
  ON public.project_staking_ledger (stake_id) WHERE stake_id IS NOT NULL;

-- Current stakes is empty (guarded above). Stake payments must never reference
-- liquidity records, so replace that foreign key with the dedicated Testnet table.
ALTER TABLE public.stakes
  DROP CONSTRAINT IF EXISTS stakes_payment_record_id_fkey;
ALTER TABLE public.stakes
  ADD CONSTRAINT stakes_payment_record_id_fkey
  FOREIGN KEY (payment_record_id)
  REFERENCES public.testnet_stake_payments(id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX stakes_payment_id_unique_idx
  ON public.stakes (payment_id);
CREATE INDEX stakes_testnet_project_unlock_idx
  ON public.stakes (project_id, network, unlock_at);
CREATE INDEX stakes_testnet_pi_uid_status_idx
  ON public.stakes (pi_uid, network, status);

ALTER TABLE public.testnet_stake_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_staking_risk_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_staking_ledger ENABLE ROW LEVEL SECURITY;

DO $policies$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='testnet_stake_payments'
      AND policyname='testnet_stake_payments_no_direct_api_access'
  ) THEN
    EXECUTE 'CREATE POLICY testnet_stake_payments_no_direct_api_access
      ON public.testnet_stake_payments FOR ALL TO anon, authenticated
      USING (false) WITH CHECK (false)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='project_staking_risk_controls'
      AND policyname='project_staking_risk_controls_no_direct_api_access'
  ) THEN
    EXECUTE 'CREATE POLICY project_staking_risk_controls_no_direct_api_access
      ON public.project_staking_risk_controls FOR ALL TO anon, authenticated
      USING (false) WITH CHECK (false)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='project_staking_ledger'
      AND policyname='project_staking_ledger_no_direct_api_access'
  ) THEN
    EXECUTE 'CREATE POLICY project_staking_ledger_no_direct_api_access
      ON public.project_staking_ledger FOR ALL TO anon, authenticated
      USING (false) WITH CHECK (false)';
  END IF;
END
$policies$;

REVOKE ALL ON TABLE public.testnet_stake_payments FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.testnet_stake_payments TO service_role;

REVOKE ALL ON TABLE public.project_staking_risk_controls FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.project_staking_risk_controls TO service_role;

REVOKE ALL ON TABLE public.project_staking_ledger FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.project_staking_ledger TO service_role;
