'use strict';
const test = require('node:test');
const assert = require('node:assert');

// Every split key is cleared on each load: a case that sets REWARD_BUY_PCT
// would otherwise leave it in the environment and make later cases fail for a
// reason that has nothing to do with what they test.
const SPLIT_KEYS = ['REWARD_BUY_PCT', 'BURN_PCT', 'MIN_REWARD_ETH', 'TRIGGER_MODE', 'CLAIM_EVERY_USD', 'CLAIM_EVERY_ETH', 'DISPERSE_ADDRESS'];

function loadConfig(env) {
  for (const k of SPLIT_KEYS) if (!(k in env)) delete process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  delete require.cache[require.resolve('./config')];
  return require('./config');
}

test('defaults to the 70 / 20 / 10 split', () => {
  // 70% buys BUN for holders, 20% buys BABYBUNDLECAT and burns it, and the
  // remaining 10% is already native ETH in the wallet: dev cut and gas.
  const c = loadConfig({ DRY_RUN: 'true' });
  assert.strictEqual(c.rewardBuyPct, 70);
  assert.strictEqual(c.burnPct, 20);
  assert.strictEqual(c.devPct, 10);
});

test('rejects a reward share above 100', () => {
  assert.throws(() => loadConfig({ DRY_RUN: 'true', REWARD_BUY_PCT: '105' }), /invalid split/);
});

test('rejects a negative reward share', () => {
  assert.throws(() => loadConfig({ DRY_RUN: 'true', REWARD_BUY_PCT: '-1' }), /invalid split/);
});

test('accepts fractional shares without float drift', () => {
  const c = loadConfig({ DRY_RUN: 'true', REWARD_BUY_PCT: '70.1', BURN_PCT: '10' });
  assert.strictEqual(c.rewardBuyPct, 70.1);
  assert.strictEqual(c.devPct, 19.9); // must not be 19.900000000000006
});

test('a reward and burn share that together exceed the claim are refused', () => {
  assert.throws(() => loadConfig({ DRY_RUN: 'true', REWARD_BUY_PCT: '90', BURN_PCT: '20' }), /exceeds 100/);
  assert.throws(() => loadConfig({ DRY_RUN: 'true', BURN_PCT: '101' }), /BURN_PCT/);
  assert.throws(() => loadConfig({ DRY_RUN: 'true', BURN_PCT: '-1' }), /BURN_PCT/);
});

test('the whole claim may go to holders, leaving no burn and no dev cut', () => {
  const c = loadConfig({ DRY_RUN: 'true', REWARD_BUY_PCT: '100', BURN_PCT: '0' });
  assert.strictEqual(c.burnPct, 0);
  assert.strictEqual(c.devPct, 0);
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

test('the trigger defaults to a $100 accumulation gate, with an ETH fallback', () => {
  // A cycle pays one transaction per holder, so firing on every poll would
  // spend most of a small claim on its own gas. The dollar gate is the one an
  // operator thinks in; the ETH gate covers a missing price feed.
  const c = loadConfig({ DRY_RUN: 'true' });
  assert.strictEqual(c.triggerMode, 'accumulation');
  assert.strictEqual(c.claimEveryUsd, 100);
  assert.strictEqual(c.claimEveryEth, 0.005);
});

test('the dollar gate can be turned off, and never goes negative', () => {
  assert.strictEqual(loadConfig({ DRY_RUN: 'true', CLAIM_EVERY_USD: '0' }).claimEveryUsd, 0);
  assert.strictEqual(loadConfig({ DRY_RUN: 'true', CLAIM_EVERY_USD: '-5' }).claimEveryUsd, 0);
  assert.strictEqual(loadConfig({ DRY_RUN: 'true', TRIGGER_MODE: 'interval' }).triggerMode, 'interval');
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

test('a placeholder DISPERSE_ADDRESS is refused at startup, by name', () => {
  // Left unchecked this reaches ethers, which treats any non-address string as
  // an ENS name and reports "network does not support ENS" — mid-cycle, after
  // the fees have already been claimed.
  assert.throws(
    () => loadConfig({ DRY_RUN: 'true', DISPERSE_ADDRESS: '0xYourNewDisperser' }),
    /DISPERSE_ADDRESS is not an address.*deploy-disperser-v2/s
  );
  assert.throws(() => loadConfig({ DRY_RUN: 'true', DISPERSE_ADDRESS: '0x1234' }), /not an address/);
});

test('a blank DISPERSE_ADDRESS is fine: holders are paid one transfer each', () => {
  assert.strictEqual(loadConfig({ DRY_RUN: 'true', DISPERSE_ADDRESS: '' }).disperseAddress, null);
  const real = '0x0263Da0f8D6B2ae57c7F19bF02B84689307bA7D8';
  assert.strictEqual(loadConfig({ DRY_RUN: 'true', DISPERSE_ADDRESS: real }).disperseAddress, real.toLowerCase());
});
