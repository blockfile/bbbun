'use strict';
// Buy BABY ROBBIE with native ETH, on whichever venue it currently trades on
// (the bonding curve pre-graduation, the Uniswap v4 pool after).
//   node scripts/buy.js <ethAmount> [--confirm]
const { config, hr, arg, requireConfirm } = require('./_util');
const { getLaunch, describePhase } = require('../src/evm/launch');
const { buyToken } = require('../src/evm/buy');

(async () => {
  hr('BUY TOKEN');
  const ethAmount = Number(arg(0));
  if (!(ethAmount > 0)) {
    console.log('usage: node scripts/buy.js <ethAmount> [--confirm]');
    process.exit(1);
  }
  if (!config.tokenAddress) throw new Error('TOKEN_ADDRESS (BABY ROBBIE) is required');

  const launch = await getLaunch();
  console.log('token      :', config.tokenAddress);
  console.log('phase      :', describePhase(launch));

  if (!(await requireConfirm(`buy ${config.tokenAddress} with ${ethAmount} ETH (native)`))) {
    process.exit(0);
  }
  const result = await buyToken({ launch, token: config.tokenAddress, ethAmount });
  console.log('\nresult:', JSON.stringify(result, null, 2));
  process.exit(0);
})().catch((e) => { console.error('\n❌ buy failed:', e.message); process.exit(1); });
