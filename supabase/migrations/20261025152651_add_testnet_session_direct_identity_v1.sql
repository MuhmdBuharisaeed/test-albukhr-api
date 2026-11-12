ALTER TABLE public.testnet_sessions
  ADD COLUMN IF NOT EXISTS testnet_pi_uid text;
CREATE INDEX IF NOT EXISTS testnet_sessions_testnet_pi_uid_idx
  ON public.testnet_sessions (testnet_pi_uid)
  WHERE network = 'testnet' AND testnet_pi_uid IS NOT NULL;
