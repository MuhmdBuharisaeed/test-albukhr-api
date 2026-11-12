CREATE INDEX project_staking_offer_audit_owner_idx
  ON public.project_staking_offer_audit (owner_user_id);
CREATE INDEX project_staking_offer_audit_project_code_idx
  ON public.project_staking_offer_audit (project_code);
CREATE INDEX testnet_stake_intents_project_code_idx
  ON public.testnet_stake_intents (project_code);
CREATE INDEX testnet_stake_intents_stake_id_idx
  ON public.testnet_stake_intents (stake_id)
  WHERE stake_id IS NOT NULL;
