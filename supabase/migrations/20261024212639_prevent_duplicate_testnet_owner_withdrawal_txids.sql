CREATE UNIQUE INDEX IF NOT EXISTS project_owner_withdrawals_txid_unique
ON public.project_owner_withdrawals (network, lower(btrim(txid)))
WHERE nullif(btrim(coalesce(txid, '')), '') IS NOT NULL;
