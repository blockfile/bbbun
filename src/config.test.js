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

test('defaults to the 80 / 0.1 / 19.9 split', () => {
  const c = loadConfig({ DRY_RUN: 'true', REWARD_BUY_PCT: '', BURN_PCT: '' });
  assert.strictEqual(c.rewardBuyPct, 80);
  assert.strictEqual(c.burnPct, 0.1);
  assert.strictEqual(c.devPct, 19.9); // must not be 19.900000000000006
});

test('rejects a split that exceeds 100', () => {
  assert.throws(() => loadConfig({ DRY_RUN: 'true', REWARD_BUY_PCT: '95', BURN_PCT: '10' }), /invalid split/);
});

test('allows a fractional burn percentage', () => {
  const c = loadConfig({ DRY_RUN: 'true', REWARD_BUY_PCT: '80', BURN_PCT: '0.5' });
  assert.strictEqual(c.burnPct, 0.5);
  assert.strictEqual(c.devPct, 19.5);
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
