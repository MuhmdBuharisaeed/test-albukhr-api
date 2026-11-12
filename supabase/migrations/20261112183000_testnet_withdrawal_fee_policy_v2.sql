-- ALBUKHR Testnet withdrawal fee policy v2.
-- Apply to Testnet only. Mainnet is intentionally untouched.
-- This migration supersedes the temporary zero-fee Testnet policy.

update public.testnet_global_treasury_policy
set
  policy_version = 3,
  minimum_staker_withdrawal = 0.0500000,
  fee_per_tier = 0.0100000,
  sub_tier_fee_after_quota = 0.0100000,
  updated_at = now()
where singleton_id = 1
  and network = 'testnet';

do $migration$
declare
  v_definition text;
begin
  v_definition := pg_get_functiondef(
    'public.create_testnet_withdrawal(text,uuid,text,numeric,text)'::regprocedure
  );

  if position('v_min_requested numeric := 0.01;' in v_definition) = 0
     and position('v_min_requested numeric := 0.05;' in v_definition) = 0 then
    raise exception 'EXPECTED_TESTNET_WITHDRAWAL_MINIMUM_NOT_FOUND';
  end if;

  v_definition := replace(
    v_definition,
    'v_min_requested numeric := 0.01;',
    'v_min_requested numeric := 0.05;'
  );

  v_definition := replace(
    v_definition,
    'MINIMUM_STAKER_WITHDRAWAL_IS_0.01_PI',
    'MINIMUM_STAKER_WITHDRAWAL_IS_0.05_PI'
  );

  execute v_definition;
end
$migration$;
