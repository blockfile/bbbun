'use strict';
require('dotenv').config();
const { Wallet } = require('ethers');

function bool(v, d) { if (v === undefined || v === '') return d; return ['1','true','yes','on'].includes(String(v).toLowerCase()); }
function num(v, d) { if (v === undefined || v === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; }
const lowerOrNull = (v) => (v ? String(v).trim().toLowerCase() : null);
const lowerOr = (v, d) => lowerOrNull(v) || d;

function parseClusters(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(Array.isArray)
      .map((g) => g.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim()))
      .filter((g) => g.length > 0);
  } catch (_err) {
    console.warn('[babyrobbie] CLUSTERS is not valid JSON — ignoring');
    return [];
  }
}

const DRY_RUN = bool(process.env.DRY_RUN, true);

function loadWallet() {
  const raw = process.env.WALLET_PRIVATE_KEY;
  if (!raw) {
    if (!DRY_RUN) throw new Error('WALLET_PRIVATE_KEY is required when DRY_RUN=false');
    return { wallet: Wallet.createRandom(), ephemeral: true };
  }
  try {
    const key = raw.trim().startsWith('0x') ? raw.trim() : `0x${raw.trim()}`;
    return { wallet: new Wallet(key), ephemeral: false };
  } catch (err) {
    throw new Error(`Could not parse WALLET_PRIVATE_KEY: ${err.message}`);
  }
}
const { wallet, ephemeral: walletIsEphemeral } = loadWallet();

const rewardBuyPct = num(process.env.REWARD_BUY_PCT, 80);
if (!(rewardBuyPct >= 0 && rewardBuyPct <= 100)) {
  throw new Error(`invalid split: REWARD_BUY_PCT(${rewardBuyPct}) must be within [0, 100]`);
}
// The dev cut is defined as the remainder. toFixed(6) keeps a fractional reward
// share from leaving float dust behind (100 - 80.1 is 19.900000000000006 in FP).
const devPct = +(100 - rewardBuyPct).toFixed(6);

const triggerMode = ['interval', 'accumulation'].includes(String(process.env.TRIGGER_MODE || 'interval').toLowerCase())
  ? String(process.env.TRIGGER_MODE || 'interval').toLowerCase() : 'interval';

const config = {
  port: num(process.env.PORT, 3000),
  dryRun: DRY_RUN,
  rpcUrl: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  chainId: num(process.env.CHAIN_ID, 4663),
  explorerApi: (process.env.EXPLORER_API || 'https://robinhoodchain.blockscout.com').replace(/\/$/, ''),
  wallet,
  walletIsEphemeral,

  // pons v2 + Uniswap v4 wiring (verified 2026-08-14; all overridable).
  v2Factory: lowerOr(process.env.PONS_V2_FACTORY, '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e'),
  memeHook: lowerOr(process.env.MEME_HOOK, '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044'),
  feeEscrow: lowerOr(process.env.FEE_ESCROW, '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e'),
  buybackVault: lowerOr(process.env.BUYBACK_VAULT, '0x42df2a798f82289e177311362e8f5ccc45c1219c'),
  poolManager: lowerOr(process.env.POOL_MANAGER, '0x8366a39cc670b4001a1121b8f6a443a643e40951'),
  universalRouter: lowerOr(process.env.UNIVERSAL_ROUTER, '0x8876789976decbfcbbbe364623c63652db8c0904'),
  stateView: lowerOr(process.env.STATE_VIEW, '0x0284cb0bcbaa8b87a8aa409d0e41afa7a76355f2'),
  v4Quoter: lowerOr(process.env.V4_QUOTER, '0x5c3db48cfd8352d845fac70009d714f0ce1d7914'),

  tokenAddress: lowerOrNull(process.env.TOKEN_ADDRESS),
  tokenSymbol: process.env.TOKEN_SYMBOL || 'BABYROBBIE',
  rewardToken: lowerOr(process.env.REWARD_TOKEN, '0xe0eba1b76b73be7bfa7716b6ca96f724930e2263'),
  rewardSymbol: process.env.REWARD_SYMBOL || 'ROBBIE',

  rewardBuyPct,
  devPct,
  // Floor for the reward leg. Below this the buy+airdrop is skipped cleanly for
  // the cycle — the dust stays in the wallet as native ETH — instead of being
  // attempted with an amount too small to be worth a swap's gas. The default is
  // the 1e-6 ETH boundary where a JS Number stops stringifying in plain decimal.
  minRewardEth: Math.max(0, num(process.env.MIN_REWARD_ETH, 0.000001)),
  slippagePct: num(process.env.SLIPPAGE_PCT, 5),
  gasReserveEth: num(process.env.GAS_RESERVE_ETH, 0.005),
  deadAddress: lowerOr(process.env.DEAD_ADDRESS, '0x000000000000000000000000000000000000dead'),

  minHold: num(process.env.MIN_HOLD, 100000),
  rewardCapPct: num(process.env.REWARD_CAP_PCT, 0),
  clusters: parseClusters(process.env.CLUSTERS),
  airdropBatchSize: num(process.env.AIRDROP_BATCH_SIZE, 30),
  airdropGasLimit: num(process.env.AIRDROP_GAS_LIMIT, 120000),
  disperseAddress: lowerOrNull(process.env.DISPERSE_ADDRESS),
  airdropExclude: (process.env.AIRDROP_EXCLUDE || '').split(',').map((s) => s.trim()).filter(Boolean),

  triggerMode,
  pollSchedule: process.env.POLL_SCHEDULE || '*/5 * * * *',
  claimEveryEth: num(process.env.CLAIM_EVERY_ETH, 0.005),
  dryRunFeePerPoll: num(process.env.DRY_RUN_FEE_PER_POLL, 0.01),

  dexscreenerChainId: process.env.DEXSCREENER_CHAIN_ID || 'robinhood',
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  mongoDb: process.env.MONGODB_DB || 'babyrobbie',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
  apiKey: process.env.API_KEY || null,
};

module.exports = config;
