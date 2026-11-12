
CREATE INDEX testnet_stake_payments_project_code_idx
  ON public.testnet_stake_payments (project_code);
CREATE INDEX project_staking_risk_controls_project_code_idx
  ON public.project_staking_risk_controls (project_code);
CREATE INDEX project_staking_ledger_payment_idx
  ON public.project_staking_ledger (stake_payment_id) WHERE stake_payment_id IS NOT NULL;
CREATE INDEX project_staking_ledger_withdrawal_idx
  ON public.project_staking_ledger (withdrawal_request_id) WHERE withdrawal_request_id IS NOT NULL;
