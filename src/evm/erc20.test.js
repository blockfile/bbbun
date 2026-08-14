'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
process.env.RPC_URL = 'http://127.0.0.1:1'; // nothing listens here, on purpose

const { erc20, getDecimals, getTokenSupplyRaw, SIM_TOTAL_SUPPLY_RAW, __setDecimalsCache } = require('./erc20');

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

// DRY_RUN must simulate EVERY chain call. totalSupply() was the last one that
// did not — with REWARD_CAP_PCT set, a dry run against an unreachable node died
// with ECONNREFUSED *after* the simulated buy had already been persisted. The
// RPC above is a black hole, so this test fails outright if the read escapes.
test('DRY_RUN simulates the total-supply read instead of hitting the RPC', async () => {
  const supply = await getTokenSupplyRaw('0x00000000000000000000000000000000000a1b69');
  assert.strictEqual(supply, SIM_TOTAL_SUPPLY_RAW);
  assert.strictEqual(supply, 10n ** 27n); // 1e9 tokens at 18 decimals, per the pons v2 launch config
});
