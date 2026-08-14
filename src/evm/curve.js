'use strict';

// Pre-graduation the token has no pool — it trades against its own bonding
// curve. buy() takes the quote amount as an argument AND as msg.value on a
// native-quote launch, which every pons v2 ETH launch is.

const { Contract } = require('ethers');
const { provider, wallet } = require('./provider');
const { CURVE_ABI } = require('./abi');
const { readTokenBalance } = require('./erc20');

function curveAt(address, runner = provider) {
  return new Contract(address, CURVE_ABI, runner);
}

/** Constant-product quote against the curve's current reserves. */
async function quoteCurveOut({ curve, ethAmountRaw }) {
  const [quoteReserve, tokenReserve] = await curveAt(curve).getReserves();
  if (quoteReserve <= 0n || tokenReserve <= 0n) return 0n;
  // x*y=k with no fee applied here; the curve charges feeBps internally, so the
  // caller's slippage tolerance absorbs the difference.
  return (ethAmountRaw * tokenReserve) / (quoteReserve + ethAmountRaw);
}

async function buyOnCurve({ curve, token, ethAmountRaw, minTokensOut }) {
  const before = await readTokenBalance(token, wallet.address);
  const tx = await curveAt(curve, wallet).buy(ethAmountRaw, minTokensOut, wallet.address, { value: ethAmountRaw });
  await tx.wait();
  const after = await readTokenBalance(token, wallet.address);
  console.log(`[tx] buy ${token} on the curve: ${tx.hash}`);
  return { signature: tx.hash, tokensBoughtRaw: after - before };
}

module.exports = { curveAt, quoteCurveOut, buyOnCurve };
