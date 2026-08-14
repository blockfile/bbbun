'use strict';

// The V2FeeEscrow is where BOTH phases deliver the creator's share, in native
// ETH. It is the only withdrawal path, and the amount is read from the
// contract's own Claimed event rather than a native-balance delta, which gas
// would pollute.

const { Contract, Interface, formatEther } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');
const { ESCROW_ABI } = require('./abi');
const simvault = require('./simvault');

const ESCROW_IFACE = new Interface(ESCROW_ABI);
const CLAIMED_TOPIC = ESCROW_IFACE.getEvent('Claimed').topicHash;

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function escrow(runner = provider) {
  return new Contract(config.feeEscrow, ESCROW_ABI, runner);
}

/** Native ETH already swept into the escrow and withdrawable right now. */
async function escrowBalanceEth() {
  if (config.dryRun) return simvault.peek();
  return Number(formatEther(await escrow().balanceOf(wallet.address)));
}

/** Withdraw the whole escrow balance. Amount comes from the Claimed event. */
async function claimFromEscrow() {
  if (config.dryRun) {
    const ethClaimed = +simvault.drain().toFixed(9);
    return { signature: fakeSig('claim'), ethClaimed, simulated: true };
  }

  const balance = await escrow().balanceOf(wallet.address);
  if (balance <= 0n) {
    return { signature: null, ethClaimed: 0, simulated: false, note: 'escrow empty' };
  }

  const tx = await escrow(wallet).claim();
  const receipt = await tx.wait();
  console.log(`[tx] claim from fee escrow: ${tx.hash}`);

  const me = wallet.address.toLowerCase();
  let claimed = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== config.feeEscrow.toLowerCase()) continue;
    if (log.topics[0] !== CLAIMED_TOPIC) continue;
    const parsed = ESCROW_IFACE.parseLog({ topics: [...log.topics], data: log.data });
    if (parsed.args.recipient.toLowerCase() === me) claimed += parsed.args.amount;
  }

  return { signature: tx.hash, ethClaimed: Number(formatEther(claimed)), simulated: false };
}

module.exports = { escrowBalanceEth, claimFromEscrow, escrow };
