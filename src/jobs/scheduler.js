'use strict';

const cron = require('node-cron');
const config = require('../config');
const { runCycle } = require('./cycle');
const { getLaunch } = require('../evm/launch');
const { escrowBalanceEth } = require('../evm/escrow');
const { sweepableEth } = require('../evm/sweep');
const { getEthPriceUsd } = require('../evm/price');
const bus = require('../events');

const state = {
  task: null, paused: false, isRunning: false,
  lastRunAt: null, lastResult: null, lastClaimable: null, lastClaimableUsd: null, startedAt: null, lastPhase: null,
  // Post-graduation only pons's operator may sweep; until one succeeds again,
  // pending fees are reported but not counted as ours to spend.
  sweepLocked: false, pendingSweepEth: null,
};

/**
 * Pure: how much of a claim this bot can actually reach right now.
 *
 * Normally the escrow PLUS what a sweep would move into it: counting the
 * escrow alone deadlocks, because before the first sweep it is zero while the
 * fees sit on the curve or the hook, so the bot would never fire and never
 * sweep.
 *
 * After graduation, though, pons's own operator has to do the sweeping, and
 * the pending fees are then NOT reachable. Counting them anyway is what made
 * cycles 19-22 fire every minute, claim 0 and record an empty cycle each time
 * — it looked like $100 was waiting when nothing was. Once a sweep has been
 * refused as operator-only, only the escrow counts, until a sweep succeeds
 * again. The pending amount is still reported, just not as ours to spend.
 */
function reachable({ inEscrow, pending, sweepLocked }) {
  return sweepLocked ? inEscrow : inEscrow + pending;
}

/**
 * What a cycle could realistically collect right now.
 * @param {object} deps Optional overrides for testing: { dryRun, tokenAddress, escrowBalanceEth, sweepableEth, getLaunch, sweepLocked }
 */
async function getClaimableEth(deps = {}) {
  const dryRun = deps.dryRun !== undefined ? deps.dryRun : config.dryRun;
  const readEscrow = deps.escrowBalanceEth || escrowBalanceEth;
  const readSweepable = deps.sweepableEth || sweepableEth;
  const readLaunch = deps.getLaunch || getLaunch;
  const token = deps.tokenAddress !== undefined ? deps.tokenAddress : config.tokenAddress;
  const sweepLocked = deps.sweepLocked !== undefined ? deps.sweepLocked : state.sweepLocked;

  if (dryRun) return readEscrow();
  if (!token) return 0;
  const launch = await readLaunch();
  state.lastPhase = launch.graduated ? 'v4' : 'curve';
  const [inEscrow, pending] = await Promise.all([readEscrow(), readSweepable(launch)]);
  state.pendingSweepEth = pending;
  return reachable({ inEscrow, pending, sweepLocked });
}

/**
 * Pure: did this cycle's sweep get refused because only pons may sweep?
 *
 * Read off the recorded step rather than a thrown error: the sweep is
 * best-effort and never throws, so its refusal is only visible here.
 */
function sweepWasOperatorLocked(cycle) {
  const step = (cycle && cycle.steps) ? cycle.steps.find((s) => s.name === 'sweep') : null;
  if (!step) return null; // no sweep step: nothing learned
  if (step.status !== 'skipped') return false; // a sweep went through
  return /operator/i.test(String((step.detail && step.detail.reason) || ''));
}

/**
 * Pure: does this claim clear the accumulation gate?
 *
 * The operator sets the gate in DOLLARS (CLAIM_EVERY_USD), because that is what
 * "worth paying out" means and it keeps its meaning as ETH's price moves. The
 * ETH gate is the fallback for two cases: the USD gate turned off (0), and a
 * briefly unavailable ETH price — a price outage must not hold fees forever,
 * and unclaimed fees keep accruing either way.
 *
 * @returns {{fire: boolean, reason: string, usd: number|null}}
 */
function accumulationGate({ claimable, claimEveryUsd, claimEveryEth, ethUsd }) {
  const priced = typeof ethUsd === 'number' && Number.isFinite(ethUsd) && ethUsd > 0;
  if (claimEveryUsd > 0 && priced) {
    const usd = claimable * ethUsd;
    return usd >= claimEveryUsd
      ? { fire: true, reason: `threshold met ($${usd.toFixed(2)} >= $${claimEveryUsd})`, usd }
      : { fire: false, reason: `below accumulation threshold ($${usd.toFixed(2)} < $${claimEveryUsd})`, usd };
  }
  const why = claimEveryUsd > 0 ? ' — no ETH price, using the ETH gate' : '';
  return claimable >= claimEveryEth
    ? { fire: true, reason: `threshold met (${claimable} >= ${claimEveryEth} ETH)${why}`, usd: null }
    : { fire: false, reason: `below accumulation threshold (${claimable} < ${claimEveryEth} ETH)${why}`, usd: null };
}

async function pollOnce(trigger, deps = {}) {
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
    const dryRun = deps.dryRun !== undefined ? deps.dryRun : config.dryRun;
    const triggerMode = deps.triggerMode !== undefined ? deps.triggerMode : config.triggerMode;
    const claimEveryEth = deps.claimEveryEth !== undefined ? deps.claimEveryEth : config.claimEveryEth;
    const cycle_fn = deps.runCycle || runCycle;

    if (dryRun) {
      // Simulate fees arriving so cycles have something to work with.
      require('../evm/simvault').accrue(config.dryRunFeePerPoll);
    }
    const claimable = await getClaimableEth(deps);
    state.lastClaimable = claimable;
    if (!(claimable > 0)) return { ran: false, claimable, reason: 'nothing claimable' };

    if (triggerMode === 'accumulation') {
      const claimEveryUsd = deps.claimEveryUsd !== undefined ? deps.claimEveryUsd : config.claimEveryUsd;
      const readPrice = deps.getEthPriceUsd || getEthPriceUsd;
      const ethUsd = claimEveryUsd > 0 ? await readPrice().catch(() => null) : null;
      const gate = accumulationGate({ claimable, claimEveryUsd, claimEveryEth, ethUsd });
      state.lastClaimableUsd = gate.usd;
      if (!gate.fire) return { ran: false, claimable, usd: gate.usd, reason: gate.reason };
    }

    state.lastRunAt = new Date().toISOString();
    const cycle = await cycle_fn();
    state.lastResult = { id: cycle.id, status: cycle.status };

    // What this cycle learned about who may sweep. Only logged on a CHANGE:
    // the poll runs every minute and this would otherwise repeat forever.
    const locked = sweepWasOperatorLocked(cycle);
    if (locked !== null && locked !== state.sweepLocked) {
      state.sweepLocked = locked;
      console.log(locked
        ? `[scheduler] pons's operator must sweep this pool now — only the escrow counts toward the gate (${state.pendingSweepEth ?? '?'} ETH pending on the hook)`
        : '[scheduler] sweeping works again — pending fees count toward the gate');
    }
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
  const gate = config.triggerMode === 'accumulation'
    ? (config.claimEveryUsd > 0 ? ` threshold=${config.claimEveryUsd} (fallback ${config.claimEveryEth} ETH)` : ` threshold=${config.claimEveryEth} ETH`)
    : '';
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
    triggerMode: config.triggerMode, pollSchedule: config.pollSchedule,
    claimEveryUsd: config.claimEveryUsd, claimEveryEth: config.claimEveryEth,
    paused: state.paused, isRunning: state.isRunning, lastRunAt: state.lastRunAt,
    lastResult: state.lastResult, lastClaimable: state.lastClaimable,
    lastClaimableUsd: state.lastClaimableUsd, phase: state.lastPhase,
    sweepLocked: state.sweepLocked, pendingSweepEth: state.pendingSweepEth,
    startedAt: state.startedAt,
  };
}

// Test helper — reset scheduler state to a clean slate
function _resetState() {
  state.task = null;
  state.paused = false;
  state.isRunning = false;
  state.lastRunAt = null;
  state.lastResult = null;
  state.lastClaimable = null;
  state.lastClaimableUsd = null;
  state.sweepLocked = false;
  state.pendingSweepEth = null;
  state.startedAt = null;
  state.lastPhase = null;
}

module.exports = {
  start, pause, resume, triggerNow, pollOnce, getState, getClaimableEth,
  accumulationGate, reachable, sweepWasOperatorLocked, _resetState,
};
