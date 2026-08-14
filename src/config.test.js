'use strict';
const test = require('node:test');
const assert = require('node:assert');

function loadConfig(env) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  delete require.cache[require.resolve('./config')];
  return require('./config');
}

test('defaults to the 80 / 20 split', () => {
  const c = loadConfig({ DRY_RUN: 'true', REWARD_BUY_PCT: '' });
  assert.strictEqual(c.rewardBuyPct, 80);
  assert.strictEqual(c.devPct, 20);
});

test('rejects a reward share above 100', () => {
  assert.throws(() => loadConfig({ DRY_RUN: 'true', REWARD_BUY_PCT: '105' }), /invalid split/);
});

test('rejects a negative reward share', () => {
  assert.throws(() => loadConfig({ DRY_RUN: 'true', REWARD_BUY_PCT: '-1' }), /invalid split/);
});

test('accepts a fractional reward share without float drift', () => {
  const c = loadConfig({ DRY_RUN: 'true', REWARD_BUY_PCT: '80.1' });
  assert.strictEqual(c.rewardBuyPct, 80.1);
  assert.strictEqual(c.devPct, 19.9); // must not be 19.900000000000006
});

test('MIN_REWARD_ETH defaults to the 1e-6 parseEther boundary', () => {
  const c = loadConfig({ DRY_RUN: 'true', MIN_REWARD_ETH: '' });
  assert.strictEqual(c.minRewardEth, 0.000001);
});

test('MIN_REWARD_ETH is operator-settable and never negative', () => {
  assert.strictEqual(loadConfig({ DRY_RUN: 'true', MIN_REWARD_ETH: '0.05' }).minRewardEth, 0.05);
  assert.strictEqual(loadConfig({ DRY_RUN: 'true', MIN_REWARD_ETH: '0' }).minRewardEth, 0);
  assert.strictEqual(loadConfig({ DRY_RUN: 'true', MIN_REWARD_ETH: '-1' }).minRewardEth, 0);
});

test('exposes no burn configuration at all', () => {
  const c = loadConfig({ DRY_RUN: 'true' });
  assert.strictEqual(c.burnPct, undefined);
  assert.strictEqual(c.minBurnEth, undefined);
});

test('generates an ephemeral wallet in DRY_RUN with no key', () => {
  const c = loadConfig({ DRY_RUN: 'true', WALLET_PRIVATE_KEY: '' });
  assert.strictEqual(c.walletIsEphemeral, true);
  assert.match(c.wallet.address, /^0x[0-9a-fA-F]{40}$/);
});

test('requires a private key when DRY_RUN is false', () => {
  assert.throws(() => loadConfig({ DRY_RUN: 'false', WALLET_PRIVATE_KEY: '' }), /WALLET_PRIVATE_KEY is required/);
});

test('ships the verified v2 addresses as defaults', () => {
  const c = loadConfig({ DRY_RUN: 'true', PONS_V2_FACTORY: '', MEME_HOOK: '', FEE_ESCROW: '' });
  assert.strictEqual(c.v2Factory, '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e');
  assert.strictEqual(c.memeHook, '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044');
  assert.strictEqual(c.feeEscrow, '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e');
});
