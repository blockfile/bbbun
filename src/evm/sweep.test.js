'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
delete require.cache[require.resolve('../config')];

const { creatorShareRaw, isOperatorOnlyError } = require('./sweep');

const ETH = 10n ** 18n;

test('creator share removes the protocol bps and nothing else', () => {
  // 3000 bps protocol share -> creator keeps 70%
  assert.strictEqual(creatorShareRaw(ETH, 3000), (ETH * 7000n) / 10000n);
});

test('a zero protocol share leaves the whole amount', () => {
  assert.strictEqual(creatorShareRaw(ETH, 0), ETH);
});

test('creator share of nothing is nothing', () => {
  assert.strictEqual(creatorShareRaw(0n, 3000), 0n);
});

test('rounds down rather than inventing wei', () => {
  // 7 wei at 3000bps = 4.9 -> 4
  assert.strictEqual(creatorShareRaw(7n, 3000), 4n);
});

test('recognises the operator-only revert by name', () => {
  assert.strictEqual(isOperatorOnlyError(new Error('execution reverted: InternalSwapRequiresOperator()')), true);
  assert.strictEqual(isOperatorOnlyError(new Error('NotFeeSweepOperator')), true);
  assert.strictEqual(isOperatorOnlyError(new Error('insufficient funds')), false);
});
