'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000a1b69';
delete require.cache[require.resolve('../config')];

const { getLaunch, describePhase } = require('./launch');

test('DRY_RUN returns a simulated launch that starts on the curve', async () => {
  const l = await getLaunch();
  assert.strictEqual(l.exists, true);
  assert.strictEqual(l.graduated, false);
  assert.strictEqual(describePhase(l), 'curve');
  assert.strictEqual(l.poolId, null); // no pool exists before graduation
});

test('describePhase reports v4 once graduated', () => {
  assert.strictEqual(describePhase({ graduated: true }), 'v4');
});

test('getLaunch throws without a token address', async () => {
  await assert.rejects(() => getLaunch(null), /TOKEN_ADDRESS/);
});
