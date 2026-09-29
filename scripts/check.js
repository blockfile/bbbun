'use strict';
// Read-only preflight. Sends NO transactions.
//   node scripts/check.js
const { Contract, formatEther } = require('ethers');
const { config, provider, wallet, hr } = require('./_util');

(async () => {
  hr('CONFIG');
  console.log('dryRun     :', config.dryRun);
  console.log('rpcUrl     :', config.rpcUrl, `(chain ${config.chainId})`);
  console.log('wallet     :', wallet.address, config.walletIsEphemeral ? '⚠️ EPHEMERAL — set WALLET_PRIVATE_KEY' : '');
  console.log('token      :', config.tokenAddress || '⚠️ MISSING — set TOKEN_ADDRESS (BABYBUNDLECAT)');
  console.log('reward     :', config.rewardToken, `(${config.rewardSymbol} — bought + airdropped)`);
  console.log(
    'split      :',
    `${config.rewardBuyPct}% buy ${config.rewardSymbol} for holders / ` +
      `${config.burnPct}% buy ${config.tokenSymbol} and burn / ${config.devPct}% dev+gas (kept as ETH)`
  );
  console.log('burn to    :', config.deadAddress);
  console.log(
    'trigger    :',
    config.triggerMode === 'accumulation'
      ? (config.claimEveryUsd > 0
          ? `every $${config.claimEveryUsd} of claimable fees (fallback ${config.claimEveryEth} ETH if the price is missing)`
          : `every ${config.claimEveryEth} ETH claimable`)
      : 'every poll, whatever has accrued',
    `on "${config.pollSchedule}"`
  );
  console.log('minHold    :', config.minHold, `${config.tokenSymbol} to qualify`);

  hr('WIRING (read from the factory, not trusted from env)');
  const { FACTORY_V2_ABI, HOOK_ABI } = require('../src/evm/abi');
  const f = new Contract(config.v2Factory, FACTORY_V2_ABI, provider);
  const [escrow, hook] = await Promise.all([f.feeEscrow(), f.memeHook()]);
  console.log('feeEscrow  :', escrow, escrow.toLowerCase() === config.feeEscrow ? '✓' : '⚠️ DIFFERS from FEE_ESCROW');
  console.log('memeHook   :', hook, hook.toLowerCase() === config.memeHook ? '✓' : '⚠️ DIFFERS from MEME_HOOK');
  const pm = await new Contract(hook, HOOK_ABI, provider).poolManager();
  console.log('poolManager:', pm, pm.toLowerCase() === config.poolManager ? '✓' : '⚠️ DIFFERS from POOL_MANAGER');

  hr('RPC + WALLET BALANCE');
  const net = await provider.getNetwork();
  console.log('chainId    :', Number(net.chainId), Number(net.chainId) === config.chainId ? '✓' : '⚠️ unexpected');
  console.log('ETH balance:', formatEther(await provider.getBalance(wallet.address)), 'ETH');

  if (!config.tokenAddress) {
    console.log('\nSet TOKEN_ADDRESS to run the remaining checks.');
    process.exit(0);
  }

  hr('PONS V2 LAUNCH RECORD');
  const { getLaunch, describePhase } = require('../src/evm/launch');
  const launch = await getLaunch();
  console.log('phase      :', describePhase(launch), launch.graduated ? '(graduated — trades on Uniswap v4)' : '(on the bonding curve)');
  console.log('curve      :', launch.curve);
  console.log('deployer   :', launch.deployer);
  const isRecipient = launch.creatorFeeRecipient.toLowerCase() === wallet.address.toLowerCase();
  console.log('feeRecip.  :', launch.creatorFeeRecipient, isRecipient
    ? '✓ (this wallet — authorized to sweep AND claim)'
    : '⚠️ NOT this wallet — it cannot sweep or claim, and the cycle will starve');
  console.log('creatorTax :', launch.creatorTaxBps, 'bps');
  console.log('buyback    :', launch.buybackEnabled);
  if (launch.graduated) console.log('poolId     :', launch.poolId);
  else console.log('graduation :', formatEther(launch.graduationThreshold), 'ETH threshold');

  hr('CLAIMABLE');
  const { escrowBalanceEth } = require('../src/evm/escrow');
  const { sweepableEth } = require('../src/evm/sweep');
  const [inEscrow, pending] = await Promise.all([escrowBalanceEth(), sweepableEth(launch)]);
  console.log('in escrow  :', inEscrow, 'ETH (claimable now)');
  console.log('unswept    :', pending, 'ETH (needs a sweep first)');
  console.log('total      :', inEscrow + pending, 'ETH');

  console.log('\n✅ preflight complete (no transactions sent)');
  process.exit(0);
})().catch((e) => { console.error('\n❌ check failed:', e.message); process.exit(1); });
