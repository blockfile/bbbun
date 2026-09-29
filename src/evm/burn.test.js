'use strict';

process.env.DRY_RUN = 'true';
process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000a1b69';
process.env.REWARD_BUY_PCT = '70';
process.env.BURN_PCT = '20';

const test = require('node:test');
const assert = require('node:assert');
const config = require('../config');
const { buyAndBurn, sendToDead, describeBurn, burnedPctOfSupply } = require('./burn');

const DEAD = '0x000000000000000000000000000000000000dead';
const LAUNCH = { graduated: true, poolKey: null, poolFee: 0, tickSpacing: 200, pairToken: null, curve: '0xcurve' };

// ── where the tokens go ──────────────────────────────────────────────────────

test('the burn sends the bought tokens to 0x…dEaD, and calls no burn() function', async () => {
  const calls = [];
  const contract = {
    transfer: async (to, raw) => { calls.push(['transfer', to, raw]); return { hash: '0xburn', wait: async () => {} }; },
    burn: async () => { throw new Error('burn() must not be called — supply is not reduced, the tokens are parked'); },
  };
  const hash = await sendToDead({ token: '0xtoken', raw: 123n, contractFor: () => contract, send: (fn) => fn() });
  assert.strictEqual(hash, '0xburn');
  assert.deepStrictEqual(calls, [['transfer', DEAD, 123n]]);
  assert.strictEqual(config.deadAddress, DEAD);
});

test('a transfer that fails is retried, then given up on — never silently swallowed', async () => {
  let n = 0;
  const contract = { transfer: async () => { n += 1; throw new Error('could not coalesce error'); } };
  await assert.rejects(
    () => sendToDead({ token: '0xtoken', raw: 1n, attempts: 3, delayMs: 0, contractFor: () => contract, send: (fn) => fn() }),
    /coalesce/
  );
  assert.strictEqual(n, 3);
});

// ── when the leg runs at all ────────────────────────────────────────────────

test('a zero or dust burn share is a clean skip that spends nothing', async () => {
  const zero = await buyAndBurn({ launch: LAUNCH, ethAmount: 0 });
  assert.strictEqual(zero.skipped, true);
  assert.strictEqual(zero.ethSpent, 0);
  assert.match(zero.reason, /zero/);

  // Below MIN_REWARD_ETH the swap would cost more gas than the burn is worth.
  const dust = await buyAndBurn({ launch: LAUNCH, ethAmount: 1e-9, minEth: 0.000001 });
  assert.strictEqual(dust.skipped, true);
  assert.strictEqual(dust.bought, false);
  assert.match(dust.reason, /below MIN_REWARD_ETH/);
});

test('DRY_RUN buys and burns on paper, with a signature that cannot be mistaken for a real one', async () => {
  const r = await buyAndBurn({ launch: LAUNCH, ethAmount: 0.002 });
  assert.strictEqual(r.bought, true);
  assert.strictEqual(r.burned, true);
  assert.ok(r.tokensBurned > 0);
  assert.match(r.burnSignature, /^burn_/);
  assert.doesNotMatch(r.burnSignature, /^0x/, 'a simulated burn must never look like a transaction hash');
});

// ── what the log says ───────────────────────────────────────────────────────

test('each outcome describes itself plainly, including where the money is', () => {
  assert.match(describeBurn({ skipped: true, reason: 'BURN_PCT is 0' }), /skipped: BURN_PCT is 0/);
  assert.match(describeBurn({ burned: true, tokensBurned: 1946, ethSpent: 0.002 }), /1946 .* for 0\.002 ETH/);
  assert.match(
    describeBurn({ bought: true, burned: false, tokensBurned: 1946, error: 'reverted' }),
    /TRANSFER failed .* tokens are in the wallet/
  );
  assert.match(describeBurn({ error: 'quoted zero' }), /ETH stays in the wallet, NOT auto-retried/);
});

// ── the headline number ─────────────────────────────────────────────────────

test('burned share is measured against the minted supply, which a dead-address burn leaves alone', () => {
  // 10M of a 1B mint. Adding the burned tokens back on top (right for a real
  // burn(), which shrinks totalSupply) would understate it as 0.99%.
  assert.ok(Math.abs(burnedPctOfSupply(10_000_000, 1_000_000_000) - 1) < 1e-9);
  assert.strictEqual(burnedPctOfSupply(0, 1_000_000_000), 0);
});

test('with nothing to divide by, the share is null rather than NaN or a guess', () => {
  assert.strictEqual(burnedPctOfSupply(10, 0), null);
  assert.strictEqual(burnedPctOfSupply(10, null), null);
  assert.strictEqual(burnedPctOfSupply(null, 1_000_000_000), null);
});
