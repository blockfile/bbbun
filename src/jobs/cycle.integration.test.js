'use strict';

// End-to-end runCycle, executed — not asserted at the source level.
//
// Two things make this worth its weight:
//   1. The RPC URL below is a BLACK HOLE. Under DRY_RUN every chain call is
//      supposed to be simulated, so any read that still goes to the network
//      shows up here as a failed cycle rather than as a nasty surprise on a
//      real dry run. REWARD_CAP_PCT is set precisely to force the totalSupply()
//      read, which was the last unsimulated call.
//   2. The cycle's FINISHING STATUS is what the dashboard and the operator
//      believe. An airdrop that reached nobody must not read as 'complete'.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.DRY_RUN = 'true';
process.env.RPC_URL = 'http://127.0.0.1:1'; // nothing listens here, by design
process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000a1b69';
process.env.REWARD_BUY_PCT = '70';
process.env.BURN_PCT = '20';
process.env.REWARD_CAP_PCT = '2'; // forces the supply read (M1)
process.env.MIN_HOLD = '100000';
process.env.DRY_RUN_FEE_PER_POLL = '0'; // the simulated vault is set per test
process.env.DISPERSE_ADDRESS = '';

// Seams: both modules are patched BEFORE cycle.js is required, because cycle.js
// destructures these functions at require time. Each defaults to the real
// (DRY_RUN-simulated) implementation and is overridden only where a test needs
// a failure that DRY_RUN will never produce on its own.
const holdersMod = require('../evm/holders');
const airdropMod = require('../evm/airdrop');
const realSnapshot = holdersMod.snapshotEligibleHolders;
const realAirdrop = airdropMod.airdropToken;
let snapshotOverride = null;
let airdropOverride = null;
holdersMod.snapshotEligibleHolders = (o) => (snapshotOverride || realSnapshot)(o);
airdropMod.airdropToken = (o) => (airdropOverride || realAirdrop)(o);

const config = require('../config');
const db = require('../db');
const { runCycle } = require('./cycle');
const simvault = require('../evm/simvault');

let mongod;

before(async () => {
  mongod = await MongoMemoryServer.create();
  // config was already frozen in place by the requires above, so point it at
  // the in-memory server here rather than through the environment.
  config.mongoUri = mongod.getUri();
  config.mongoDb = 'bbbun_test_cycle';
  await db.connect();
});

after(async () => {
  snapshotOverride = null;
  airdropOverride = null;
  await db.close();
  await mongod.stop();
});

test('a full DRY_RUN cycle completes without one live chain call', async () => {
  simvault.reset(0.01);
  const cycle = await runCycle();

  assert.strictEqual(cycle.status, 'complete', cycle.error || '');
  assert.ok(!/ECONNREFUSED|fetch|network/i.test(String(cycle.error || '')), 'no chain call may escape DRY_RUN');
  assert.ok(Math.abs(cycle.eth_claimed - 0.01) < 1e-12);
  assert.ok(Math.abs(cycle.eth_spent_buy - 0.007) < 1e-12, `reward leg: ${cycle.eth_spent_buy}`); // 70%
  assert.ok(Math.abs(cycle.eth_spent_burn - 0.002) < 1e-12, `burn leg: ${cycle.eth_spent_burn}`); // 20%
  assert.ok(cycle.tokens_bought > 0);

  const names = cycle.steps.map((s) => s.name);
  // 'burn' runs last: BBC is bought and sent to 0x…dEaD only after holders are paid.
  assert.deepStrictEqual(names, ['sweep', 'claim', 'buy', 'airdrop', 'burn']);
  const burn = cycle.steps.find((s) => s.name === 'burn');
  assert.strictEqual(burn.status, 'ok');
  assert.ok(burn.detail.tokensBurned > 0, 'the burn leg bought and burned BBC');
  assert.strictEqual(burn.detail.deadAddress, '0x000000000000000000000000000000000000dead');
  assert.ok(cycle.tokens_burned > 0, 'and the cycle records it');
  assert.strictEqual(cycle.steps.find((s) => s.name === 'airdrop').status, 'ok');
  assert.match(cycle.note, /airdrop sent 2/); // two simulated holders clear MIN_HOLD
});

// C1, end to end: the exact escrow-dust cycle the reviewer reproduced. 7e-7 ETH
// claimed -> a 5.6e-7 ETH reward leg. This used to claim the ETH and THEN throw
// inside parseEther, failing the cycle after the money had already moved.
test('a dust claim skips the reward leg cleanly and still completes', async () => {
  simvault.reset(7e-7);
  const cycle = await runCycle();

  assert.strictEqual(cycle.status, 'complete', cycle.error || '');
  assert.strictEqual(cycle.eth_spent_buy, 0);
  const reward = cycle.steps.find((s) => s.name === 'reward');
  assert.ok(reward, 'the skip must be recorded as a step');
  assert.strictEqual(reward.status, 'skipped');
  assert.strictEqual(reward.detail.minRewardEth, config.minRewardEth);
  assert.match(cycle.note, /reward leg skipped/);
  assert.ok(!cycle.steps.some((s) => s.name === 'buy'), 'nothing may be bought below the floor');
});

// I1: with DISPERSE_ADDRESS set but no allowance, every batch reverts. The
// cycle used to record 'complete' anyway, so getStats().failed stayed 0 and the
// bot kept buying BUN every five minutes while none was ever delivered.
test('an airdrop that delivered nothing FAILS the cycle', async () => {
  simvault.reset(0.01);
  airdropOverride = async ({ allocations }) => ({ sent: 0, failed: allocations.length });
  try {
    const cycle = await runCycle();
    assert.strictEqual(cycle.status, 'failed');
    assert.match(cycle.error, /0 of 2 recipients/);
    assert.match(cycle.error, /DISPERSE_ADDRESS|approve\(\)/);
    assert.strictEqual(cycle.steps.find((s) => s.name === 'airdrop').status, 'failed');
  } finally {
    airdropOverride = null;
  }
});

test('a cycle with no eligible holders completes — it is not a failure', async () => {
  simvault.reset(0.01);
  snapshotOverride = async () => ({ holders: [], totalHolders: 0 });
  try {
    const cycle = await runCycle();
    assert.strictEqual(cycle.status, 'complete', cycle.error || '');
    assert.strictEqual(cycle.error, null);
    assert.match(cycle.note, /no eligible holders/);
  } finally {
    snapshotOverride = null;
  }
});

test('nothing claimable is recorded as skipped, with no transactions', async () => {
  simvault.reset(0);
  const cycle = await runCycle();
  assert.strictEqual(cycle.status, 'skipped');
  assert.match(cycle.note, /nothing claimed/);
});
