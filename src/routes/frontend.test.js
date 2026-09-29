'use strict';
const test = require('node:test');
const assert = require('node:assert');

process.env.DRY_RUN = 'true';
delete require.cache[require.resolve('../config')];

const { isRealTxHash, toRewardRow } = require('./frontend');

test('a real 32-byte tx hash is accepted, in either case', () => {
  assert.strictEqual(isRealTxHash('0x' + 'a'.repeat(64)), true);
  assert.strictEqual(isRealTxHash('0x' + 'A'.repeat(64)), true);
  assert.strictEqual(
    isRealTxHash('0x813707ded6381854b2d96c3d942960c5d362244a0903ac7d5c4d471e0c6b175f'),
    true
  );
});

// The point of the filter: DRY_RUN records airdrops with status 'ok' and a
// fabricated signature. Publishing those would show invented payouts to real
// visitors, each linking to a transaction that does not exist.
test('a DRY_RUN placeholder signature is rejected', () => {
  assert.strictEqual(isRealTxHash('airdrop_ka9f2xj4'), false);
  assert.strictEqual(isRealTxHash('claim_m1x8p2'), false);
});

test('a failed send, which has no signature, is rejected', () => {
  assert.strictEqual(isRealTxHash(null), false);
  assert.strictEqual(isRealTxHash(undefined), false);
  assert.strictEqual(isRealTxHash(''), false);
});

test('near-miss hashes are rejected rather than published', () => {
  assert.strictEqual(isRealTxHash('0x' + 'a'.repeat(63)), false, 'one char short');
  assert.strictEqual(isRealTxHash('0x' + 'a'.repeat(65)), false, 'one char long');
  assert.strictEqual(isRealTxHash('a'.repeat(64)), false, 'missing 0x');
  assert.strictEqual(isRealTxHash('0x' + 'g'.repeat(64)), false, 'non-hex');
  assert.strictEqual(isRealTxHash(12345), false, 'not a string');
});

test('a stored airdrop maps to the field names the site parses', () => {
  const row = toRewardRow({
    id: 7,
    cycle_id: 3,
    reward_token: '0x07ebb29a38fbcb41563817e5e19f2cec619c90d2',
    recipient: '0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952',
    amount_raw: '128400000000000000000000',
    amount_ui: 128400,
    signature: '0x' + 'b'.repeat(64),
    status: 'ok',
    created_at: '2026-08-15T10:00:00.000Z',
  });

  // These four keys are read by tokenmeme6/src/api/rewards.js parseRewards.
  assert.deepStrictEqual(row, {
    wallet_address: '0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952',
    amount: 128400,
    timestamp: '2026-08-15T10:00:00.000Z',
    tx_hash: '0x' + 'b'.repeat(64),
  });
});

test('the recipient address keeps its checksum casing for the explorer link', () => {
  const mixed = '0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952';
  assert.strictEqual(toRewardRow({ recipient: mixed }).wallet_address, mixed);
});

test('a missing amount_ui becomes 0 rather than undefined', () => {
  // The site coerces non-finite to 0 anyway, but sending undefined would drop
  // the key from the JSON entirely, which reads as a malformed row.
  assert.strictEqual(toRewardRow({ recipient: '0xabc' }).amount, 0);
});

test('the feed limit exceeds a single cycle of recipients', () => {
  // A limit below one cycle's recipient count makes the ledger unable to show
  // even one drop — a holder in the older part searches and finds nothing.
  // Observed live: 134 recipients in one cycle against a limit of 100.
  const { FEED_LIMIT } = require('./frontend');
  assert.ok(FEED_LIMIT >= 1000, `FEED_LIMIT is ${FEED_LIMIT}; must clear a cycle with headroom`);
});

test('?limit= is clamped and falls back safely', () => {
  const { parseLimit, FEED_LIMIT, FEED_LIMIT_MAX } = require('./frontend');
  assert.strictEqual(parseLimit(undefined), FEED_LIMIT, 'no param -> default');
  assert.strictEqual(parseLimit('abc'), FEED_LIMIT, 'garbage -> default');
  assert.strictEqual(parseLimit('0'), FEED_LIMIT, 'zero -> default');
  assert.strictEqual(parseLimit('-5'), FEED_LIMIT, 'negative -> default');
  assert.strictEqual(parseLimit('250'), 250, 'in range -> honoured');
  assert.strictEqual(parseLimit('999999'), FEED_LIMIT_MAX, 'oversized -> capped');
});

// ── GET /api/stats: what the site shows ─────────────────────────────────────

test('stats carry the BUN paid out, the BBC burned, and what the burn cost', () => {
  const { buildStats } = require('./frontend');
  const s = buildStats({
    market: { marketCap: 22_000 },
    reward: { totalUi: 1234.5 },
    totals: { total_tokens_burned: 10_000_000, total_eth_spent_burn: 0.42 },
  });
  assert.strictEqual(s.market_cap_usd, 22_000);
  assert.strictEqual(s.total_bun_distributed, 1234.5);
  assert.strictEqual(s.total_bbc_burned, 10_000_000);
  assert.strictEqual(s.burned_pct_of_supply, 1); // 10M of the 1B mint
  assert.strictEqual(s.eth_spent_burning, 0.42);
  assert.ok(Date.parse(s.updated_at) > 0);
});

test('before anything has happened every figure is 0, not null', () => {
  // The panel renders numbers; a null would show as an empty tile, and "no
  // cycles yet" and "a real zero" would become indistinguishable downstream.
  const { buildStats } = require('./frontend');
  const s = buildStats({});
  assert.strictEqual(s.market_cap_usd, 0);
  assert.strictEqual(s.total_bun_distributed, 0);
  assert.strictEqual(s.total_bbc_burned, 0);
  assert.strictEqual(s.burned_pct_of_supply, 0);
});
