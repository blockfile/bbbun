'use strict';

// Distribute reward tokens a FAILED cycle bought but never paid out.
//
// A cycle claims the escrow, buys BUN, and only then lists holders. If it dies
// in between — three cycles did, on the explorer answering 403 — the ETH is
// already spent and the BUN is sitting in the wallet, but no later cycle will
// ever touch it: each one distributes only what IT bought. The amount would
// stay stranded forever.
//
//   node scripts/recover-airdrop.js --bun 319.163
//   node scripts/recover-airdrop.js --bun 319.163 --confirm
//
// The amount is given EXPLICITLY and never inferred from the wallet balance.
// The signing wallet is also the dev wallet and may hold BUN that is nobody's
// but yours; a script that handed out "whatever is there" would give it away.
// Add up the "[reward] bought N BUN" lines of the failed cycles and pass that.
//
// The work is recorded as a real cycle, so /api/stats, /api/rewards and the
// site's "Total $BUN Rewarded" include it and holders see the payout.

const { formatUnits, parseUnits } = require('ethers');
const { config, wallet, hr, hasFlag } = require('./_util');
const db = require('../src/db');
const repo = require('../src/db/repository');
const { getLaunch } = require('../src/evm/launch');
const { distributeReward, summarizeReward } = require('../src/jobs/cycle');
const { erc20 } = require('../src/evm/erc20');

function amountArg() {
  const i = process.argv.indexOf('--bun');
  if (i === -1 || i + 1 >= process.argv.length) return null;
  const v = process.argv[i + 1];
  if (!/^\d*\.?\d+$/.test(v) || Number(v) <= 0) {
    console.error(`--bun must be a positive decimal amount, got: ${v}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const amount = amountArg();
  if (!amount) {
    console.error('Nothing to do. Pass the amount from the failed cycles\' logs:\n');
    console.error('    node scripts/recover-airdrop.js --bun 319.163\n');
    console.error('Add up their "[reward] bought N BUN" lines. The amount is never guessed');
    console.error('from the wallet balance — your own BUN would be given away with it.');
    process.exit(1);
  }
  if (!config.tokenAddress) {
    console.error('TOKEN_ADDRESS is not set — there is no holder list to pay.');
    process.exit(1);
  }

  const token = erc20(config.rewardToken);
  const decimals = await token.decimals();
  const raw = parseUnits(amount, decimals);
  const held = await token.balanceOf(wallet.address);

  hr('RECOVER: AIRDROP STRANDED REWARD TOKENS');
  console.log('wallet    :', wallet.address);
  console.log('token     :', config.rewardToken, `(${config.rewardSymbol})`);
  console.log('in wallet :', formatUnits(held, decimals), config.rewardSymbol);
  console.log('to pay out:', amount, config.rewardSymbol);

  if (raw > held) {
    console.error(`\n❌ the wallet holds ${formatUnits(held, decimals)} ${config.rewardSymbol}, less than the ${amount} asked for.`);
    process.exit(1);
  }

  if (!hasFlag('--confirm')) {
    console.log('\n[preview only] would airdrop the amount above, pro-rata, to holders over MIN_HOLD.');
    console.log(`Re-run with --confirm to send. ${config.dryRun ? '(DRY_RUN=true → simulated)' : '(DRY_RUN=false → REAL transfers)'}`);
    process.exit(0);
  }
  if (!config.dryRun) {
    console.log('\n⚠️  LIVE — sending real transfers in 3s… (Ctrl+C to abort)');
    await new Promise((r) => setTimeout(r, 3000));
  }

  await db.connect();
  const launch = await getLaunch();
  const id = await repo.createCycle({ dryRun: config.dryRun });
  console.log(`\n[cycle ${id}] recovering ${amount} ${config.rewardSymbol}`);

  try {
    const out = await distributeReward(id, { launch, tokensRaw: raw.toString(), label: 'recover' });
    const outcome = summarizeReward({ ...out, skipped: false });
    await repo.finishCycle(id, {
      status: outcome.status,
      mode: 'recover',
      phase: launch.graduated ? 'v4' : 'curve',
      // No claim and no buy happened here: this pays out what an earlier cycle
      // already bought, so eth_claimed and eth_spent_buy stay 0 and the ETH
      // totals are not double-counted.
      eth_claimed: 0,
      eth_spent_buy: 0,
      tokens_bought: 0,
      eligible_holders: out.eligibleHolders,
      total_holders: out.totalHolders,
      note: `recovery: ${outcome.note}`,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    console.log(`\n${outcome.status === 'complete' ? '✅' : '❌'} ${outcome.note}`);
    if (outcome.error) console.error(outcome.error);
  } catch (err) {
    const message = err.shortMessage || err.message;
    await repo.addStep({ cycleId: id, name: 'error', status: 'failed', detail: { message } });
    await repo.finishCycle(id, { status: 'failed', mode: 'recover', error: message });
    console.error('\n❌ recovery failed:', message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('\nrecovery failed:', err.shortMessage || err.message);
  process.exit(1);
});
