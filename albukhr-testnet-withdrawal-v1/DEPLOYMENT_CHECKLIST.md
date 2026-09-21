Deployment Checklist — ALBUKHR Testnet Withdrawal v1
Back up the current server.js.
Apply server.withdrawal.patch.js to test-albukhr-api/server.js.
Run: node --check server.js
Confirm package.json already contains:
@supabase/supabase-js
axios
cors
express
stellar-sdk
Confirm the API environment contains:
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
PI_API_KEY
WALLET_PRIVATE_SEED
TESTNET_ADMIN_API_KEY
TESTNET_ORIGIN=https://test.albukhr.com
PI_HORIZON_URL=https://api.testnet.minepi.com unless intentionally overridden
Deploy/restart the Testnet API.
Check GET / returns network: "testnet".
Do not test with a real Mainnet wallet.
Use a Testnet stake and Testnet wallet.
Test a reward withdrawal at 0.50 Pi.
Confirm the database row transitions: pending -> processing -> completed
Confirm fee_amount is calculated by the database contract.
Confirm net_amount equals the user's requested receive amount.
Confirm the response includes the Testnet transaction hash.
If an API/database failure leaves a request in processing, call: POST /reconcile-withdraw
Never send another payout manually until reconciliation has checked the deterministic memo.
Keep Mainnet code and Mainnet Supabase untouched.
