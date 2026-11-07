"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(
  path.resolve(__dirname, "../server.js"),
  "utf8"
);

const routeStart = server.indexOf(
  'app.get(\n  "/investor-data"'
);

const routeEnd = server.indexOf(
  "/* ============================================================\n   EXISTING PI ADMIN APPROVAL",
  routeStart
);

assert.ok(routeStart >= 0, "Investor data route is missing");
assert.ok(routeEnd > routeStart, "Investor route boundary is missing");

const route = server.slice(routeStart, routeEnd);

assert.match(
  route,
  /app\.get\(\s*["']\/investor-data["']\s*,\s*requireSession/
);

function getSelectFields(table) {
  const expression = new RegExp(
    "\\.from\\(\\s*[\"']" + table + "[\"']\\s*\\)\\s*" +
    "\\.select\\(\\s*[\"']([^\"']+)[\"']\\s*\\)"
  );

  const match = route.match(expression);

  assert.ok(match, table + " query or SELECT is missing");

  return match[1].split(",").map(value => value.trim());
}

const requiredFields = {
  stakes: [
    "id",
    "pi_uid",
    "network",
    "project_id",
    "project_code",
    "amount",
    "reward_amount",
    "status"
  ],
  withdrawal_requests: [
    "id",
    "pi_uid",
    "network",
    "stake_id",
    "project_id",
    "project_code",
    "withdrawal_type",
    "requested_amount",
    "fee_amount",
    "status",
    "txid"
  ]
};

for (const [table, required] of Object.entries(requiredFields)) {
  const fields = getSelectFields(table);

  for (const field of required) {
    assert.ok(
      fields.includes(field),
      table + " SELECT is missing " + field
    );
  }
}

const testnetFilters = (
  route.match(
    /\.eq\(\s*["']network["']\s*,\s*["']testnet["']\s*\)/g
  ) || []
).length;

const ownerFilters = (
  route.match(
    /\.eq\(\s*["']pi_uid["']\s*,\s*uid\s*\)/g
  ) || []
).length;

assert.ok(
  testnetFilters >= 3,
  "Stakes, withdrawals and projects must remain Testnet-filtered"
);

assert.ok(
  ownerFilters >= 2,
  "Stakes and withdrawals must remain scoped to the signed-in investor"
);

assert.match(
  route,
  /req\.testnetSession\.pi_uid/
);

console.log(
  "testnet-investor-data-contract: all checks passed"
);
