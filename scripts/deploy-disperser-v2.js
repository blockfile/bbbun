'use strict';

// Compile and deploy contracts/TokenDisperserV2.sol.
//
// Same disperseToken signature as v1, so the bot needs no code change - only
// DISPERSE_ADDRESS. The difference is who the chain records as the SENDER of
// each payout: v1 pulls straight from the operator to every holder, so all N
// transfers read `from = the operator's wallet` and bubblemap tools draw a star
// on it. v2 pulls once and pays from its own balance, so the operator shows a
// single edge per batch.
//
//   node scripts/deploy-disperser-v2.js            # compile only, print the bytecode size
//   node scripts/deploy-disperser-v2.js --confirm  # actually deploy (sends a transaction)
//
// Requires solc, which is NOT a dependency of this project — it is needed once,
// for a deployment that happens once:
//
//   npm i solc --no-save
//
// Compiled against evmVersion "paris" on purpose. Later targets emit PUSH0,
// which some chains and forks do not implement; paris avoids it at no
// meaningful cost, and a disperser that reverts on every call because of an
// unsupported opcode is a bad way to find out.

const fs = require('node:fs');
const path = require('node:path');
const { ContractFactory, formatEther } = require('ethers');

// This script is what PRODUCES a disperser address, so whatever DISPERSE_ADDRESS
// holds right now is irrelevant to it — and must not stop it. config refuses an
// invalid one at startup (a leftover placeholder otherwise surfaces mid-cycle as
// ethers' "network does not support ENS"), which would lock the operator out of
// the one command that fixes it. Set before requiring config: dotenv never
// overwrites a key already present in process.env.
process.env.DISPERSE_ADDRESS = '';

const config = require('../src/config');
const { provider, wallet } = require('../src/evm/provider');

const SOURCE = path.join(__dirname, '..', 'contracts', 'TokenDisperserV2.sol');
const NAME = 'TokenDisperserV2';

function compile() {
  let solc;
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    solc = require('solc');
  } catch (_err) {
    console.error('solc is not installed. It is needed only for this one-off deployment:\n');
    console.error('    npm i solc --no-save\n');
    process.exit(1);
  }

  const source = fs.readFileSync(SOURCE, 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'TokenDisperserV2.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) {
    for (const e of errors) console.error(e.formattedMessage);
    process.exit(1);
  }
  for (const w of (out.errors || []).filter((e) => e.severity !== 'error')) {
    console.warn(w.formattedMessage);
  }

  const c = out.contracts['TokenDisperserV2.sol'][NAME];
  return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}`, solcVersion: solc.version() };
}

async function main() {
  const confirm = process.argv.includes('--confirm');

  const { abi, bytecode, solcVersion } = compile();
  console.log(`compiled ${NAME}`);
  console.log(`  solc      : ${solcVersion}`);
  console.log(`  bytecode  : ${(bytecode.length - 2) / 2} bytes`);
  console.log(`  functions : ${abi.filter((f) => f.type === 'function').map((f) => f.name).join(', ')}`);

  if (!confirm) {
    console.log('\nDry run — nothing sent. Re-run with --confirm to deploy.');
    return;
  }

  const net = await provider.getNetwork();
  const balance = await provider.getBalance(wallet.address);
  console.log('\ndeploying');
  console.log(`  chain     : ${Number(net.chainId)}`);
  console.log(`  from      : ${wallet.address}`);
  console.log(`  balance   : ${formatEther(balance)} ETH`);

  if (balance === 0n) {
    console.error('\nThat wallet has no ETH — fund it before deploying.');
    process.exit(1);
  }

  const factory = new ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy();
  console.log(`  tx        : ${contract.deploymentTransaction().hash}`);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log(`\n✅ deployed at ${address}`);
  console.log('\nNext:');
  console.log(`  1. REPLACE the existing line in .env  ->  DISPERSE_ADDRESS=${address}`);
  console.log('  2. pm2 restart all --update-env');
  console.log(`  3. npm run approve-disperse -- --confirm   (approve ${config.rewardSymbol} to it)`);
  console.log('');
  console.log('Step 3 is NOT optional and is NOT automatic: the airdrop path never');
  console.log('calls approve() itself, because an unattended bot that can hand out');
  console.log('token allowances is one that can be tricked into handing them out.');
  console.log('Without the approval every disperse batch reverts and nobody is paid.');
  console.log('');
  console.log('Replacing an earlier disperser? The old one keeps working and needs no');
  console.log('action; it is simply no longer used.');
}

main().catch((err) => {
  console.error('\ndeploy failed:', err.shortMessage || err.message);
  process.exit(1);
});
