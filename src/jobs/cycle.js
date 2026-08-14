'use strict';

// One reward cycle:
//
//   sweep pending fees into the escrow      (best-effort — may need pons's operator)
//   claim the escrow                        -> native ETH
//     -> REWARD_BUY_PCT: buy ROBBIE and airdrop it to BABY ROBBIE holders
//     -> remainder:      stays in the wallet as native ETH (dev cut + gas)
//
// There is deliberately NO burn leg: nothing here buys or burns BABY ROBBIE.
//
// Each step is recorded; a thrown step fails the cycle without crashing.

const config = require('../config');
const repo = require('../db/repository');
const { getLaunch, describePhase } = require('../evm/launch');
const { sweepFees } = require('../evm/sweep');
const { claimFromEscrow } = require('../evm/escrow');
const { buyToken } = require('../evm/buy');
const { getTokenSupplyRaw } = require('../evm/erc20');
const { snapshotEligibleHolders } = require('../evm/holders');
const { buildExcludeSet } = require('../evm/exclude');
const { computeWeightedAllocations } = require('../services/distribution');
const { airdropToken } = require('../evm/airdrop');

/**
 * Split a claim into its two legs. Pure, so the invariant that the legs re-add
 * to the claim is directly testable. The dev cut is the remainder and needs no
 * transaction — it is already native ETH sitting in the wallet.
 */
function splitClaim(claimedEth) {
  const rewardEth = +(claimedEth * (config.rewardBuyPct / 100)).toFixed(9);
  const devEth = +(claimedEth - rewardEth).toFixed(9);
  return { rewardEth, devEth };
}

/**
 * Is this wallet the address the launch actually pays creator fees to? Only
 * that address may sweep OR claim, in both phases, so a mismatch means the
 * cycle can never collect anything — silently, with no error anywhere.
 * Case-insensitive: the factory returns EIP-55 checksummed addresses.
 */
function isFeeRecipientOk(launch, address) {
  const want = String(address || '').toLowerCase();
  const got = String((launch && launch.creatorFeeRecipient) || '').toLowerCase();
  return want !== '' && got !== '' && want === got;
}

/** The operator-facing warning for a mismatch, or null when it is fine. */
function feeRecipientWarning(launch, address) {
  if (isFeeRecipientOk(launch, address)) return null;
  const got = (launch && launch.creatorFeeRecipient) || '(unset)';
  return (
    `creatorFeeRecipient MISMATCH: the launch pays creator fees to ${got}, ` +
    `but this bot's wallet is ${address || '(unset)'}. This cycle cannot claim — ` +
    'only the creatorFeeRecipient may sweep or claim, in both phases. ' +
    "Fix the token's creatorFeeRecipient or point WALLET_PRIVATE_KEY at it."
  );
}

// Last observed result of the check above, so GET /api/status can report it
// without making a chain call of its own. null until the first cycle runs.
let lastFeeRecipientCheck = null;
function getFeeRecipientCheck() {
  return lastFeeRecipientCheck;
}

/**
 * How a cycle finishes, given what the reward leg actually did. Pure, so both
 * the "airdrop reached nobody" and the "nobody was eligible" cases are
 * directly testable — they look identical in `sent` (0) and must not be
 * recorded identically.
 */
function summarizeReward(reward) {
  if (reward.skipped) {
    return { status: 'complete', note: `reward leg skipped: ${reward.reason}` };
  }
  if (!(reward.recipients > 0)) {
    return { status: 'complete', note: 'no eligible holders — nothing to airdrop' };
  }
  if (!(reward.sent > 0)) {
    return {
      status: 'failed',
      note: `airdrop reached 0 of ${reward.recipients} recipients`,
      error:
        `airdrop delivered nothing: 0 of ${reward.recipients} recipients received ${config.rewardSymbol} ` +
        `(${reward.failed} failed). Likely cause: DISPERSE_ADDRESS is set but this wallet has never ` +
        `approve()d ${config.rewardSymbol} to it, or the transfers are reverting. ` +
        `The ${config.rewardSymbol} bought this cycle is still sitting in the wallet.`,
    };
  }
  if (reward.failed > 0) {
    return { status: 'complete', note: `airdrop sent ${reward.sent}, ${reward.failed} failed` };
  }
  return { status: 'complete', note: `airdrop sent ${reward.sent}` };
}

/** Buy the reward token and airdrop it pro-rata to holders of the fee token. */
async function runRewardLeg(cycleId, { launch, rewardLaunch, ethAmount }) {
  const log = (m) => console.log(`[cycle ${cycleId}] [reward] ${m}`);

  const buy = await buyToken({ launch: rewardLaunch, token: config.rewardToken, ethAmount });
  await repo.addStep({
    cycleId, name: 'buy', status: 'ok', signature: buy.signature,
    detail: { leg: 'reward', token: config.rewardToken, ethSpent: ethAmount, tokensBought: buy.tokensBought, venue: buy.venue },
  });
  log(`bought ${buy.tokensBought} ${config.rewardSymbol} with ${ethAmount} ETH`);

  const minHoldRaw = (BigInt(Math.trunc(config.minHold)) * 10n ** 18n).toString();
  const exclude = await buildExcludeSet(launch);
  const { holders, totalHolders } = await snapshotEligibleHolders({ token: launch.token, minHoldRaw, exclude });
  log(`${holders.length} eligible holders (>= ${config.minHold}) of ${totalHolders} total`);

  const capPct = config.rewardCapPct > 0 ? config.rewardCapPct : null;
  const supplyRaw = capPct == null ? null : (await getTokenSupplyRaw(launch.token)).toString();
  const allocations = computeWeightedAllocations(holders, buy.tokensBoughtRaw || '0', { capPct, supplyRaw, clusters: config.clusters });
  const air = await airdropToken({ rewardToken: config.rewardToken, allocations, cycleId });
  await repo.addStep({
    cycleId, name: 'airdrop', status: air.failed ? 'failed' : 'ok',
    detail: { token: config.rewardToken, recipients: allocations.length, sent: air.sent, failed: air.failed },
  });
  log(`airdrop ${config.rewardSymbol} sent=${air.sent} failed=${air.failed}`);

  return {
    tokensBought: buy.tokensBought,
    recipients: allocations.length,
    sent: air.sent,
    failed: air.failed,
    eligibleHolders: holders.length,
    totalHolders,
  };
}

async function runCycle() {
  const id = await repo.createCycle({ dryRun: config.dryRun });
  const log = (msg) => console.log(`[cycle ${id}] ${msg}`);

  try {
    if (!config.tokenAddress) throw new Error('TOKEN_ADDRESS (BABY ROBBIE) is required');
    if (!config.rewardToken) throw new Error('REWARD_TOKEN (ROBBIE) is required');

    const launch = await getLaunch();
    const phase = describePhase(launch);
    log(`phase=${phase}${launch.graduated ? ` pool=${String(launch.poolId).slice(0, 10)}…` : ` curve=${launch.curve}`}`);

    // The one thing that must not be wrong. Warn, never throw: an operator may
    // be mid-migration, and the cycle below still reports what it finds.
    const walletAddress = config.wallet.address;
    const feeWarning = feeRecipientWarning(launch, walletAddress);
    lastFeeRecipientCheck = {
      ok: feeWarning === null,
      expected: walletAddress,
      actual: launch.creatorFeeRecipient || null,
      at: new Date().toISOString(),
    };
    if (feeWarning) console.warn(`[cycle ${id}] ⚠️  ${feeWarning}`);

    // 1. Sweep pending fees into the escrow. Never fatal.
    const sweep = await sweepFees(launch);
    await repo.addStep({
      cycleId: id, name: 'sweep', status: sweep.swept ? 'ok' : 'skipped',
      signature: sweep.signature, detail: { phase, reason: sweep.reason },
    });
    if (sweep.skipped) log(`sweep skipped: ${sweep.reason}`);

    // 2. Claim the escrow.
    const claim = await claimFromEscrow();
    await repo.addStep({ cycleId: id, name: 'claim', status: 'ok', signature: claim.signature, detail: { ethClaimed: claim.ethClaimed } });
    log(`claimed ${claim.ethClaimed} ETH`);

    const claimed = claim.ethClaimed;
    if (!(claimed > 0)) {
      await repo.finishCycle(id, {
        status: 'skipped', phase, eth_claimed: 0,
        sweep_skipped: sweep.skipped ? 1 : 0, sweep_reason: sweep.reason,
        note: 'nothing claimed',
      });
      log('skipped: nothing to work with');
      return repo.getCycleWithSteps(id);
    }

    // 3. Split.
    const { rewardEth, devEth } = splitClaim(claimed);
    log(`split: ${rewardEth} -> ${config.rewardSymbol} reward (${config.rewardBuyPct}%), keep ${devEth} for dev/gas`);

    // 4. Reward leg. The reward token is already graduated, so it always
    //    trades on v4 regardless of which phase OUR token is in.
    //    Amounts below MIN_REWARD_ETH are not worth a swap's gas, so the leg is
    //    SKIPPED cleanly: the step is recorded, the cycle still completes, and
    //    the dust stays in the wallet as native ETH alongside the dev cut.
    //    Failing here instead would mark the cycle failed AFTER the escrow had
    //    already been claimed, and every later tick would pay to do it again.
    let reward = { skipped: false, sent: 0, failed: 0, recipients: 0, tokensBought: 0, eligibleHolders: 0, totalHolders: 0 };
    if (rewardEth >= config.minRewardEth && rewardEth > 0) {
      const rewardLaunch = config.dryRun
        ? { graduated: true, poolKey: null, poolFee: 0, tickSpacing: 200, pairToken: null }
        : await getLaunch(config.rewardToken);
      reward = { skipped: false, ...(await runRewardLeg(id, { launch, rewardLaunch, ethAmount: rewardEth })) };
    } else {
      const reason = rewardEth > 0
        ? `${rewardEth} ETH is below MIN_REWARD_ETH (${config.minRewardEth})`
        : 'reward share of this claim is zero';
      reward = { ...reward, skipped: true, reason };
      await repo.addStep({
        cycleId: id, name: 'reward', status: 'skipped',
        detail: { reason, rewardEth, minRewardEth: config.minRewardEth },
      });
      log(`reward leg skipped: ${reason}`);
    }

    // 5. Dev cut needs no transaction: it is already native ETH in the wallet.

    const outcome = summarizeReward(reward);
    await repo.finishCycle(id, {
      status: outcome.status, mode: 'reward', phase,
      eth_claimed: claimed, eth_spent_buy: reward.skipped ? 0 : rewardEth,
      tokens_bought: reward.tokensBought,
      eligible_holders: reward.eligibleHolders, total_holders: reward.totalHolders,
      sweep_skipped: sweep.skipped ? 1 : 0, sweep_reason: sweep.reason,
      note: outcome.note,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    if (outcome.status === 'complete') log(`complete (reward) — ${outcome.note}`);
    else console.warn(`[cycle ${id}] FAILED: ${outcome.error}`);
    return repo.getCycleWithSteps(id);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({ cycleId: id, name: 'error', status: 'failed', detail: { message } });
    await repo.finishCycle(id, { status: 'failed', error: message });
    log(`FAILED: ${message}`);
    return repo.getCycleWithSteps(id);
  }
}

module.exports = {
  runCycle,
  runRewardLeg,
  splitClaim,
  summarizeReward,
  isFeeRecipientOk,
  feeRecipientWarning,
  getFeeRecipientCheck,
};
