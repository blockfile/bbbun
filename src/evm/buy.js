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
const WEI_DECIMALS = 18;

/**
 * Expand a JS Number to a PLAIN decimal string — never exponential notation.
 *
 * This exists because ETH amounts flow through this project as Numbers, and
 * `String(n)` switches to exponential below 1e-6 ("5.6e-7"), which
 * `parseEther` rejects outright ("invalid FixedNumber string value"). A claim
 * of 7e-7 ETH — the creator's share of the 1% hook fee on one small swap — is
 * a perfectly ordinary amount for this bot, so the conversion must survive it.
 *
 * `String(n)` (not `toFixed(18)`) is the source of the digits on purpose: it
 * is the shortest round-trip representation, so 21.368470124 converts to
 * exactly 21368470124000000000 wei. `(21.368470124).toFixed(18)` would instead
 * expose the binary-float tail as "21.368470124000001675" and mint 1675 wei
 * that the caller never had.
 */
function toPlainDecimalString(n) {
  const s = String(n);
  if (!/e/i.test(s)) return s;

  const [mantissa, expPart] = s.split(/e/i);
  const exp = Number(expPart);
  const negative = mantissa.startsWith('-');
  const [intPart, fracPart = ''] = (negative ? mantissa.slice(1) : mantissa).split('.');
  const digits = intPart + fracPart;
  const pointAt = intPart.length + exp; // where the decimal point lands in `digits`

  let out;
  if (pointAt <= 0) out = `0.${'0'.repeat(-pointAt)}${digits}`;
  else if (pointAt >= digits.length) out = digits + '0'.repeat(pointAt - digits.length);
  else out = `${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;

  return (negative ? '-' : '') + out;
}

/**
 * ETH (Number) -> wei (BigInt). Exponent-safe; see toPlainDecimalString.
 * Digits finer than one wei are truncated, never rounded up, so a conversion
 * can never spend more than the caller holds.
 */
function ethToWei(ethAmount) {
  const n = Number(ethAmount);
  if (!Number.isFinite(n)) throw new Error(`ethToWei: not a finite amount: ${ethAmount}`);
  if (n < 0) throw new Error(`ethToWei: negative amount: ${ethAmount}`);

  let decimal = toPlainDecimalString(n);
  const dot = decimal.indexOf('.');
  if (dot >= 0 && decimal.length - dot - 1 > WEI_DECIMALS) {
    decimal = decimal.slice(0, dot + 1 + WEI_DECIMALS); // sub-wei digits are dust
  }
  return parseEther(decimal);
}

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

  const amountIn = ethToWei(ethAmount);
  if (amountIn <= 0n) {
    throw new Error(`buy amount ${ethAmount} ETH rounds to zero wei — raise it above MIN_REWARD_ETH`);
  }
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

module.exports = { buyToken, applySlippage, ethToWei, toPlainDecimalString };
