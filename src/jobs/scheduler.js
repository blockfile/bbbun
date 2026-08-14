'use strict';

const cron = require('node-cron');
const config = require('../config');
const { runCycle } = require('./cycle');
const { getLaunch } = require('../evm/launch');
const { escrowBalanceEth } = require('../evm/escrow');
const { sweepableEth } = require('../evm/sweep');
const bus = require('../events');

const state = {
  task: null, paused: false, isRunning: false,
  lastRunAt: null, lastResult: null, lastClaimable: null, startedAt: null, lastPhase: null,
};

/**
 * What a cycle could realistically collect right now: what is already in the
 * escrow PLUS what a sweep would move into it. Reading the escrow alone
 * deadlocks — before the first sweep it is zero while the fees sit on the
 * curve or the hook, so the bot would never fire and never sweep.
 */
async function getClaimableEth() {
  if (config.dryRun) return escrowBalanceEth();
  if (!config.tokenAddress) return 0;
  const launch = await getLaunch();
  state.lastPhase = launch.graduated ? 'v4' : 'curve';
  const [inEscrow, pending] = await Promise.all([escrowBalanceEth(), sweepableEth(launch)]);
  return inEscrow + pending;
}

async function pollOnce(trigger) {
  if (state.paused) return { ran: false, reason: 'paused' };
  if (state.isRunning) {
    console.log(`[scheduler] ${trigger} tick ignored — a cycle is already running`);
    return { ran: false, reason: 'cycle already running' };
  }

  // Hold the run flag across the balance read too, so a manual POST /api/run
  // landing between the read and the cycle cannot spawn a second concurrent
  // cycle and contend for the wallet nonce.
  state.isRunning = true;
  try {
    if (config.dryRun) {
      // Simulate fees arriving so cycles have something to work with.
      require('../evm/simvault').accrue(config.dryRunFeePerPoll);
    }
    const claimable = await getClaimableEth();
    state.lastClaimable = claimable;
    if (!(claimable > 0)) return { ran: false, claimable, reason: 'nothing claimable' };

    if (config.triggerMode === 'accumulation' && claimable < config.claimEveryEth) {
      return { ran: false, claimable, reason: `below accumulation threshold (${claimable} < ${config.claimEveryEth} ETH)` };
    }

    state.lastRunAt = new Date().toISOString();
    const cycle = await runCycle();
    state.lastResult = { id: cycle.id, status: cycle.status };
    return { ran: true, claimable, cycle };
  } finally {
    state.isRunning = false;
  }
}

function start() {
  if (state.task) return;
  if (!cron.validate(config.pollSchedule)) throw new Error(`Invalid POLL_SCHEDULE: ${config.pollSchedule}`);
  state.startedAt = new Date().toISOString();
  state.task = cron.schedule(config.pollSchedule, () => {
    pollOnce('poll').catch((err) => console.error('[scheduler] poll error:', err));
  });
  const gate = config.triggerMode === 'accumulation' ? ` threshold=${config.claimEveryEth} ETH` : '';
  console.log(`[scheduler] started — mode="${config.triggerMode}" schedule="${config.pollSchedule}"${gate} (dryRun=${config.dryRun})`);
}

function pause() { state.paused = true; const s = getState(); bus.emit('scheduler', s); return s; }
function resume() { state.paused = false; const s = getState(); bus.emit('scheduler', s); return s; }

async function triggerNow() {
  if (state.isRunning) return { skipped: true, reason: 'cycle already running' };
  state.isRunning = true;
  state.lastRunAt = new Date().toISOString();
  try {
    const cycle = await runCycle();
    state.lastResult = { id: cycle.id, status: cycle.status };
    return cycle;
  } finally {
    state.isRunning = false;
  }
}

function getState() {
  return {
    triggerMode: config.triggerMode, pollSchedule: config.pollSchedule, claimEveryEth: config.claimEveryEth,
    paused: state.paused, isRunning: state.isRunning, lastRunAt: state.lastRunAt,
    lastResult: state.lastResult, lastClaimable: state.lastClaimable, phase: state.lastPhase,
    startedAt: state.startedAt,
  };
}

module.exports = { start, pause, resume, triggerNow, pollOnce, getState, getClaimableEth };
