'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const routerPath = path.join(__dirname, '..', 'testnet-global-transaction-control-router.js');
const source = fs.readFileSync(routerPath, 'utf8');

const helperStart = source.indexOf('  function isStakingCoverageReady(');
const helperEnd = source.indexOf('  function hashToken(', helperStart);
assert(helperStart >= 0 && helperEnd > helperStart, 'coverage readiness helper exists');

const helperSource = source.slice(helperStart, helperEnd);
const clean = value => String(value == null ? '' : value).trim();
const numeric = value => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const isStakingCoverageReady = new Function(
  'clean',
  'numeric',
  helperSource + '\nreturn isStakingCoverageReady;'
)(clean, numeric);

assert(
  source.includes('const coverageReady = isStakingCoverageReady('),
  'approved project readiness uses the tested coverage helper'
);
assert(
  !helperSource.includes('owner_liquidity_available'),
  'does not impose the redundant owner-liquidity-equals-minimum condition'
);

const examples = [
  {
    name: 'DANKWALLIYA COSMETICS',
    ownerLiquidity: 99.80,
    rewards: 0.20,
    assets: 120.00,
    liabilities: 20.20
  },
  {
    name: 'MAITAGOGO TABLE WATER',
    ownerLiquidity: 99.40,
    rewards: 0.60,
    assets: 120.00,
    liabilities: 20.60
  },
  {
    name: 'RAHEEM PHARMACY',
    ownerLiquidity: 99.75,
    rewards: 0.25,
    assets: 125.00,
    liabilities: 25.25
  }
];

for (const item of examples) {
  const coverage = {
    staking_eligible: true,
    owner_liquidity_available: item.ownerLiquidity,
    liquidity_buffer: 100,
    verified_liquidity_contributed: 100,
    total_tracked_assets: item.assets,
    total_liability: item.liabilities,
    reward_reserve_balance: item.rewards,
    outstanding_rewards: item.rewards
  };
  assert.equal(
    isStakingCoverageReady(coverage, 100, 100, 100),
    true,
    item.name + ' passes when the database confirms an eligible 100 PI buffer'
  );
}

const valid = {
  staking_eligible: true,
  liquidity_buffer: 100,
  verified_liquidity_contributed: 100,
  total_tracked_assets: 120,
  total_liability: 20,
  reward_reserve_balance: 1,
  outstanding_rewards: 1
};
assert.equal(
  isStakingCoverageReady({ ...valid, staking_eligible: false }, 100, 100, 100),
  false,
  'rejects database-ineligible coverage'
);
assert.equal(
  isStakingCoverageReady({ ...valid, liquidity_buffer: 99.99 }, 100, 100, 100),
  false,
  'rejects a buffer below the global liquidity minimum'
);
assert.equal(
  isStakingCoverageReady({ ...valid, verified_liquidity_contributed: 99.99 }, 100, 100, 100),
  false,
  'rejects insufficient verified liquidity contribution'
);
assert.equal(
  isStakingCoverageReady({ ...valid, total_tracked_assets: 19 }, 100, 100, 100),
  false,
  'rejects assets below liabilities'
);
assert.equal(
  isStakingCoverageReady({ ...valid, reward_reserve_balance: 0.99 }, 100, 100, 100),
  false,
  'rejects insufficient reward reserve coverage'
);
assert.equal(
  isStakingCoverageReady({ ...valid, liquidity_buffer: null }, 100, 100, 100),
  false,
  'fails closed when a required financial value is missing'
);

console.log('PASS: Testnet staking liquidity-buffer readiness regression checks');
console.log('PASS: 3 affected project scenarios and 6 fail-closed scenarios');
