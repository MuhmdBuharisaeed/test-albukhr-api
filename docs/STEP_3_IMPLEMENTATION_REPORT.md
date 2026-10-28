ALBUKHR Global Treasury — Step 3 implementation report
Date: 28 October 2026
Scope: Testnet Supabase live schema verification, Testnet API router draft, and frontend payment client draft only.
1. Live Testnet Supabase migrations applied
These four migrations were added in this step and verified through the Supabase integration:
20261028162116_testnet_global_treasury_owner_fee_after_approval_guard_v1
Added a gate so a project-owner fee assessment must refer to an owner withdrawal in approved or processing state.
20261028162147_testnet_global_treasury_idempotent_withdrawal_prepare_v1
Added nullable withdrawal_requests.client_request_key, a partial unique Testnet index, and create_testnet_withdrawal_idempotent(...).
A retry with the same key returns the original row only if stake ID, withdrawal type, amount, and wallet match; key reuse with different details is rejected.
Existing records were not updated or deleted.
20261028162549_testnet_global_treasury_owner_fee_existing_guard_v2
Corrected eligibility-check order so an old owner fee assessment cannot be returned to bypass the owner approval gate.
20261028162932_testnet_global_treasury_fee_payment_attempts_v1
Added testnet_outflow_fee_payment_attempts with Testnet-only network constraint, RLS, service-role-only access, unique payment ID, and a partial unique index permitting only one active (reserved/approved) attempt for each fee assessment.
Added server-only RPCs to reserve an attempt, record approval, and record verified cancellation.
Replaced mark_testnet_outflow_fee_paid(...) so the assessment and attempt are marked paid together with an idempotent platform fee ledger entry only after an attempt exists and its U2A payment is verified by the API.
The complete seven-migration package includes these changes plus the three previous Step 1/Step 2 migrations. The Supabase migration history confirms the fourth migration as version 20261028162932.
2. Database verification
Verified after the last migration:
testnet_global_treasury_policy.active = false.
Policy version remains 1; minimum project liquidity remains 100 Pi; allowed durations remain [30, 90, 180, 365, 730, 1095].
testnet_outflow_fee_payment_attempts exists, has RLS enabled, has the active-attempt unique index, and cannot be read by anon or authenticated.
The fee-attempt and fee-assessment RPCs are SECURITY DEFINER, use search_path=public, deny EXECUTE to anon/authenticated, and grant EXECUTE to service_role only.
Testnet row counts remain zero for withdrawal_requests, project_owner_withdrawals, testnet_outflow_fee_assessments, testnet_platform_fee_ledger, and testnet_outflow_fee_payment_attempts.
No existing stake terms or financial records were modified. No Pi payment or payout was initiated.
3. API router draft
test-albukhr-api/testnet-outflow-fee-router.js adds these endpoints when mounted by the documented server.js patch:
POST /outflow-fee/withdrawal/prepare — idempotently prepares a staker request and obtains the server-side fee assessment; does not pay out.
POST /outflow-fee/withdrawal/assess — retries assessment after an interrupted response.
POST /outflow-fee/owner/prepare-payment — only allows a project owner to prepare a fee for an independently approved owner withdrawal.
POST /outflow-fee/approve — validates the official Pi Testnet U2A payment, reserves a single active attempt, then asks Pi to approve it.
POST /outflow-fee/complete — re-reads the official Pi payment, validates completion/transaction/txid, and only then writes paid state and the platform fee ledger.
POST /outflow-fee/cancel — frees an attempt only if the official Pi API shows the matching U2A payment as cancelled; browser callbacks alone are not trusted.
POST /outflow-fee/withdrawal/execute — checks fee readiness before atomically claiming a pending withdrawal and sending the existing Testnet payout; processing/uncertain requests are sent to reconciliation rather than retried automatically.
The existing server.js also needs the documented pre-payout fee preflight in /pay-withdraw before the legacy manual payout. Otherwise Pi could leave the wallet before the new settlement contract rejects the missing fee assessment. The existing /withdraw HTTP 423 safety lock must remain.
4. Frontend client draft
test-albukhr-app/js/testnet-global-treasury-payment-client.js mirrors the existing Testnet Pi payment pattern:
strict test.albukhr.com / testnet guard;
short-lived Testnet session plus Pi identity validation;
Pi access token kept in memory only;
payment metadata is bound to the fee assessment and outflow source;
calls /cancel on cancel callback and attempts official cancellation recovery for incomplete payments;
it is not automatically initialized and is not added to investor.html yet.
5. Local mock test results
Commands run successfully:
node --check testnet-outflow-fee-router.js
node --check testnet-global-treasury-payment-client.js
node tests/router-inactive-policy-smoke.js
The mocked test confirmed:
seven endpoints are registered;
withdrawal preparation fails closed with HTTP 423 when the policy is inactive;
a fee payment whose amount differs from the official assessment is rejected before Pi approval is called;
an officially cancelled payment releases its attempt;
the mock payout and settlement helpers are never called.
These are local/mock tests only. A real Pi Testnet U2A payment and payout end-to-end test has not been performed.
6. Repository and Render status
Reviewed server.js SHA: 2e79720f63abf28492233d6c33847947d3f5c573; file has more than 1,000 lines, so the instructions are an insert-only patch with exact anchors.
GitHub branch creation returned HTTP 403 Resource not accessible by integration. No code file was committed and no pull request was opened.
Render test-albukhr-api remains autoDeploy=no, trigger off. No deployment was triggered and no environment variables/secrets were changed.
The latest queried Render log interval (28 October 2026, 15:30–16:30 UTC) returned no entries. This is not evidence of a live payment test; it means no entries were available for that time range.
investor.html remains locked, and no Mainnet code, data, configuration, or payment flow was changed.
7. Remaining release gates
Restore/confirm GitHub write access, then place the router/client/migrations in their exact repository paths and apply the server.js patches after rechecking the source SHA.
Run syntax and mock tests from the repository roots.
Verify Pi Developer Portal Sandbox/Testnet app configuration and perform a controlled U2A fee payment on Testnet.
Test same-payment retries, a different payment ID while an attempt is active, cancellation before/after approval, incomplete payment recovery, and confirmed fee ledger idempotency.
Verify payout preflight, deterministic memo reconciliation, reserve coverage, and no double payout on uncertain responses.
Keep policy inactive and both investor withdrawals and staking disabled until all end-to-end tests pass.
