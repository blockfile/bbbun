'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
process.env.REWARD_BUY_PCT = '80';
delete require.cache[require.resolve('../config')];

const {
  splitClaim,
  summarizeReward,
  isFeeRecipientOk,
  feeRecipientWarning,
} = require('./cycle');

test('splits a claim 80 / 20', () => {
  const s = splitClaim(1);
  assert.strictEqual(s.rewardEth, 0.8);
  assert.strictEqual(s.devEth, 0.2);
});

test('the two legs always re-add to the claim', () => {
  for (const claim of [0.001, 0.5, 1, 3.14159, 21.368470124]) {
    const s = splitClaim(claim);
    const total = s.rewardEth + s.devEth;
    assert.ok(Math.abs(total - claim) < 1e-9, `claim ${claim} lost ${claim - total}`);
  }
});

test('a zero claim produces zero legs', () => {
  const s = splitClaim(0);
  assert.strictEqual(s.rewardEth, 0);
  assert.strictEqual(s.devEth, 0);
});

// ── How a cycle finishes (I1) ───────────────────────────────────────────────
// `sent === 0` has two completely different meanings and they must not be
// recorded the same way: nobody was eligible (fine) vs. the airdrop reached
// nobody (the ROBBIE is stranded and every later cycle buys more).
test('an airdrop that reached NOBODY fails the cycle, naming the likely cause', () => {
  const o = summarizeReward({ recipients: 42, sent: 0, failed: 42 });
  assert.strictEqual(o.status, 'failed');
  assert.match(o.error, /0 of 42/);
  assert.match(o.error, /DISPERSE_ADDRESS/);
  assert.match(o.error, /approve\(\)/);
  assert.match(o.error, /reverting/);
  assert.match(o.error, /still sitting in the wallet/);
});

test('a cycle with no eligible holders completes with a note, not a failure', () => {
  const o = summarizeReward({ recipients: 0, sent: 0, failed: 0 });
  assert.strictEqual(o.status, 'complete');
  assert.strictEqual(o.error, undefined);
  assert.match(o.note, /no eligible holders/);
});

test('a partially delivered airdrop completes but records the failures', () => {
  const o = summarizeReward({ recipients: 10, sent: 7, failed: 3 });
  assert.strictEqual(o.status, 'complete');
  assert.match(o.note, /sent 7, 3 failed/);
});

test('a fully delivered airdrop completes', () => {
  const o = summarizeReward({ recipients: 3, sent: 3, failed: 0 });
  assert.strictEqual(o.status, 'complete');
  assert.match(o.note, /sent 3/);
});

test('a skipped reward leg still completes the cycle (C1 floor)', () => {
  const o = summarizeReward({ skipped: true, reason: '5.6e-7 ETH is below MIN_REWARD_ETH (0.000001)' });
  assert.strictEqual(o.status, 'complete');
  assert.match(o.note, /reward leg skipped: 5.6e-7 ETH is below MIN_REWARD_ETH/);
});

// ── creatorFeeRecipient (I4) ────────────────────────────────────────────────
test('the fee-recipient check is case-insensitive', () => {
  const addr = '0xAbC0000000000000000000000000000000000123';
  assert.strictEqual(isFeeRecipientOk({ creatorFeeRecipient: addr.toLowerCase() }, addr), true);
  assert.strictEqual(isFeeRecipientOk({ creatorFeeRecipient: addr.toUpperCase() }, addr), true);
  assert.strictEqual(feeRecipientWarning({ creatorFeeRecipient: addr.toLowerCase() }, addr), null);
});

test('a fee-recipient mismatch warns loudly, naming both addresses', () => {
  const mine = '0x1111111111111111111111111111111111111111';
  const theirs = '0x2222222222222222222222222222222222222222';
  assert.strictEqual(isFeeRecipientOk({ creatorFeeRecipient: theirs }, mine), false);
  const w = feeRecipientWarning({ creatorFeeRecipient: theirs }, mine);
  assert.match(w, /creatorFeeRecipient MISMATCH/);
  assert.ok(w.includes(mine) && w.includes(theirs), 'must name both addresses');
  assert.match(w, /cannot claim/);
});

test('a missing creatorFeeRecipient is a mismatch, not a pass', () => {
  const mine = '0x1111111111111111111111111111111111111111';
  assert.strictEqual(isFeeRecipientOk({}, mine), false);
  assert.strictEqual(isFeeRecipientOk({ creatorFeeRecipient: mine }, ''), false);
});

// The burn leg was removed from this project by decision. DRY_RUN would happily
// simulate one, so the absence is asserted at the source level instead.
test('the cycle has no burn leg at all', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'cycle.js'), 'utf8');
  assert.doesNotMatch(src, /burnToken|deadAddress|burnPct/, 'the burn leg was removed by design');
});
