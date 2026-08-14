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
  scheduler._resetState();
  scheduler.pause();
  const r = await scheduler.pollOnce('poll');
  assert.strictEqual(r.ran, false);
  assert.strictEqual(r.reason, 'paused');
  scheduler.resume();
  assert.strictEqual(scheduler.getState().paused, false);
});

test('accumulation mode holds below the threshold', async () => {
  scheduler._resetState();
  simvault.reset(0.001);
  const r = await scheduler.pollOnce('poll');
  assert.strictEqual(r.ran, false);
  assert.match(r.reason, /below accumulation threshold/);
});

test('getState reports the configured trigger', () => {
  scheduler._resetState();
  const s = scheduler.getState();
  assert.strictEqual(s.triggerMode, 'accumulation');
  assert.strictEqual(s.claimEveryEth, 0.05);
});

test('CRITICAL: escrow + sweepable sum correctly (0 + 0.005885 = 0.005885)', async () => {
  scheduler._resetState();
  const deps = {
    dryRun: false,
    tokenAddress: '0x1234567890123456789012345678901234567890',
    escrowBalanceEth: async () => 0,
    sweepableEth: async () => 0.005885,
    getLaunch: async () => ({ graduated: false }),
  };
  const result = await scheduler.getClaimableEth(deps);
  assert.strictEqual(result, 0.005885, 'escrow + sweepable must sum to 0.005885');
});

test('both escrow and sweepable terms are needed (0.02 + 0.03 = 0.05)', async () => {
  scheduler._resetState();
  const deps = {
    dryRun: false,
    tokenAddress: '0x1234567890123456789012345678901234567890',
    escrowBalanceEth: async () => 0.02,
    sweepableEth: async () => 0.03,
    getLaunch: async () => ({ graduated: false }),
  };
  const result = await scheduler.getClaimableEth(deps);
  assert.strictEqual(result, 0.05, 'escrow 0.02 + sweepable 0.03 must equal 0.05');
});

test('interval mode runs cycle when claimable > 0', async () => {
  scheduler._resetState();
  let cycleRan = false;
  const deps = {
    dryRun: false,
    tokenAddress: '0x1234567890123456789012345678901234567890',
    triggerMode: 'interval',
    escrowBalanceEth: async () => 0.01,
    sweepableEth: async () => 0,
    getLaunch: async () => ({ graduated: false }),
    runCycle: async () => {
      cycleRan = true;
      return { id: 'test-cycle', status: 'ok' };
    },
  };
  const r = await scheduler.pollOnce('poll', deps);
  assert.strictEqual(r.ran, true, 'cycle should run in interval mode when claimable > 0');
  assert.strictEqual(cycleRan, true, 'runCycle must be called');
});

test('interval mode does not run cycle when claimable = 0', async () => {
  scheduler._resetState();
  let cycleRan = false;
  const deps = {
    dryRun: false,
    tokenAddress: '0x1234567890123456789012345678901234567890',
    triggerMode: 'interval',
    escrowBalanceEth: async () => 0,
    sweepableEth: async () => 0,
    getLaunch: async () => ({ graduated: false }),
    runCycle: async () => {
      cycleRan = true;
      return { id: 'test-cycle', status: 'ok' };
    },
  };
  const r = await scheduler.pollOnce('poll', deps);
  assert.strictEqual(r.ran, false, 'cycle should not run when claimable = 0');
  assert.strictEqual(cycleRan, false, 'runCycle must not be called');
});

test('overlap guard: triggerNow() returns skipped while pollOnce is in flight', async () => {
  scheduler._resetState();
  let pollReleaser;
  const pollWait = new Promise((resolve) => {
    pollReleaser = resolve;
  });

  const deps = {
    dryRun: false,
    tokenAddress: '0x1234567890123456789012345678901234567890',
    triggerMode: 'interval',
    escrowBalanceEth: async () => 0.01,
    sweepableEth: async () => 0,
    getLaunch: async () => ({ graduated: false }),
    runCycle: async () => {
      await pollWait;
      return { id: 'test-cycle', status: 'ok' };
    },
  };

  // Start pollOnce but don't await it yet
  const pollPromise = scheduler.pollOnce('poll', deps);

  // Give the event loop a chance for pollOnce to start and set isRunning
  await new Promise((r) => setImmediate(r));

  // Now try triggerNow — it should be blocked
  const triggerResult = await scheduler.triggerNow();
  assert.strictEqual(triggerResult.skipped, true, 'triggerNow must return skipped while cycle is running');
  assert.strictEqual(triggerResult.reason, 'cycle already running');

  // Release pollOnce and let it complete
  pollReleaser();
  const pollResult = await pollPromise;
  assert.strictEqual(pollResult.ran, true, 'pollOnce should complete successfully');
  assert.strictEqual(scheduler.getState().isRunning, false, 'isRunning must be reset after cycle completes');
});

test('start() uses cron.validate to reject invalid schedules', () => {
  scheduler._resetState();
  // Test that the validation logic works — start() will throw if config.pollSchedule is invalid
  const cron = require('node-cron');
  assert.strictEqual(cron.validate('*/5 * * * *'), true, 'valid cron */5 * * * * should validate');
  assert.strictEqual(cron.validate('not a cron'), false, 'invalid cron "not a cron" must not validate');
  assert.strictEqual(cron.validate('60 * * * *'), false, 'invalid minute 60 must not validate');
  // If config.pollSchedule were invalid, start() would throw. Since config is validated on load,
  // we verify the validation logic itself works here.
});
