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

/** Buy the reward token and airdrop it pro-rata to holders of the fee token. */
async function runRewardLeg(cycleId, { launch, rewardLaunch, wethAmount }) {
  const log = (m) => console.log(`[cycle ${cycleId}] [reward] ${m}`);

  const buy = await buyToken({ launch: rewardLaunch, token: config.rewardToken, ethAmount: wethAmount });
  await repo.addStep({
    cycleId, name: 'buy', status: 'ok', signature: buy.signature,
    detail: { leg: 'reward', token: config.rewardToken, ethSpent: wethAmount, tokensBought: buy.tokensBought, venue: buy.venue },
  });
  log(`bought ${buy.tokensBought} ${config.rewardSymbol} with ${wethAmount} ETH`);

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

  return { tokensBought: buy.tokensBought, sent: air.sent, failed: air.failed, eligibleHolders: holders.length, totalHolders };
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
    let reward = { sent: 0, failed: 0, tokensBought: 0, eligibleHolders: 0, totalHolders: 0 };
    if (rewardEth > 0) {
      const rewardLaunch = config.dryRun
        ? { graduated: true, poolKey: null, poolFee: 0, tickSpacing: 200, pairToken: null }
        : await getLaunch(config.rewardToken);
      reward = await runRewardLeg(id, { launch, rewardLaunch, wethAmount: rewardEth });
    }

    // 5. Dev cut needs no transaction: it is already native ETH in the wallet.

    await repo.finishCycle(id, {
      status: 'complete', mode: 'reward', phase,
      eth_claimed: claimed, eth_spent_buy: rewardEth,
      tokens_bought: reward.tokensBought,
      eligible_holders: reward.eligibleHolders, total_holders: reward.totalHolders,
      sweep_skipped: sweep.skipped ? 1 : 0, sweep_reason: sweep.reason,
      note: `airdrop sent ${reward.sent}`,
    });
    log('complete (reward)');
    return repo.getCycleWithSteps(id);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({ cycleId: id, name: 'error', status: 'failed', detail: { message } });
    await repo.finishCycle(id, { status: 'failed', error: message });
    log(`FAILED: ${message}`);
    return repo.getCycleWithSteps(id);
  }
}

module.exports = { runCycle, runRewardLeg, splitClaim };
