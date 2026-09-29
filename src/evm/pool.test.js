'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';

const { buildPoolKey, poolIdOf, isZeroForOne, NATIVE } = require('./pool');

const BUN = '0x07EBB29a38Fbcb41563817e5E19f2ceC619C90D2';
const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';
// BUN's real pool, read from chain 2026-09-29 through StateView: fee 0,
// tickSpacing 200, native ETH as currency0, the pons meme hook. getSlot0
// returns a live sqrtPrice and getLiquidity 29,277 units. (The parent bot
// pinned ROBBIE's pool here; this is the same assertion for BUN.)
const BUN_POOL_ID = '0x06e308b77bdafd691d179645296ce8c40e33c6af4a879a913efc7eedc402581c';

test('sorts native ETH into currency0', () => {
  const key = buildPoolKey({ token: BUN, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
  assert.strictEqual(key.currency0, NATIVE);
  assert.strictEqual(key.currency1.toLowerCase(), BUN.toLowerCase());
});

test('derives BUN\'s real poolId', () => {
  const key = buildPoolKey({ token: BUN, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
  assert.strictEqual(poolIdOf(key), BUN_POOL_ID);
});

test('sorting is independent of argument order', () => {
  const a = buildPoolKey({ token: BUN, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
  const b = buildPoolKey({ token: NATIVE, quoteToken: BUN, fee: 0, tickSpacing: 200, hooks: HOOK });
  assert.strictEqual(poolIdOf(a), poolIdOf(b));
});

test('zeroForOne is true when spending currency0', () => {
  const key = buildPoolKey({ token: BUN, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
  assert.strictEqual(isZeroForOne(key, NATIVE), true);   // ETH -> BUN
  assert.strictEqual(isZeroForOne(key, BUN), false);  // BUN -> ETH
});

test('a different tickSpacing is a different pool', () => {
  const a = buildPoolKey({ token: BUN, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
  const b = buildPoolKey({ token: BUN, quoteToken: NATIVE, fee: 0, tickSpacing: 60, hooks: HOOK });
  assert.notStrictEqual(poolIdOf(a), poolIdOf(b));
});
