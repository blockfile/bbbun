'use strict';

// Uniswap v4 swaps go through the UniversalRouter, which takes a byte string of
// COMMANDS and a matching array of encoded inputs. A single-pool exact-in swap
// is one command (V4_SWAP) whose input carries three ACTIONS:
//
//   SWAP_EXACT_IN_SINGLE  do the swap
//   SETTLE_ALL            pay the input currency in
//   TAKE_ALL              take the output currency out
//
// Paying with native ETH means attaching msg.value and settling address(0).
// There is deliberately no ERC-20 input path here: this bot never sells, so it
// never needs a Permit2 approval.

const { Contract, AbiCoder, concat, toBeHex } = require('ethers');
const config = require('../config');
const { wallet } = require('./provider');
const { EXACT_IN_SINGLE_TYPE, UNIVERSAL_ROUTER_ABI } = require('./abi');
const { NATIVE } = require('./pool');

const V4_SWAP = 0x10;              // UniversalRouter Commands.V4_SWAP
const SWAP_EXACT_IN_SINGLE = 0x06; // v4-periphery Actions
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;

const coder = AbiCoder.defaultAbiCoder();

function keyTuple(k) {
  return [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];
}

/** Encode one exact-in single-pool swap for UniversalRouter.execute(). */
function encodeExactInSingle({ poolKey, zeroForOne, amountIn, amountOutMinimum }) {
  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const currencyOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;

  const actions = concat([toBeHex(SWAP_EXACT_IN_SINGLE, 1), toBeHex(SETTLE_ALL, 1), toBeHex(TAKE_ALL, 1)]);
  const params = [
    coder.encode([EXACT_IN_SINGLE_TYPE], [[keyTuple(poolKey), zeroForOne, amountIn, amountOutMinimum, '0x']]),
    coder.encode(['address', 'uint256'], [currencyIn, amountIn]),
    coder.encode(['address', 'uint256'], [currencyOut, amountOutMinimum]),
  ];

  return {
    commands: toBeHex(V4_SWAP, 1),
    inputs: [coder.encode(['bytes', 'bytes[]'], [actions, params])],
  };
}

/** Send the swap. Native input rides along as msg.value. */
async function swapExactInSingle({ poolKey, zeroForOne, amountIn, amountOutMinimum, deadlineSec = 600 }) {
  const { commands, inputs } = encodeExactInSingle({ poolKey, zeroForOne, amountIn, amountOutMinimum });
  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const value = currencyIn.toLowerCase() === NATIVE ? amountIn : 0n;

  const router = new Contract(config.universalRouter, UNIVERSAL_ROUTER_ABI, wallet);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec);
  return router.execute(commands, inputs, deadline, { value });
}

module.exports = {
  encodeExactInSingle, swapExactInSingle,
  V4_SWAP, SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL,
};
