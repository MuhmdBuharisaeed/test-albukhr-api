ALBUKHR TESTNET GLOBAL TREASURY — STEP 3 PACKAGE
Date: 28 October 2026

SCOPE
- Testnet only: Supabase project vhvkwvngmrlgyzwemttt.
- API repository: MuhmdBuharisaeed/test-albukhr-api.
- Frontend repository: MuhmdBuharisaeed/test-albukhr-app.
- No Mainnet files, database, payments, API configuration, secrets, or deployment were changed.

CONTENTS
- test-albukhr-api/testnet-outflow-fee-router.js: new Express router. Copy to the API repo root, next to server.js.
- test-albukhr-app/js/testnet-global-treasury-payment-client.js: Testnet-only Pi SDK client. Do not load it into investor.html until reviewed and tested.
- patches/server-js-integration-patch.md: exact import, mount, and pre-payout guard insertions for server.js (>1,000 lines).
- supabase/migrations/: all seven migration SQL files used for the Global Treasury work to date.
- docs/STEP_3_IMPLEMENTATION_REPORT.md: changes, verification and release gates.
- docs/TESTNET_VERIFICATION_QUERIES.sql: read-only checks for policy, grants, functions, and row counts.
- tests/router-inactive-policy-smoke.js: local mock test; no live Pi payment or payout is sent.

LIVE DATABASE STATUS
The migrations in this package have already been applied to Testnet Supabase and verified. Do not paste them into the live SQL editor and re-run them manually. Preserve their exact filenames when synchronizing the repository migration history. Check Supabase migration history before using any schema deployment tool.

RELEASE LOCKS
- testnet_global_treasury_policy.active remains false.
- Existing API /withdraw route must keep its HTTP 423 safety lock.
- investor.html remains locked; do not load the new client there yet.
- Render auto-deploy remains off; no deployment was triggered.
- No GitHub changes were made because the GitHub integration returned HTTP 403 when attempting branch creation. These code files are drafts in this ZIP, not committed or deployed.
- No testnet withdrawal, fee assessment, payment attempt, or platform fee ledger rows were created. No Pi payment/payout was initiated.
