'use strict';

// One buy entry point for both phases. Everything is bought with NATIVE ETH,
// so there is no wrapping and no allowance to maintain. Amounts bought are
// measured from the wallet's balance delta rather than trusting a return value.

const { parseEther } = require('ethers');
const config = require('../config');
const { wallet } = require('./provider');
const { getDecimals, readTokenBalance } = require('./erc20');
const { buildPoolKey, poolIdOf, isZeroForOne, quoteExactInSingle, NATIVE } = require('./pool');
const { swapExactInSingle } = require('./v4router');
const { quoteCurveOut, buyOnCurve } = require('./curve');

const BUY_ATTEMPTS = 3;
const BPS = 10000n;

/** Lower a quoted output by the configured slippage tolerance. */
function applySlippage(quoted, slippagePct) {
  if (!(slippagePct >= 0 && slippagePct < 100)) {
    throw new Error(`SLIPPAGE_PCT must be in [0, 100): ${slippagePct}`);
  }
  return (BigInt(quoted) * BigInt(Math.round((100 - slippagePct) * 100))) / BPS;
}

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Buy `token` with `ethAmount` native ETH.
 * @param {{launch: object, token: string, ethAmount: number}} opts
 *   `launch` decides the venue: the bonding curve before graduation, the v4
 *   pool after. For the REWARD token (already graduated) pass its own launch.
 */
async function buyToken({ launch, token, ethAmount }) {
  if (!(ethAmount > 0)) {
    return { signature: null, tokensBought: 0, tokensBoughtRaw: '0', decimals: 18, simulated: config.dryRun, venue: 'none' };
  }

  if (config.dryRun) {
    const decimals = 18;
    const tokensBought = +(ethAmount * 1_000_000 * (0.97 + Math.random() * 0.06)).toFixed(0);
    return {
      signature: fakeSig('buy'),
      tokensBought,
      tokensBoughtRaw: (BigInt(tokensBought) * 10n ** BigInt(decimals)).toString(),
      decimals,
      simulated: true,
      venue: 'sim',
    };
  }

  const amountIn = parseEther(String(ethAmount));
  const decimals = await getDecimals(token);
  const venue = launch.graduated ? 'v4' : 'curve';

  // Re-quote on every attempt. A one-block price move makes the minimum-output
  // check revert, which is the protection working — but it must not kill the
  // cycle, so wait out the move and try again against a fresh quote.
  let lastErr;
  for (let attempt = 1; attempt <= BUY_ATTEMPTS; attempt += 1) {
    try {
      const before = await readTokenBalance(token, wallet.address);
      let signature;

      if (launch.graduated) {
        const poolKey = launch.poolKey || buildPoolKey({
          token, quoteToken: launch.pairToken || NATIVE,
          fee: launch.poolFee, tickSpacing: launch.tickSpacing, hooks: config.memeHook,
        });
        const zeroForOne = isZeroForOne(poolKey, NATIVE);
        const quoted = await quoteExactInSingle({ poolKey, zeroForOne, amountIn });
        if (quoted <= 0n) throw new Error(`v4 pool quoted zero for ${token}`);
        const tx = await swapExactInSingle({
          poolKey, zeroForOne, amountIn,
          amountOutMinimum: applySlippage(quoted, config.slippagePct),
        });
        await tx.wait();
        console.log(`[tx] buy ${token} on v4 (pool ${poolIdOf(poolKey).slice(0, 10)}…): ${tx.hash}`);
        signature = tx.hash;
      } else {
        const quoted = await quoteCurveOut({ curve: launch.curve, ethAmountRaw: amountIn });
        if (quoted <= 0n) throw new Error(`curve quoted zero for ${token}`);
        const res = await buyOnCurve({
          curve: launch.curve, token, ethAmountRaw: amountIn,
          minTokensOut: applySlippage(quoted, config.slippagePct),
        });
        signature = res.signature;
      }

      const boughtRaw = (await readTokenBalance(token, wallet.address)) - before;
      return {
        signature,
        tokensBought: Number(boughtRaw) / 10 ** decimals,
        tokensBoughtRaw: boughtRaw.toString(),
        decimals,
        simulated: false,
        venue,
      };
    } catch (err) {
      lastErr = err;
      console.warn(`[buy] attempt ${attempt}/${BUY_ATTEMPTS} failed on ${venue}: ${err.shortMessage || err.message}`);
      if (attempt < BUY_ATTEMPTS) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

module.exports = { buyToken, applySlippage };
