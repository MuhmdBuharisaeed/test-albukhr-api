"use strict";

const fs = require("fs");
const path = require("path");

const migrationPath = path.join(
  __dirname,
  "..",
  "supabase",
  "migrations",
  "20261107214500_testnet_expire_unstarted_stake_intents_v1.sql"
);

function assert(condition, message) {
  if (!condition) {
    console.error("FAIL:", message);
    process.exitCode = 1;
    return;
  }
  console.log("PASS:", message);
}

if (!fs.existsSync(migrationPath)) {
  console.error("FAIL: migration file is missing:", migrationPath);
  process.exit(1);
}

const sql = fs.readFileSync(migrationPath, "utf8");
const normalized = sql.replace(/\s+/g, " ").toLowerCase();

assert(
  normalized.includes("create or replace function public.expire_testnet_unstarted_stake_intents"),
  "defines the Testnet-only expiry function"
);
assert(
  normalized.includes("security definer") && normalized.includes("set search_path = ''"),
  "uses a fixed empty search_path for privileged execution"
);
assert(
  normalized.includes("i.network = 'testnet'") && normalized.includes("p.network = 'testnet'"),
  "restricts candidates to Testnet intents and Testnet projects"
);
assert(
  normalized.includes("i.status = 'pending_payment'") && normalized.includes("i.payment_id is null"),
  "only considers pending intents with no bound Pi payment ID"
);
assert(
  normalized.includes("i.expires_at <= pg_catalog.now()"),
  "only considers intents whose expiry time has passed"
);
assert(
  normalized.includes("i.metadata ->> 'payment_started' = 'false'") &&
    normalized.includes("i.metadata ->> 'payment_armed' = 'false'"),
  "excludes intents when payment has been started or armed"
);
assert(
  normalized.includes("for update skip locked") && normalized.includes("pg_advisory_xact_lock"),
  "uses row skipping and the per-project staking advisory lock"
);
assert(
  normalized.includes("'reward_reserve', 'debit', 'admin_adjustment'") &&
    normalized.includes("'owner_liquidity', 'credit', 'admin_adjustment'"),
  "reverses reward reservation with a balanced ledger pair"
);
assert(
  normalized.includes("'stake_intent_expiry'") &&
    normalized.includes("'expired_before_payment'") &&
    normalized.includes("set status = 'expired'"),
  "marks expiry with a distinct audit reason and status"
);
assert(
  normalized.includes("revoke all privileges") &&
    normalized.includes("from public, anon, authenticated, service_role") &&
    normalized.includes("to postgres"),
  "restricts function execution to the database scheduler role"
);
assert(
  normalized.includes("cron.schedule(") &&
    normalized.includes("'*/5 * * * *'") &&
    normalized.includes("public.expire_testnet_unstarted_stake_intents(100)"),
  "schedules bounded cleanup every five minutes"
);
assert(
  !/\bdelete\s+from\s+public\.(project_staking_ledger|testnet_stake_intents|stakes|testnet_stake_payments)\b/i.test(sql),
  "does not delete ledger, intent, stake, or payment history"
);
assert(
  !/\btruncate\s+table\b/i.test(sql),
  "does not truncate any table"
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
console.log("Testnet stake-intent expiry migration smoke checks passed.");
