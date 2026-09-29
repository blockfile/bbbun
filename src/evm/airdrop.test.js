'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');

// ── The disperser's allowance, checked before the batches ───────────────────

test('an allowance smaller than the airdrop stops it, naming the wallet and the fix', () => {
  const { allowanceProblem } = require('./airdrop');
  const why = allowanceProblem({
    allowance: 0n,
    total: 319163408136567583057n,
    owner: '0xBd1bb7cC7e50061B41A8f60BeE326949003577ff',
    spender: '0xD3ca7d7b76f3A3aeFa88980722cD951D3B2D301d',
    symbol: 'BUN',
  });
  assert.match(why, /0xBd1bb7cC7e50061B41A8f60BeE326949003577ff/, 'the wallet that must approve');
  assert.match(why, /0xD3ca7d7b76f3A3aeFa88980722cD951D3B2D301d/, 'the spender');
  assert.match(why, /approve-disperse -- --confirm/, 'the exact command');
  assert.match(why, /another wallet does not help/, 'the real cause when a key changes');
});

test('enough allowance is no problem, and exactly enough counts', () => {
  const { allowanceProblem } = require('./airdrop');
  const args = { owner: '0xowner', spender: '0xspender', symbol: 'BUN' };
  assert.strictEqual(allowanceProblem({ allowance: 100n, total: 100n, ...args }), null);
  assert.strictEqual(allowanceProblem({ allowance: 2n ** 256n - 1n, total: 10n ** 24n, ...args }), null);
  assert.ok(allowanceProblem({ allowance: 99n, total: 100n, ...args }));
});
