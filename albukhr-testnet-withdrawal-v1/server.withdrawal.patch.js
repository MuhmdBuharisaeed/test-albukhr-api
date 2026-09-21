ALBUKHR Testnet Withdrawal v1 — ZIP Package
Scope
This package is for test-albukhr-api only.
It integrates the Testnet Supabase withdrawal contract that has already been applied:
create_testnet_withdrawal
claim_testnet_withdrawal
It does not modify Mainnet.
Files
server.withdrawal.patch.js — exact integration blocks for the existing server.js.
DEPLOYMENT_CHECKLIST.md — safe deployment and verification sequence.
Why this is a patch
The current GitHub integration does not have write permission to the test-albukhr-api repository, so the package is prepared locally rather than being pushed directly to GitHub.
The existing API server should be retained as the base. The patch adds the withdrawal flow without replacing unrelated endpoints.
Withdrawal rules
The database remains the source of truth for the financial rules:
minimum wallet receive: 0.50 Pi
service fee: 1%
minimum service fee: 0.01 Pi
requested amount is the amount the user receives
fee is added on top
reward withdrawal is allowed before unlock
capital withdrawal requires unlock_at to be reached
requested amount + fee must not exceed available amount
The API passes the requested receive amount to the RPC; it does not override those rules.
Payout safety
Every payout gets a deterministic Stellar text memo:
ALB- + first 24 hexadecimal characters of SHA-256(request ID)
That produces a 28-character text memo.
Before submitting a new payout, the API searches recent transactions from the Testnet payout wallet for that memo. If it finds the memo, it records the existing transaction instead of sending another payment.
This is specifically intended to handle the dangerous case where the Pi Testnet transaction succeeds but the API process dies before the database is updated.
Required server environment
Keep the existing variables:
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
PI_API_KEY
WALLET_PRIVATE_SEED
TESTNET_ADMIN_API_KEY
TESTNET_ORIGIN
PI_HORIZON_URL
TESTNET_WALLET_PUBLIC_KEY
Optional:
TESTNET_WITHDRAWAL_RECONCILE_LIMIT — default 100, bounded to 20..200.
Browser endpoint
Authenticated Testnet browser:
POST /withdraw
Bearer token: opaque Testnet session token.
Body:
{
  "stakeId": "STAKE_UUID",
  "withdrawalType": "reward",
  "requestedAmount": 5,
  "walletAddress": "G..."
}
walletAddress can be omitted if the verified Testnet session already has the wallet address.
Important
Do not put:
WALLET_PRIVATE_SEED
SUPABASE_SERVICE_ROLE_KEY
PI_API_KEY
TESTNET_ADMIN_API_KEY
into frontend JavaScript.
