'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
delete require.cache[require.resolve('../config')];

const { parseEther } = require('ethers');
const { buyToken, applySlippage, ethToWei, toPlainDecimalString } = require('./buy');

// ── The LIVE-mode ETH->wei conversion ────────────────────────────────────────
// Tested directly, NOT through buyToken: DRY_RUN returns before the conversion
// is ever reached, so no end-to-end dry-run test can cover this. The bug it
// pins is real money — `parseEther(String(ethAmount))` throws
// "invalid FixedNumber string value" for every amount below 1e-6 ETH, because
// a JS Number stringifies as "5.6e-7" there. The escrow had already been
// claimed by then, so the ETH was stranded and every later tick paid for
// another claim() and threw again.
test('ethToWei converts every live amount, including sub-1e-6 ETH', () => {
  const cases = [
    [1e-9, 1000000000n],
    [8e-8, 80000000000n],
    [4e-7, 400000000000n],
    [8e-7, 800000000000n],
    [1e-6, 1000000000000n],
    [0.001, 1000000000000000n],
    [1, 1000000000000000000n],
    [21.368470124, 21368470124000000000n],
  ];
  for (const [eth, wei] of cases) {
    assert.strictEqual(ethToWei(eth), wei, `${eth} ETH should be ${wei} wei`);
  }
});

test('ethToWei matches parseEther exactly — no float tail is minted', () => {
  // (21.368470124).toFixed(18) is "21.368470124000001675": toFixed alone would
  // invent 1675 wei the caller never had. The shortest round-trip string does not.
  assert.strictEqual(ethToWei(21.368470124), parseEther('21.368470124'));
  assert.strictEqual(ethToWei(0.1 + 0.2), parseEther(String(0.1 + 0.2)));
});

test('ethToWei handles the exact escrow-dust cycle that failed', () => {
  // 7e-7 ETH claimed, 80% reward leg -> 5.6e-7 ETH, which String() renders "5.6e-7".
  const rewardEth = +(7e-7 * 0.8).toFixed(9);
  assert.strictEqual(String(rewardEth), '5.6e-7'); // the shape that broke parseEther
  assert.strictEqual(ethToWei(rewardEth), 560000000000n);
});

test('toPlainDecimalString never returns exponential notation', () => {
  for (const n of [1e-9, 5.6e-7, 1e-6, 0.001, 1, 21.368470124, 1e21]) {
    assert.doesNotMatch(toPlainDecimalString(n), /e/i, `${n} still exponential`);
  }
  assert.strictEqual(toPlainDecimalString(5.6e-7), '0.00000056');
  assert.strictEqual(toPlainDecimalString(1e-9), '0.000000001');
});

test('ethToWei truncates sub-wei dust instead of throwing or rounding up', () => {
  assert.strictEqual(ethToWei(1e-19), 0n); // finer than one wei
  assert.strictEqual(ethToWei(0), 0n);
});

test('ethToWei rejects nonsense amounts', () => {
  assert.throws(() => ethToWei(NaN), /finite/);
  assert.throws(() => ethToWei(Infinity), /finite/);
  assert.throws(() => ethToWei(-1), /negative/);
});

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
