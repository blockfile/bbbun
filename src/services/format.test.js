'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  toPublicSummary,
  buildUnclaimedPayload,
  toActivityRow,
  toPublicActivityRow,
  toPublicStats,
} = require('./format');

test('buildUnclaimedPayload reports the live balance and the ETH trigger threshold', () => {
  const out = buildUnclaimedPayload(0.5, 3000);
  assert.deepStrictEqual(Object.keys(out).sort(), ['claimEveryEth', 'ethPriceUsd', 'triggerMode', 'unclaimedEth', 'unclaimedUsd']);
  assert.strictEqual(out.unclaimedEth, 0.5);
  assert.strictEqual(out.unclaimedUsd, 1500);
  assert.strictEqual(out.ethPriceUsd, 3000);
  assert.strictEqual(typeof out.claimEveryEth, 'number');
  assert.strictEqual(typeof out.triggerMode, 'string');
  assert.strictEqual(buildUnclaimedPayload(null, 3000).unclaimedEth, null);
});

test('toActivityRow maps buy + airdrop steps', () => {
  const buy = toActivityRow({ name: 'buy', detail: { ethSpent: 0.4, tokensBought: 1000 }, signature: 'sig', created_at: 'x' }, 100);
  assert.strictEqual(buy.type, 'Buy');
  assert.strictEqual(buy.amountEth, 0.4);
  assert.strictEqual(buy.tokens, 1000);

  const airdrop = toActivityRow({ name: 'airdrop', detail: { sent: 12 }, created_at: 'x' }, 100);
  assert.strictEqual(airdrop.type, 'Airdrop');
  assert.strictEqual(airdrop.status, 'Airdropped');
  assert.strictEqual(airdrop.tokens, 12);
});

test('toActivityRow falls back to the raw step name for unmapped steps (e.g. sweep)', () => {
  const sweep = toActivityRow({ name: 'sweep', detail: { reason: null }, created_at: 'x' }, 100);
  assert.strictEqual(sweep.type, 'sweep');
  assert.strictEqual(sweep.rawType, 'sweep');
});

test('toPublicActivityRow maps buy + airdrop steps', () => {
  const row = toPublicActivityRow({ name: 'buy', detail: { ethSpent: 0.2, tokensBought: 500 }, signature: 's', created_at: '2026-07-11T00:00:00Z' }, 100);
  assert.strictEqual(row.type, 'buy');
  assert.strictEqual(row.amountEth, 0.2);
  assert.strictEqual(typeof row.usdtValue, 'number'); // never null

  const airdrop = toPublicActivityRow({ name: 'airdrop', detail: { sent: 12 }, signature: 's', created_at: '2026-07-11T00:00:00Z' }, 100);
  assert.strictEqual(airdrop.type, 'airdrop');
  assert.strictEqual(airdrop.status, 'airdropped');
  assert.strictEqual(airdrop.tokens, 12);
});

test('toPublicStats emits the flat frontend stats object', () => {
  const out = toPublicStats({
    stats: { total_eth_claimed: 12, total_eth_spent_buy: 9.6, total_tokens_bought: 1000 },
    unclaimedEth: 0.5,
    operatingWallet: '0xwallet',
    market: { marketCap: 100 },
  });
  assert.strictEqual(out.totalCreatorFeesClaimed, 12);
  assert.strictEqual(out.ethSpentBuying, 9.6);
  assert.strictEqual(out.tokensBought, 1000);
  assert.strictEqual(out.operatingWallet, '0xwallet');
  assert.strictEqual(out.unclaimedFeesEth, 0.5);
  assert.strictEqual(out.marketCap, 100);
  assert.strictEqual('tokensBurned' in out, false);
  assert.strictEqual('burns' in out, false);
});

test('toPublicSummary reports claimed and reward-buy totals', () => {
  const out = toPublicSummary({
    stats: { total_eth_claimed: 10, total_eth_spent_buy: 8, total_tokens_bought: 1234, completed: 8 },
    price: 3000,
    marketCapUsd: 55_620_000,
  });
  assert.strictEqual(out.creatorFeesClaimedEth, 10);
  assert.strictEqual(out.creatorFeesClaimedUsd, 30000);
  assert.strictEqual(out.ethSpentBuying, 8);
  assert.strictEqual(out.ethSpentBuyingUsd, 24000);
  assert.strictEqual(out.tokensBought, 1234);
  assert.strictEqual(out.marketCapUsd, 55_620_000);
  assert.strictEqual('tokensBurned' in out, false);
  assert.strictEqual('burns' in out, false);
});

test('toPublicSummary marketCapUsd defaults to null when not provided', () => {
  const out = toPublicSummary({ stats: {}, price: 0 });
  assert.strictEqual(out.marketCapUsd, null);
});
