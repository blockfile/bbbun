'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
process.env.REWARD_BUY_PCT = '80';
delete require.cache[require.resolve('../config')];

const { splitClaim } = require('./cycle');

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

// The burn leg was removed from this project by decision. DRY_RUN would happily
// simulate one, so the absence is asserted at the source level instead.
test('the cycle has no burn leg at all', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'cycle.js'), 'utf8');
  assert.doesNotMatch(src, /burnToken|deadAddress|burnPct/, 'the burn leg was removed by design');
});
