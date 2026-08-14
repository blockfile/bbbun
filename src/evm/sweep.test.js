'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
delete require.cache[require.resolve('../config')];

const { creatorShareRaw, isOperatorOnlyError, sweepFees } = require('./sweep');
const simvault = require('./simvault');

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

test('recognises the operator-only revert by selector 0x31cdb504', () => {
  // Regression test for the Critical bug: ethers cannot decode custom errors
  // without ABI declarations, so the selector appears as raw data, not as a name.
  assert.strictEqual(isOperatorOnlyError({ data: '0x31cdb504' }), true);
});

test('recognises the operator-only revert by selector 0x8d42130c', () => {
  assert.strictEqual(isOperatorOnlyError({ data: '0x8d42130c' }), true);
});

test('returns false for unrelated errors and selectors', () => {
  assert.strictEqual(isOperatorOnlyError(new Error('insufficient funds')), false);
  assert.strictEqual(isOperatorOnlyError({ data: '0xdeadbeef' }), false);
  assert.strictEqual(isOperatorOnlyError({ message: 'some other error' }), false);
});

test('does not throw when handed null, undefined, or empty object', () => {
  assert.doesNotThrow(() => isOperatorOnlyError(null));
  assert.doesNotThrow(() => isOperatorOnlyError(undefined));
  assert.doesNotThrow(() => isOperatorOnlyError({}));
  assert.strictEqual(isOperatorOnlyError(null), false);
  assert.strictEqual(isOperatorOnlyError(undefined), false);
  assert.strictEqual(isOperatorOnlyError({}), false);
});

test('sweepFees under DRY_RUN returns swept=true and accrues the vault', async () => {
  const config = require('../config');
  simvault.reset();
  const initialVault = simvault.peek();

  // sweepFees requires a launch object with graduated property
  const launch = { graduated: false };
  const result = await sweepFees(launch);

  assert.strictEqual(result.swept, true);
  assert.strictEqual(result.skipped, false);
  assert.strictEqual(result.reason, null);
  assert.strictEqual(typeof result.signature, 'string');

  // Verify the vault was accrued with dryRunFeePerPoll (simvault uses ETH, not wei)
  const finalVault = simvault.peek();
  assert.strictEqual(finalVault, initialVault + config.dryRunFeePerPoll);
});
