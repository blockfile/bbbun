'use strict';
// Run ONE full cycle (sweep -> claim -> split -> buy ROBBIE -> airdrop) and
// print the persisted result. The integration test.
//   node scripts/run-once.js [--confirm]
const { hr, requireConfirm } = require('./_util');
const db = require('../src/db');
const { runCycle } = require('../src/jobs/cycle');

(async () => {
  hr('RUN ONE FULL CYCLE');
  if (!(await requireConfirm('run one full cycle (sweep -> claim -> buy ROBBIE -> airdrop to BABY ROBBIE holders)'))) {
    process.exit(0);
  }
  await db.connect();
  const cycle = await runCycle();
  console.log('\ncycle result:');
  console.log(JSON.stringify(cycle, null, 2));
  await db.close();
  process.exit(0);
})().catch((e) => { console.error('\n❌ run-once failed:', e.message); process.exit(1); });
