'use strict';

process.env.DRY_RUN = 'true';
process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000a1b69';

const test = require('node:test');
const assert = require('node:assert');
const { getHolderCount, _resetHolderCount } = require('./holdercount');

const reply = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test('reads the holder count from the explorer', async () => {
  _resetHolderCount();
  const n = await getHolderCount({ fetchImpl: reply({ holders_count: '812' }), now: () => 0 });
  assert.strictEqual(n, 812);
});

test('accepts the older field name too', async () => {
  _resetHolderCount();
  assert.strictEqual(await getHolderCount({ fetchImpl: reply({ holders: 45 }), now: () => 0 }), 45);
});

test('the count is cached, so a page refresh is not an explorer call', async () => {
  _resetHolderCount();
  let calls = 0;
  const counting = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ holders_count: 10 }) }; };
  let t = 0;
  await getHolderCount({ fetchImpl: counting, now: () => t });
  await getHolderCount({ fetchImpl: counting, now: () => t });
  assert.strictEqual(calls, 1);
  t = 61_000;
  await getHolderCount({ fetchImpl: counting, now: () => t });
  assert.strictEqual(calls, 2, 'refreshed after the ttl');
});

test('an unreachable explorer keeps the last good count instead of blanking the tile', async () => {
  _resetHolderCount();
  let t = 0;
  await getHolderCount({ fetchImpl: reply({ holders_count: 99 }), now: () => t });
  t = 61_000;
  const after = await getHolderCount({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, now: () => t });
  assert.strictEqual(after, 99);
});

test('before there is any token, or before the first success, it is null — never a guess', async () => {
  _resetHolderCount();
  assert.strictEqual(await getHolderCount({ token: null }), null);
  assert.strictEqual(await getHolderCount({ fetchImpl: async () => { throw new Error('down'); }, now: () => 0 }), null);
  _resetHolderCount();
  assert.strictEqual(await getHolderCount({ fetchImpl: reply({ holders_count: 'not a number' }), now: () => 0 }), null);
});
