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
    reward_token: '0xe0eba1b76b73be7bfa7716b6ca96f724930e2263',
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
