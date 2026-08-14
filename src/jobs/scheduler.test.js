'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
process.env.TRIGGER_MODE = 'accumulation';
process.env.CLAIM_EVERY_ETH = '0.05';
delete require.cache[require.resolve('../config')];

const scheduler = require('./scheduler');
const simvault = require('../evm/simvault');

test('pause blocks a poll and resume unblocks it', async () => {
  scheduler.pause();
  const r = await scheduler.pollOnce('poll');
  assert.strictEqual(r.ran, false);
  assert.strictEqual(r.reason, 'paused');
  scheduler.resume();
  assert.strictEqual(scheduler.getState().paused, false);
});

test('accumulation mode holds below the threshold', async () => {
  simvault.reset(0.001);
  const r = await scheduler.pollOnce('poll');
  assert.strictEqual(r.ran, false);
  assert.match(r.reason, /below accumulation threshold/);
});

test('getState reports the configured trigger', () => {
  const s = scheduler.getState();
  assert.strictEqual(s.triggerMode, 'accumulation');
  assert.strictEqual(s.claimEveryEth, 0.05);
});
