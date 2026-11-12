
GRANT SELECT (
  project_code,
  network,
  duration_days,
  min_stake,
  reward_rate,
  active
)
ON TABLE public.project_staking_terms
TO service_role;
