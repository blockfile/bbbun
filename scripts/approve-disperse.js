'use strict';

// Approve the reward token to the disperse contract.
//
//   node scripts/approve-disperse.js            # preview + read current allowance
//   node scripts/approve-disperse.js --confirm  # send the approval
//
// The airdrop path deliberately never calls approve() itself — an unattended
// bot that can hand out token allowances is a bot that can be tricked into
// handing out the wrong one. So it is a one-time manual step, and without it
// every disperse batch reverts ERC20InsufficientAllowance and the cycle
// delivers nothing.
//
// A max approval is safe for a disperser that pulls with
// `transferFrom(msg.sender, …)`: it can only ever move tokens belonging to
// whoever called it, so another caller drains their own wallet, not ours.
// Verify that before pointing DISPERSE_ADDRESS at anything — a contract taking
// an arbitrary `from` parameter must NOT receive an unlimited approval.

const { Contract, MaxUint256, formatUnits } = require('ethers');
const { config, wallet, hr, requireConfirm } = require('./_util');

const ERC20 = [
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

(async () => {
  if (!config.disperseAddress) {
    console.log('DISPERSE_ADDRESS is not set — nothing to approve.');
    console.log('The airdrop uses pipelined individual transfers, which need no approval.');
    process.exit(0);
  }

  const token = new Contract(config.rewardToken, ERC20, wallet);
  const decimals = await token.decimals();

  hr('APPROVE REWARD TOKEN TO DISPERSER');
  console.log('wallet    :', wallet.address);
  console.log('token     :', config.rewardToken, `(${config.rewardSymbol})`);
  console.log('spender   :', config.disperseAddress);

  const [before, balance] = await Promise.all([
    token.allowance(wallet.address, config.disperseAddress),
    token.balanceOf(wallet.address),
  ]);
  console.log('balance   :', formatUnits(balance, decimals), config.rewardSymbol);
  console.log('allowance :', formatUnits(before, decimals), before === 0n ? '  ← zero: every disperse batch will revert' : '');

  if (!(await requireConfirm(`approve unlimited ${config.rewardSymbol} to ${config.disperseAddress}`))) {
    process.exit(0);
  }

  const tx = await token.approve(config.disperseAddress, MaxUint256);
  console.log('sent      :', tx.hash);
  await tx.wait();

  // Read it back rather than trusting the receipt. A token with a non-standard
  // approve (returns false instead of reverting) would otherwise look approved.
  const after = await token.allowance(wallet.address, config.disperseAddress);
  console.log('allowance :', after === MaxUint256 ? 'unlimited' : formatUnits(after, decimals));

  if (after === 0n) {
    console.error('\n❌ allowance is still zero — the approval did not take. Do not restart the bot yet.');
    process.exit(1);
  }
  console.log('\n✅ approved. The next cycle can disperse.');
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ approve failed:', e.shortMessage || e.message);
  process.exit(1);
});
