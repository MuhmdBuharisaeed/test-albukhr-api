ALTER TABLE public.users ADD COLUMN IF NOT EXISTS testnet_pi_uid text;
CREATE UNIQUE INDEX IF NOT EXISTS users_testnet_pi_uid_unique
  ON public.users (testnet_pi_uid)
  WHERE network = 'testnet' AND testnet_pi_uid IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.testnet_identity_link_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network text NOT NULL DEFAULT 'testnet' CHECK (network = 'testnet'),
  testnet_pi_uid text NOT NULL,
  username text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  target_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_by text,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  UNIQUE (network, testnet_pi_uid)
);
ALTER TABLE public.testnet_identity_link_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.testnet_identity_link_requests FROM anon, authenticated;
GRANT ALL ON TABLE public.testnet_identity_link_requests TO service_role;
