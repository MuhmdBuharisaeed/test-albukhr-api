-- ALBUKHR Testnet project staking enablement audit FK indexes v1
-- Performance-only additive migration. Testnet project only.
BEGIN;

CREATE INDEX IF NOT EXISTS testnet_project_staking_enablement_audit_admin_session_idx
  ON public.testnet_project_staking_enablement_audit(admin_session_id);

CREATE INDEX IF NOT EXISTS testnet_project_staking_enablement_audit_risk_control_idx
  ON public.testnet_project_staking_enablement_audit(risk_control_id);

COMMIT;
