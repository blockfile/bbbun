'use strict';

// Buy BABYBUNDLECAT with part of a claim and send it to 0x…dEaD.
//
// The parent bot (babyrobbie) had no burn leg; this fork's whole point is that
// the fees BBC earns buy BBC back as well as paying holders in BUN.
//
// A transfer to the dead address, not a `burn(uint256)` call: the tokens leave
// circulation for good — nobody holds that key, and every explorer labels it a
// burn — but totalSupply does NOT drop, so the dead address shows up as a
// holder and is excluded from the airdrop (see exclude.js).
//
// Nothing here is allowed to fail a cycle. By the time it runs, holders have
// already been paid; a failed buy leaves the ETH in the wallet and a failed
// transfer leaves the bought BBC there. Neither is lost, and neither is
// retried automatically: the next cycle computes a fresh share from a fresh
// claim. Saying otherwise would hide idle funds.

const config = require('../config');
const { wallet } = require('./provider');
const { erc20, getDecimals } = require('./erc20');
const { buyToken } = require('./buy');
const { sendTx } = require('./send');

/** Pure: a one-line description of what the burn leg did, for the log. */
function describeBurn(r) {
  if (r.skipped) return `burn skipped: ${r.reason}`;
  if (r.burned) return `burn bought ${r.tokensBurned} ${config.tokenSymbol} for ${r.ethSpent} ETH and sent it to ${config.deadAddress}`;
  if (r.bought) return `burn bought ${r.tokensBurned} ${config.tokenSymbol} but the TRANSFER failed (${r.error}) — the tokens are in the wallet`;
  return `burn FAILED (${r.error}) — the ETH stays in the wallet, NOT auto-retried`;
}

/**
 * Send `raw` base units of `token` to the dead address.
 *
 * Retried like a buy is: an ethers-level RPC hiccup ("could not coalesce
 * error") is not a revert, and losing the tokens to one blip would strand
 * everything the leg just bought.
 */
async function sendToDead({ token, raw, attempts = 3, delayMs = 3000, contractFor = (t) => erc20(t, wallet), send = sendTx }) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const tx = await send(() => contractFor(token).transfer(config.deadAddress, raw));
      await tx.wait();
      console.log(`[tx] burn ${raw} of ${token} -> ${config.deadAddress}: ${tx.hash}`);
      return tx.hash;
    } catch (err) {
      lastErr = err;
      console.warn(`[burn] transfer attempt ${attempt}/${attempts} failed: ${err.shortMessage || err.message}`);
      if (attempt < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/**
 * Buy BABYBUNDLECAT with `ethAmount` and burn every token bought.
 *
 * Measured from the wallet's balance DELTA (buyToken does this), never from a
 * quote: the pons hook takes its tax in the token itself, so a quoted figure
 * would try to burn more than actually arrived. The creator's own BBC, which
 * may sit in this same wallet, is therefore never touched.
 *
 * @param {{launch: object, ethAmount: number, minEth?: number}} opts
 * @returns {Promise<object>} never throws
 */
async function buyAndBurn({ launch, ethAmount, minEth = config.minRewardEth }) {
  const base = {
    skipped: false, bought: false, burned: false,
    ethSpent: ethAmount, tokensBurned: 0, tokensBurnedRaw: '0',
    buySignature: null, burnSignature: null, venue: null, error: null, reason: null,
  };

  if (!config.burnPct) return { ...base, skipped: true, ethSpent: 0, reason: 'BURN_PCT is 0' };
  if (!(ethAmount > 0)) return { ...base, skipped: true, ethSpent: 0, reason: 'burn share of this claim is zero' };
  if (ethAmount < minEth) {
    return { ...base, skipped: true, ethSpent: 0, reason: `burn share ${ethAmount} ETH is below MIN_REWARD_ETH (${minEth})` };
  }
  if (!config.tokenAddress) return { ...base, skipped: true, ethSpent: 0, reason: 'TOKEN_ADDRESS is not set' };

  let buy;
  try {
    buy = await buyToken({ launch, token: config.tokenAddress, ethAmount });
  } catch (err) {
    return { ...base, error: err.shortMessage || err.message };
  }
  if (!(BigInt(buy.tokensBoughtRaw) > 0n)) {
    return { ...base, buySignature: buy.signature, venue: buy.venue, error: 'the buy succeeded but delivered zero tokens' };
  }

  const bought = {
    ...base,
    bought: true,
    tokensBurned: buy.tokensBought,
    tokensBurnedRaw: buy.tokensBoughtRaw,
    buySignature: buy.signature,
    venue: buy.venue,
  };

  if (config.dryRun) {
    return { ...bought, burned: true, burnSignature: `burn_${Date.now().toString(36)}` };
  }

  try {
    const burnSignature = await sendToDead({ token: config.tokenAddress, raw: BigInt(buy.tokensBoughtRaw) });
    return { ...bought, burned: true, burnSignature };
  } catch (err) {
    return { ...bought, error: err.shortMessage || err.message };
  }
}

/** Burned BBC as a share of the minted supply, in percent. Pure. */
function burnedPctOfSupply(totalBurned, mintedSupply) {
  if (typeof totalBurned !== 'number' || !Number.isFinite(totalBurned)) return null;
  if (typeof mintedSupply !== 'number' || !(mintedSupply > 0)) return null;
  // A transfer to 0x…dEaD leaves totalSupply alone, so the minted supply IS the
  // denominator — adding the burned tokens back on top would count them twice.
  return (totalBurned / mintedSupply) * 100;
}

module.exports = { buyAndBurn, sendToDead, describeBurn, burnedPctOfSupply, getDecimals };
