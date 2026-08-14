'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
delete require.cache[require.resolve('../config')];

const { escrowBalanceEth, claimFromEscrow } = require('./escrow');
const simvault = require('./simvault');

test('DRY_RUN: escrow balance reads the simulated vault without draining it', async () => {
  simvault.reset(0.25);
  assert.strictEqual(await escrowBalanceEth(), 0.25);
  assert.strictEqual(simvault.peek(), 0.25);
});

test('DRY_RUN: claim drains the vault and reports the amount', async () => {
  simvault.reset(0.5);
  const c = await claimFromEscrow();
  assert.strictEqual(c.simulated, true);
  assert.ok(Math.abs(c.ethClaimed - 0.5) < 1e-9);
  assert.strictEqual(simvault.peek(), 0);
  assert.match(c.signature, /^claim_/);
});

test('DRY_RUN: claiming an empty vault reports nothing to claim', async () => {
  simvault.reset(0);
  const c = await claimFromEscrow();
  assert.strictEqual(c.ethClaimed, 0);
});
