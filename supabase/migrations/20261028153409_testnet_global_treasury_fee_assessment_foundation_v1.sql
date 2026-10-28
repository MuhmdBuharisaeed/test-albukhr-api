-- ALBUKHR Testnet Global Treasury fee-assessment foundation v1
-- Applied to Testnet Supabase only; policy remains inactive.
BEGIN;
CREATE TABLE IF NOT EXISTS public.testnet_global_treasury_policy (
 singleton_id smallint PRIMARY KEY DEFAULT 1 CHECK (singleton_id=1),
 network text NOT NULL DEFAULT 'testnet' CHECK (network='testnet'),
 policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version>0),
 active boolean NOT NULL DEFAULT false,
 minimum_project_liquidity numeric(24,7) NOT NULL DEFAULT 100 CHECK (minimum_project_liquidity>=100),
 fee_tier_size numeric(24,7) NOT NULL DEFAULT 5 CHECK (fee_tier_size>0),
 fee_per_tier numeric(24,7) NOT NULL DEFAULT 0.01 CHECK (fee_per_tier>=0),
 sub_tier_fee_free_count smallint NOT NULL DEFAULT 3 CHECK (sub_tier_fee_free_count>=0),
 sub_tier_fee_after_quota numeric(24,7) NOT NULL DEFAULT 0.01 CHECK (sub_tier_fee_after_quota>=0),
 minimum_staker_withdrawal numeric(24,7) NOT NULL DEFAULT 0.5 CHECK (minimum_staker_withdrawal>0),
 allowed_duration_days integer[] NOT NULL DEFAULT ARRAY[30,90,180,365,730,1095]::integer[],
 business_day_timezone text NOT NULL DEFAULT 'Africa/Lagos',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT testnet_global_treasury_duration_policy_check
 CHECK (allowed_duration_days=ARRAY[30,90,180,365,730,1095]::integer[])
);
COMMENT ON TABLE public.testnet_global_treasury_policy IS 'Testnet-only ALBUKHR Global Treasury policy. Inactive until DB/API/payment tests pass.';
INSERT INTO public.testnet_global_treasury_policy
(singleton_id,network,policy_version,active,minimum_project_liquidity,fee_tier_size,fee_per_tier,sub_tier_fee_free_count,sub_tier_fee_after_quota,minimum_staker_withdrawal,allowed_duration_days,business_day_timezone)
VALUES (1,'testnet',1,false,100,5,0.01,3,0.01,0.5,ARRAY[30,90,180,365,730,1095]::integer[],'Africa/Lagos')
ON CONFLICT (singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.testnet_outflow_fee_assessments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 network text NOT NULL DEFAULT 'testnet' CHECK (network='testnet'),
 actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 actor_pi_uid text NOT NULL,
 project_id uuid REFERENCES public.projects(id) ON DELETE RESTRICT,
 source_type text NOT NULL CHECK (source_type IN ('staker_withdrawal','project_owner_withdrawal','other_external_outflow')),
 source_id uuid NOT NULL,
 local_day date NOT NULL,
 sub_tier_ordinal integer CHECK (sub_tier_ordinal IS NULL OR sub_tier_ordinal>0),
 requested_amount numeric(24,7) NOT NULL CHECK (requested_amount>0),
 fee_amount numeric(24,7) NOT NULL CHECK (fee_amount>=0),
 sender_total_debit numeric(24,7) GENERATED ALWAYS AS (requested_amount+fee_amount) STORED,
 recipient_amount numeric(24,7) NOT NULL CHECK (recipient_amount>0),
 fee_policy_version integer NOT NULL CHECK (fee_policy_version>0),
 fee_basis text NOT NULL CHECK (fee_basis IN ('no_fee_under_tier_daily_allowance','under_tier_after_allowance','complete_tier_fee')),
 fee_status text NOT NULL DEFAULT 'not_required' CHECK (fee_status IN ('not_required','payment_pending','paid','failed','refunded')),
 fee_payment_id text UNIQUE,
 fee_payment_txid text,
 payout_txid text,
 idempotency_key text NOT NULL UNIQUE,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT testnet_outflow_fee_recipient_amount_check CHECK (recipient_amount=requested_amount),
 CONSTRAINT testnet_outflow_fee_source_unique UNIQUE (source_type,source_id)
);
CREATE INDEX IF NOT EXISTS testnet_outflow_fee_actor_day_idx
 ON public.testnet_outflow_fee_assessments(actor_user_id,local_day,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS testnet_outflow_fee_subtier_ordinal_uidx
 ON public.testnet_outflow_fee_assessments(actor_user_id,local_day,sub_tier_ordinal)
 WHERE sub_tier_ordinal IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.testnet_platform_fee_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 network text NOT NULL DEFAULT 'testnet' CHECK (network='testnet'),
 assessment_id uuid NOT NULL REFERENCES public.testnet_outflow_fee_assessments(id) ON DELETE RESTRICT,
 entry_type text NOT NULL CHECK (entry_type IN ('fee_collected','fee_refund')),
 movement text NOT NULL CHECK (movement IN ('credit','debit')),
 amount numeric(24,7) NOT NULL CHECK (amount>0),
 payment_txid text,
 idempotency_key text NOT NULL UNIQUE,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT testnet_platform_fee_ledger_assessment_type_unique UNIQUE (assessment_id,entry_type)
);
COMMENT ON TABLE public.testnet_platform_fee_ledger IS 'Platform-level Testnet fee revenue/refund ledger; do not charge user-paid fees to project reward reserves.';

ALTER TABLE public.testnet_global_treasury_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.testnet_outflow_fee_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.testnet_platform_fee_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.testnet_global_treasury_policy FROM anon,authenticated;
REVOKE ALL ON TABLE public.testnet_outflow_fee_assessments FROM anon,authenticated;
REVOKE ALL ON TABLE public.testnet_platform_fee_ledger FROM anon,authenticated;
GRANT ALL ON TABLE public.testnet_global_treasury_policy TO service_role;
GRANT ALL ON TABLE public.testnet_outflow_fee_assessments TO service_role;
GRANT ALL ON TABLE public.testnet_platform_fee_ledger TO service_role;
COMMIT;
