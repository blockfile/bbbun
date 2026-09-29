'use strict';

// The scripts are the only place an operator can send a transaction by hand,
// so the DRY_RUN promise has to hold there too: with DRY_RUN=true, nothing is
// sent. approve-disperse is the one script that talks to a token contract
// directly rather than through a module that simulates, so it carries its own
// guard — and it runs BEFORE any chain read, which is what lets this test run
// with no network at all.

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'approve-disperse.js');
const run = (env) =>
  execFileSync(process.execPath, [SCRIPT, '--confirm'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      DRY_RUN: 'true',
      // Somewhere nothing listens: a chain call would fail loudly rather than
      // quietly succeed and make this test meaningless.
      RPC_URL: 'http://127.0.0.1:1',
      ...env,
    },
  });

test('approve-disperse sends nothing while DRY_RUN is true, and says how to send it', () => {
  const out = run({ DISPERSE_ADDRESS: '0x0263Da0f8D6B2ae57c7F19bF02B84689307bA7D8' });
  assert.match(out, /DRY_RUN=true — nothing sent/);
  assert.match(out, /DRY_RUN=false npm run approve-disperse -- --confirm/);
  assert.doesNotMatch(out, /sent\s*:/, 'no transaction hash may be printed');
});

test('with no disperser configured it explains that no approval is needed', () => {
  const out = run({ DISPERSE_ADDRESS: '' });
  assert.match(out, /nothing to approve/);
});
