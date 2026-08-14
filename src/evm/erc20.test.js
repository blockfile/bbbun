'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';

const { erc20, getDecimals, __setDecimalsCache } = require('./erc20');

test('erc20() returns a contract bound to the address', () => {
  const c = erc20('0x00000000000000000000000000000000000a1b69');
  assert.strictEqual(typeof c.balanceOf, 'function');
  assert.strictEqual(typeof c.transfer, 'function');
});

test('getDecimals caches per token and does not re-read', async () => {
  const token = '0x00000000000000000000000000000000000a1b69';
  __setDecimalsCache(token, 9);
  assert.strictEqual(await getDecimals(token), 9);
  assert.strictEqual(await getDecimals(token.toUpperCase()), 9); // case-insensitive
});
