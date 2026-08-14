'use strict';
// Withdraw the whole V2FeeEscrow balance to this wallet, as native ETH.
//   node scripts/claim.js [--confirm]
const { hr, requireConfirm } = require('./_util');
const { escrowBalanceEth, claimFromEscrow } = require('../src/evm/escrow');

(async () => {
  hr('CLAIM FROM ESCROW');
  const inEscrow = await escrowBalanceEth();
  console.log('in escrow  :', inEscrow, 'ETH (claimable now)');

  if (!(await requireConfirm(`claim ~${inEscrow} ETH from the fee escrow`))) {
    process.exit(0);
  }
  const result = await claimFromEscrow();
  console.log('\nresult:', JSON.stringify(result, null, 2));
  process.exit(0);
})().catch((e) => { console.error('\n❌ claim failed:', e.message); process.exit(1); });
