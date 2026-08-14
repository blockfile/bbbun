'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';

const { buildPoolKey, poolIdOf, isZeroForOne, NATIVE } = require('./pool');

const ROBBIE = '0xe0eba1B76b73BE7bfA7716b6Ca96f724930e2263';
const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';
// Read from chain 2026-08-14: hook.launches(<this>) returns registered = true.
const ROBBIE_POOL_ID = '0x813707ded6381854b2d96c3d942960c5d362244a0903ac7d5c4d471e0c6b175f';

test('sorts native ETH into currency0', () => {
  const key = buildPoolKey({ token: ROBBIE, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
  assert.strictEqual(key.currency0, NATIVE);
  assert.strictEqual(key.currency1.toLowerCase(), ROBBIE.toLowerCase());
});

test('derives ROBBIE\'s real poolId', () => {
  const key = buildPoolKey({ token: ROBBIE, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
  assert.strictEqual(poolIdOf(key), ROBBIE_POOL_ID);
});

test('sorting is independent of argument order', () => {
  const a = buildPoolKey({ token: ROBBIE, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
  const b = buildPoolKey({ token: NATIVE, quoteToken: ROBBIE, fee: 0, tickSpacing: 200, hooks: HOOK });
  assert.strictEqual(poolIdOf(a), poolIdOf(b));
});

test('zeroForOne is true when spending currency0', () => {
  const key = buildPoolKey({ token: ROBBIE, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
  assert.strictEqual(isZeroForOne(key, NATIVE), true);   // ETH -> ROBBIE
  assert.strictEqual(isZeroForOne(key, ROBBIE), false);  // ROBBIE -> ETH
});

test('a different tickSpacing is a different pool', () => {
  const a = buildPoolKey({ token: ROBBIE, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
  const b = buildPoolKey({ token: ROBBIE, quoteToken: NATIVE, fee: 0, tickSpacing: 60, hooks: HOOK });
  assert.notStrictEqual(poolIdOf(a), poolIdOf(b));
});
