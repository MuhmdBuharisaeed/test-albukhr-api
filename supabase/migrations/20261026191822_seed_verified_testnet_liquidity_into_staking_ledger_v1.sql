
INSERT INTO public.project_staking_ledger (
  network, project_id, bucket, movement, event_type, amount,
  source_type, source_id, idempotency_key, metadata
)
SELECT
  'testnet',
  p.project_id,
  'owner_liquidity',
  'credit',
  'liquidity_verified',
  p.amount,
  'project_liquidity_payment',
  p.payment_id,
  'liquidity:' || p.payment_id,
  jsonb_build_object(
    'payment_record_id', p.id,
    'verification_reference', p.verification_reference,
    'verified_at', p.verified_at,
    'seeded_from_verified_completed_testnet_liquidity', true
  )
FROM public.project_liquidity_payments p
WHERE p.network = 'testnet'
  AND p.action = 'add_liquidity'
  AND p.pi_status = 'completed'
  AND p.verification_status = 'verified'
ON CONFLICT (idempotency_key) DO NOTHING;
