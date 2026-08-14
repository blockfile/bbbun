'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
delete require.cache[require.resolve('../config')];

const { buyToken, applySlippage } = require('./buy');

test('applySlippage lowers the minimum by the configured percent', () => {
  assert.strictEqual(applySlippage(10000n, 5), 9500n);
  assert.strictEqual(applySlippage(10000n, 0), 10000n);
  assert.strictEqual(applySlippage(10000n, 2.5), 9750n);
});

test('applySlippage rejects a nonsense percentage', () => {
  assert.throws(() => applySlippage(1n, 100), /SLIPPAGE_PCT/);
  assert.throws(() => applySlippage(1n, -1), /SLIPPAGE_PCT/);
});

test('DRY_RUN buy simulates and reports raw units', async () => {
  const launch = { graduated: false, curve: '0x00000000000000000000000000000000000c0f1e' };
  const r = await buyToken({ launch, token: '0x00000000000000000000000000000000000a1b69', ethAmount: 0.5 });
  assert.strictEqual(r.simulated, true);
  assert.strictEqual(r.venue, 'sim');
  assert.ok(r.tokensBought > 0);
  assert.strictEqual(BigInt(r.tokensBoughtRaw) > 0n, true);
});

test('DRY_RUN buy of zero returns zero without throwing', async () => {
  const launch = { graduated: true };
  const r = await buyToken({ launch, token: '0x00000000000000000000000000000000000a1b69', ethAmount: 0 });
  assert.strictEqual(r.tokensBought, 0);
  assert.strictEqual(r.tokensBoughtRaw, '0');
});

// DRY_RUN short-circuits before the venue split, so the live dispatch is
// asserted at the source level instead — the same technique ponsliqui uses to
// pin its claim path. Without this, a buy that silently always took one venue
// would pass every other test in this file.
test('the live path dispatches on graduation, and never sells', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'buy.js'), 'utf8');
  assert.match(src, /launch\.graduated/, 'must branch on the phase');
  assert.match(src, /swapExactInSingle/, 'graduated path must use the v4 router');
  assert.match(src, /buyOnCurve/, 'pre-graduation path must use the curve');
  assert.doesNotMatch(src, /permit2|Permit2/, 'this bot never sells, so it needs no Permit2 path');
});
