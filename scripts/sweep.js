'use strict';
// Sweep pending fees into the escrow (best-effort — see README on
// InternalSwapRequiresOperator, which this treats as expected, not a fault).
//   node scripts/sweep.js [--confirm]
const { hr, requireConfirm } = require('./_util');
const { getLaunch, describePhase } = require('../src/evm/launch');
const { sweepFees, sweepableEth } = require('../src/evm/sweep');

(async () => {
  const launch = await getLaunch();
  hr(`SWEEP (${describePhase(launch)})`);
  const pending = await sweepableEth(launch);
  console.log('pending    :', pending, 'ETH');

  if (!(await requireConfirm(`sweep ~${pending} ETH of pending fees into the escrow`))) {
    process.exit(0);
  }
  const r = await sweepFees(launch);
  console.log(r.swept ? `\n✅ swept: ${r.signature}` : `\n⏭️  skipped: ${r.reason}`);
  process.exit(0);
})().catch((e) => { console.error('\n❌ sweep failed:', e.message); process.exit(1); });
