# babyrobbie Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a bot that claims BABY ROBBIE's pons v2 creator fees and recycles them into buying ROBBIE for a pro-rata airdrop to BABY ROBBIE holders, a 0.1% BABY ROBBIE buy-and-burn, and a dev cut.

**Architecture:** A cron-driven cycle over a MongoDB-backed step log, fronted by an Express API with SSE. The chain layer targets pons **v2** and switches on one phase flag (`curve.graduated()`): pre-bond it sweeps and buys on the bonding curve, post-bond on the Uniswap v4 pool via UniversalRouter. Both phases claim from the same `V2FeeEscrow`, in native ETH.

**Tech Stack:** Node 20+, CommonJS, Express 4, ethers v6, MongoDB (`mongodb` driver), node-cron, `node:test` + `mongodb-memory-server`.

## Global Constraints

- Node `>=20`. CommonJS (`"type": "commonjs"`). No TypeScript, no ESM.
- `DRY_RUN=true` is the default and MUST simulate every chain call. No test may send a transaction.
- All money math on chain amounts uses `BigInt`. Percentages may use `Number`, but any base-unit value crossing a contract boundary is `BigInt`.
- Native ETH is `address(0)` = `0x0000000000000000000000000000000000000000`. There is no WETH anywhere in this project.
- The bot only ever **buys, transfers and burns**. It never sells, so no Permit2 approval path may be written.
- Chain id `4663` (Robinhood Chain). Every contract address is configurable via env with the verified default baked in.
- Spec: `docs/superpowers/specs/2026-08-14-babyrobbie-design.md`. Read it before Task 1.

### Verified addresses (defaults)

```
PONS_V2_FACTORY   0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
MEME_HOOK         0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044
FEE_ESCROW        0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e
BUYBACK_VAULT     0x42df2a798f82289E177311362e8f5ccC45c1219c
POOL_MANAGER      0x8366a39CC670B4001A1121B8F6A443A643e40951
UNIVERSAL_ROUTER  0x8876789976decbfcbbbe364623c63652db8c0904
STATE_VIEW        0x0284Cb0bcbaa8B87A8AA409D0e41afA7a76355F2
V4_QUOTER         0x5c3db48cFd8352D845fac70009d714F0Ce1d7914
REWARD_TOKEN      0xe0eba1B76b73BE7bfA7716b6Ca96f724930e2263   ($ROBBIE)
DEAD_ADDRESS      0x000000000000000000000000000000000000dEaD
RPC_URL           https://rpc.mainnet.chain.robinhood.com
EXPLORER_API      https://robinhoodchain.blockscout.com
```

### Test fixture (real, read-only)

ROBBIE's graduated pool. `PoolKey(currency0=0x0, currency1=0xe0eba1B7…2263, fee=0, tickSpacing=200, hooks=0xE5e70264…e044)` hashes to poolId
`0x813707ded6381854b2d96c3d942960c5d362244a0903ac7d5c4d471e0c6b175f`. Task 3 asserts this exact value.

### File structure

```
server.js                  Express app, boot, graceful shutdown
src/config.js              env -> validated config (throws on bad split)
src/events.js              EventEmitter bus for SSE
src/db/index.js            Mongo connect/close/getDb
src/db/repository.js       cycles, steps, airdrops, stats
src/evm/provider.js        JsonRpcProvider + Wallet
src/evm/abi.js             every v2/v4 ABI fragment, one place
src/evm/erc20.js           balance/decimals/transfer helpers
src/evm/pool.js            PoolKey build + poolId hash + v4 quote   (PURE + read)
src/evm/launch.js          v2 factory record -> phase descriptor
src/evm/escrow.js          claimable read + claim()
src/evm/sweep.js           curve|hook sweep dispatch + sweepable math
src/evm/curve.js           bonding-curve buy + reads
src/evm/v4router.js        UniversalRouter V4_SWAP encoding          (PURE)
src/evm/buy.js             buy dispatch (curve|v4) + requote/retry
src/evm/burn.js            transfer to dead address
src/evm/holders.js         Blockscout holder snapshot
src/evm/exclude.js         airdrop exclusion set
src/evm/airdrop.js         pipelined/disperse airdrop
src/evm/send.js            nonce-safe single send
src/evm/price.js           ETH/USD for display
src/evm/simvault.js        DRY_RUN fee vault
src/services/distribution.js  weighted allocations (PURE)
src/services/fetchJson.js     retrying JSON fetch
src/services/format.js        public API shapes (PURE)
src/services/countdown.js     next cron run (PURE)
src/services/metrics.js       unclaimed helper
src/services/marketdata.js    DexScreener (optional)
src/jobs/cycle.js          the cycle
src/jobs/scheduler.js      cron + trigger gate
src/routes/{status,cycles,control,metrics,stream,public}.js
src/middleware/auth.js     x-api-key
scripts/{_util,check,sweep,claim,buy,burn,run-once}.js
```

---

### Task 1: Scaffold, config, and the split validator

**Files:**
- Create: `package.json`, `.gitignore` (exists), `src/config.js`, `src/events.js`
- Test: `src/config.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `require('./config')` → object with `dryRun, port, rpcUrl, chainId, explorerApi, wallet, walletIsEphemeral, v2Factory, memeHook, feeEscrow, buybackVault, poolManager, universalRouter, stateView, v4Quoter, tokenAddress, tokenSymbol, rewardToken, rewardSymbol, rewardBuyPct, burnPct, devPct, minBurnEth, slippagePct, gasReserveEth, deadAddress, minHold, rewardCapPct, clusters, airdropBatchSize, airdropGasLimit, disperseAddress, airdropExclude, triggerMode, pollSchedule, claimEveryEth, dryRunFeePerPoll, mongoUri, mongoDb, corsOrigins, apiKey`. Also `require('./events')` → a shared `EventEmitter`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "babyrobbie",
  "version": "0.1.0",
  "private": true,
  "description": "pons v2 reward bot on Robinhood Chain: recycles BABY ROBBIE creator fees into buying + airdropping ROBBIE to holders, buying + burning BABY ROBBIE, and a dev cut (DRY_RUN first).",
  "type": "commonjs",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "test": "node --test",
    "check": "node scripts/check.js",
    "sweep": "node scripts/sweep.js",
    "claim": "node scripts/claim.js",
    "buy": "node scripts/buy.js",
    "burn": "node scripts/burn.js",
    "run-once": "node scripts/run-once.js"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.4.7",
    "ethers": "^6.13.5",
    "express": "^4.21.2",
    "mongodb": "^6.12.0",
    "node-cron": "^3.0.3"
  },
  "devDependencies": { "mongodb-memory-server": "^10.1.4" }
}
```

Run: `npm install`

- [ ] **Step 2: Write the failing config test**

Create `src/config.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');

function loadConfig(env) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  delete require.cache[require.resolve('./config')];
  return require('./config');
}

test('defaults to the 80 / 0.1 / 19.9 split', () => {
  const c = loadConfig({ DRY_RUN: 'true', REWARD_BUY_PCT: '', BURN_PCT: '' });
  assert.strictEqual(c.rewardBuyPct, 80);
  assert.strictEqual(c.burnPct, 0.1);
  assert.strictEqual(c.devPct, 19.9); // must not be 19.900000000000006
});

test('rejects a split that exceeds 100', () => {
  assert.throws(() => loadConfig({ DRY_RUN: 'true', REWARD_BUY_PCT: '95', BURN_PCT: '10' }), /invalid split/);
});

test('allows a fractional burn percentage', () => {
  const c = loadConfig({ DRY_RUN: 'true', REWARD_BUY_PCT: '80', BURN_PCT: '0.5' });
  assert.strictEqual(c.burnPct, 0.5);
  assert.strictEqual(c.devPct, 19.5);
});

test('generates an ephemeral wallet in DRY_RUN with no key', () => {
  const c = loadConfig({ DRY_RUN: 'true', WALLET_PRIVATE_KEY: '' });
  assert.strictEqual(c.walletIsEphemeral, true);
  assert.match(c.wallet.address, /^0x[0-9a-fA-F]{40}$/);
});

test('requires a private key when DRY_RUN is false', () => {
  assert.throws(() => loadConfig({ DRY_RUN: 'false', WALLET_PRIVATE_KEY: '' }), /WALLET_PRIVATE_KEY is required/);
});

test('ships the verified v2 addresses as defaults', () => {
  const c = loadConfig({ DRY_RUN: 'true', PONS_V2_FACTORY: '', MEME_HOOK: '', FEE_ESCROW: '' });
  assert.strictEqual(c.v2Factory, '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e');
  assert.strictEqual(c.memeHook, '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044');
  assert.strictEqual(c.feeEscrow, '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test src/config.test.js`
Expected: FAIL — `Cannot find module './config'`

- [ ] **Step 4: Write `src/config.js`**

Model it on `d:/projects/ponsliqui/src/config.js`, with these differences: no WETH, no swapRouter, no ponsLocker, no protocolFeeSharePct; add the v2/v4 addresses and `minBurnEth`. Key section:

```js
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
const burnPct = num(process.env.BURN_PCT, 0.1);
if (rewardBuyPct < 0 || burnPct < 0 || rewardBuyPct + burnPct > 100) {
  throw new Error(`invalid split: REWARD_BUY_PCT(${rewardBuyPct}) + BURN_PCT(${burnPct}) must be within [0, 100]`);
}
// toFixed(6) kills float drift: 100 - 80 - 0.1 is 19.900000000000006 in binary FP.
const devPct = +(100 - rewardBuyPct - burnPct).toFixed(6);

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
  burnPct,
  devPct,
  // 0.1% of a small claim is dust below gas cost. Below this the burn leg is
  // skipped rather than attempted; it does NOT roll into the next cycle.
  minBurnEth: num(process.env.MIN_BURN_ETH, 0.0001),
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
```

Also create `src/events.js`:

```js
'use strict';
const { EventEmitter } = require('node:events');
const bus = new EventEmitter();
bus.setMaxListeners(100); // one listener per connected SSE client
module.exports = bus;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test src/config.test.js`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/config.js src/config.test.js src/events.js
git commit -m "Scaffold the project and validate the fee split"
```

---

### Task 2: Provider, ABIs, and ERC-20 helpers

**Files:**
- Create: `src/evm/provider.js`, `src/evm/abi.js`, `src/evm/erc20.js`
- Test: `src/evm/erc20.test.js`

**Interfaces:**
- Consumes: `config` from Task 1.
- Produces:
  - `provider.js` → `{ provider, wallet, walletAddress() }`
  - `abi.js` → `{ FACTORY_V2_ABI, CURVE_ABI, HOOK_ABI, ESCROW_ABI, ERC20_ABI, UNIVERSAL_ROUTER_ABI, V4_QUOTER_ABI, STATE_VIEW_ABI, DISPERSE_ABI, POOL_KEY_TYPE, EXACT_IN_SINGLE_TYPE }`
  - `erc20.js` → `erc20(address, runner?)`, `getDecimals(address) -> Promise<number>`, `readTokenBalance(token, owner) -> Promise<bigint>`, `getTokenSupplyRaw(token) -> Promise<bigint>`

- [ ] **Step 1: Write `src/evm/provider.js`**

```js
'use strict';
const { JsonRpcProvider, Wallet } = require('ethers');
const config = require('../config');

// staticNetwork: the chain id never changes, so skip ethers' per-call
// eth_chainId round trip. On a load-balanced RPC that doubled every read.
const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true });
const wallet = new Wallet(config.wallet.privateKey, provider);

function walletAddress() {
  return wallet.address;
}

module.exports = { provider, wallet, walletAddress };
```

- [ ] **Step 2: Write `src/evm/abi.js`**

Transcribed from the verified sources. Field order in `LaunchInfo` and `PoolKey` is load-bearing — do not reorder.

```js
'use strict';

// ABIs for the pons v2 protocol and Uniswap v4 periphery on Robinhood Chain.
// Transcribed from VERIFIED sources on Blockscout, 2026-08-14:
//   PonsV2LaunchFactory  0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
//   V2MemeHook           0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044
//   V2FeeEscrow          0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e
//   PonsV2BondingCurve   one per launch
// Struct field ORDER matters — abi.encode of PoolKey is what produces poolId.

const POOL_KEY_TYPE = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const EXACT_IN_SINGLE_TYPE =
  `(${POOL_KEY_TYPE} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`;
const QUOTE_SINGLE_TYPE = `(${POOL_KEY_TYPE} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData)`;

const FACTORY_V2_ABI = [
  'function getLaunchedToken(address token) view returns (tuple(address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))',
  'function feeEscrow() view returns (address)',
  'function memeHook() view returns (address)',
  'function buybackVault() view returns (address)',
  'function maxCreatorTaxBps() view returns (uint256)',
];

const CURVE_ABI = [
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sweepFees(uint256 minBuybackTokensOut)',
  'function graduated() view returns (bool)',
  'function readyToGraduate() view returns (bool)',
  'function isNativeQuote() view returns (bool)',
  'function pairToken() view returns (address)',
  'function token() view returns (address)',
  'function deployer() view returns (address)',
  'function feeEscrow() view returns (address)',
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function realQuoteReserve() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function quoteFeeBalance() view returns (uint256)',
  'function creatorTaxBalance() view returns (uint256)',
  'function buybackQuoteBalance() view returns (uint256)',
  'function protocolFeeShareBps() view returns (uint16)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function sellableTokens() view returns (uint256)',
];

// LaunchInfo field order, from V2MemeHook.sol:48.
const HOOK_ABI = [
  'function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)',
  'function launches(bytes32) view returns (bool registered, bool memecoinIsCurrency0, address memecoin, address quoteToken, address creator, address buybackCreatorRecipient, address protocolFeeRecipient, uint16 creatorTaxBps, uint16 protocolFeeShareBps, uint16 buybackBurnBps, uint16 hookFeeBps, uint16 maxInternalPriceImpactBps, bool buybackEnabled)',
  'function pendingFees(bytes32, address) view returns (uint256)',
  'function pendingCreatorTax(bytes32, address) view returns (uint256)',
  'function pendingBuyback(bytes32, address) view returns (uint256)',
  'function poolManager() view returns (address)',
  'function feeEscrow() view returns (address)',
  'function feeSweepOperator() view returns (address)',
];

const ESCROW_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function balanceOfToken(address, address) view returns (uint256)',
  'function claim()',
  'event Claimed(address indexed recipient, uint256 amount)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const UNIVERSAL_ROUTER_ABI = [
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
];

// Quoting reverts internally to return its result, so it is NOT view — it must
// be reached with staticCall.
const V4_QUOTER_ABI = [
  `function quoteExactInputSingle(${QUOTE_SINGLE_TYPE} params) returns (uint256 amountOut, uint256 gasEstimate)`,
];

const STATE_VIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
];

const DISPERSE_ABI = [
  'function disperseToken(address token, address[] recipients, uint256[] values)',
];

module.exports = {
  POOL_KEY_TYPE, EXACT_IN_SINGLE_TYPE, QUOTE_SINGLE_TYPE,
  FACTORY_V2_ABI, CURVE_ABI, HOOK_ABI, ESCROW_ABI, ERC20_ABI,
  UNIVERSAL_ROUTER_ABI, V4_QUOTER_ABI, STATE_VIEW_ABI, DISPERSE_ABI,
};
```

- [ ] **Step 3: Write the failing erc20 test**

Create `src/evm/erc20.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';

const { erc20, getDecimals, __setDecimalsCache } = require('./erc20');

test('erc20() returns a contract bound to the address', () => {
  const c = erc20('0x00000000000000000000000000000000000a1b69');
  assert.strictEqual(typeof c.balanceOf, 'function');
  assert.strictEqual(typeof c.transfer, 'function');
});

test('getDecimals caches per token and does not re-read', async () => {
  const token = '0x00000000000000000000000000000000000a1b69';
  __setDecimalsCache(token, 9);
  assert.strictEqual(await getDecimals(token), 9);
  assert.strictEqual(await getDecimals(token.toUpperCase()), 9); // case-insensitive
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test src/evm/erc20.test.js`
Expected: FAIL — `Cannot find module './erc20'`

- [ ] **Step 5: Write `src/evm/erc20.js`**

```js
'use strict';
const { Contract } = require('ethers');
const { provider, wallet } = require('./provider');
const { ERC20_ABI } = require('./abi');

const decimalsCache = new Map();

function erc20(address, runner = provider) {
  return new Contract(address, ERC20_ABI, runner);
}

/** decimals() never changes, so read it once per token per process. */
async function getDecimals(address) {
  const key = String(address).toLowerCase();
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  const d = Number(await erc20(address).decimals());
  decimalsCache.set(key, d);
  return d;
}

async function readTokenBalance(token, owner) {
  return erc20(token).balanceOf(owner);
}

async function getTokenSupplyRaw(token) {
  return erc20(token).totalSupply();
}

// Test seam only — lets a unit test assert the cache without a chain read.
function __setDecimalsCache(address, value) {
  decimalsCache.set(String(address).toLowerCase(), value);
}

module.exports = { erc20, getDecimals, readTokenBalance, getTokenSupplyRaw, __setDecimalsCache, wallet };
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test src/evm/erc20.test.js`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add src/evm/provider.js src/evm/abi.js src/evm/erc20.js src/evm/erc20.test.js
git commit -m "Add the provider, verified v2/v4 ABIs, and ERC-20 helpers"
```

---

### Task 3: PoolKey and poolId derivation

This is the highest-risk pure function in the project: a wrong `poolId` silently reads zeros from the hook forever rather than erroring. It is asserted against a real pool.

**Files:**
- Create: `src/evm/pool.js`
- Test: `src/evm/pool.test.js`

**Interfaces:**
- Consumes: `abi.js` (`POOL_KEY_TYPE`, `QUOTE_SINGLE_TYPE`, `V4_QUOTER_ABI`), `config`.
- Produces:
  - `NATIVE` = `'0x0000000000000000000000000000000000000000'`
  - `buildPoolKey({ token, quoteToken, fee, tickSpacing, hooks }) -> { currency0, currency1, fee, tickSpacing, hooks }` (checksummed, sorted)
  - `poolIdOf(poolKey) -> string` (0x-prefixed bytes32)
  - `isZeroForOne(poolKey, currencyIn) -> boolean`
  - `quoteExactInSingle({ poolKey, zeroForOne, amountIn }) -> Promise<bigint>`

- [ ] **Step 1: Write the failing test**

Create `src/evm/pool.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';

const { buildPoolKey, poolIdOf, isZeroForOne, NATIVE } = require('./pool');

const ROBBIE = '0xe0eba1B76b73BE7bfA7716b6Ca96f724930e2263';
const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';
// Read from chain 2026-08-14: hook.launches(<this>) returns registered = true.
const ROBBIE_POOL_ID = '0x813707ded6381854b2d96c3d942960c5d362244a0903ac7d5c4d471e0c6b175f';

test('sorts native ETH into currency0', () => {
  const key = buildPoolKey({ token: ROBBIE, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
  assert.strictEqual(key.currency0, NATIVE);
  assert.strictEqual(key.currency1.toLowerCase(), ROBBIE.toLowerCase());
});

test('derives ROBBIE\'s real poolId', () => {
  const key = buildPoolKey({ token: ROBBIE, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
  assert.strictEqual(poolIdOf(key), ROBBIE_POOL_ID);
});

test('sorting is independent of argument order', () => {
  const a = buildPoolKey({ token: ROBBIE, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
  const b = buildPoolKey({ token: NATIVE, quoteToken: ROBBIE, fee: 0, tickSpacing: 200, hooks: HOOK });
  assert.strictEqual(poolIdOf(a), poolIdOf(b));
});

test('zeroForOne is true when spending currency0', () => {
  const key = buildPoolKey({ token: ROBBIE, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
  assert.strictEqual(isZeroForOne(key, NATIVE), true);   // ETH -> ROBBIE
  assert.strictEqual(isZeroForOne(key, ROBBIE), false);  // ROBBIE -> ETH
});

test('a different tickSpacing is a different pool', () => {
  const a = buildPoolKey({ token: ROBBIE, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
  const b = buildPoolKey({ token: ROBBIE, quoteToken: NATIVE, fee: 0, tickSpacing: 60, hooks: HOOK });
  assert.notStrictEqual(poolIdOf(a), poolIdOf(b));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/evm/pool.test.js`
Expected: FAIL — `Cannot find module './pool'`

- [ ] **Step 3: Write `src/evm/pool.js`**

```js
'use strict';

// Uniswap v4 addresses a pool by the hash of its PoolKey rather than by a pool
// contract address — there is no pool contract. Every hook read (pendingFees,
// launches, sweepPoolFees) is keyed by that hash, and a wrong hash reads zeros
// rather than reverting, so the derivation is asserted against a real pool in
// pool.test.js.

const { Contract, AbiCoder, keccak256, getAddress } = require('ethers');
const config = require('../config');
const { provider } = require('./provider');
const { QUOTE_SINGLE_TYPE, V4_QUOTER_ABI } = require('./abi');

const NATIVE = '0x0000000000000000000000000000000000000000';
const coder = AbiCoder.defaultAbiCoder();

/** Build a canonical PoolKey. Currencies sort ascending by address; native ETH
 *  is address(0) and therefore always currency0. */
function buildPoolKey({ token, quoteToken = NATIVE, fee, tickSpacing, hooks }) {
  const a = getAddress(token);
  const b = getAddress(quoteToken);
  const [currency0, currency1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return { currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks: getAddress(hooks) };
}

/** poolId = keccak256(abi.encode(PoolKey)). Field order is load-bearing. */
function poolIdOf(key) {
  return keccak256(
    coder.encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    )
  );
}

/** True when `currencyIn` is currency0 — the direction flag v4 swaps take. */
function isZeroForOne(key, currencyIn) {
  return getAddress(currencyIn).toLowerCase() === key.currency0.toLowerCase();
}

/** Quote an exact-in swap. The quoter reverts to return its answer, so it is
 *  not a view function and must be reached with staticCall. */
async function quoteExactInSingle({ poolKey, zeroForOne, amountIn }) {
  const quoter = new Contract(config.v4Quoter, V4_QUOTER_ABI, provider);
  const [amountOut] = await quoter.quoteExactInputSingle.staticCall({
    poolKey: [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
    zeroForOne,
    exactAmount: amountIn,
    hookData: '0x',
  });
  return amountOut;
}

module.exports = { NATIVE, buildPoolKey, poolIdOf, isZeroForOne, quoteExactInSingle, QUOTE_SINGLE_TYPE };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/evm/pool.test.js`
Expected: PASS (5 tests). If `derives ROBBIE's real poolId` fails, the encoding is wrong — do not proceed, and do not "fix" the expected value.

- [ ] **Step 5: Commit**

```bash
git add src/evm/pool.js src/evm/pool.test.js
git commit -m "Derive v4 PoolKey and poolId, asserted against ROBBIE's live pool"
```

---

### Task 4: Launch record and phase resolution

**Files:**
- Create: `src/evm/launch.js`
- Test: `src/evm/launch.test.js`

**Interfaces:**
- Consumes: `abi.FACTORY_V2_ABI`, `abi.CURVE_ABI`, `pool.js`, `config`.
- Produces: `getLaunch(token?) -> Promise<Launch>` where

```
Launch = {
  token, curve, deployer, creatorFeeRecipient, pairToken,
  graduationThreshold: bigint, poolFee: number, tickSpacing: number,
  creatorTaxBps: number, buybackEnabled: boolean, exists: boolean,
  graduated: boolean, poolKey: PoolKey|null, poolId: string|null
}
```

Also `describePhase(launch) -> 'curve' | 'v4'`.

- [ ] **Step 1: Write the failing test**

Create `src/evm/launch.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000a1b69';
delete require.cache[require.resolve('../config')];

const { getLaunch, describePhase } = require('./launch');

test('DRY_RUN returns a simulated launch that starts on the curve', async () => {
  const l = await getLaunch();
  assert.strictEqual(l.exists, true);
  assert.strictEqual(l.graduated, false);
  assert.strictEqual(describePhase(l), 'curve');
  assert.strictEqual(l.poolId, null); // no pool exists before graduation
});

test('describePhase reports v4 once graduated', () => {
  assert.strictEqual(describePhase({ graduated: true }), 'v4');
});

test('getLaunch throws without a token address', async () => {
  await assert.rejects(() => getLaunch(null), /TOKEN_ADDRESS/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/evm/launch.test.js`
Expected: FAIL — `Cannot find module './launch'`

- [ ] **Step 3: Write `src/evm/launch.js`**

```js
'use strict';

// One read of the pons v2 launch record per cycle. Every phase decision
// downstream reads THIS object, so a cycle cannot half-believe it is on the
// curve and half-believe it is on the pool.

const { Contract } = require('ethers');
const config = require('../config');
const { provider } = require('./provider');
const { FACTORY_V2_ABI, CURVE_ABI } = require('./abi');
const { buildPoolKey, poolIdOf, NATIVE } = require('./pool');

function factory() {
  return new Contract(config.v2Factory, FACTORY_V2_ABI, provider);
}

function curveAt(address) {
  return new Contract(address, CURVE_ABI, provider);
}

async function getLaunch(token = config.tokenAddress) {
  if (!token) throw new Error('TOKEN_ADDRESS (BABY ROBBIE) is required');

  if (config.dryRun) {
    return {
      token,
      curve: '0x00000000000000000000000000000000000c0f1e',
      deployer: config.wallet.address,
      creatorFeeRecipient: config.wallet.address,
      pairToken: NATIVE,
      graduationThreshold: 42n * 10n ** 17n, // 4.2 ETH
      poolFee: 0,
      tickSpacing: 200,
      creatorTaxBps: 100,
      buybackEnabled: false,
      exists: true,
      graduated: false,
      poolKey: null,
      poolId: null,
    };
  }

  const rec = await factory().getLaunchedToken(token);
  if (!rec.exists) throw new Error(`token ${token} was not launched via the pons v2 factory`);

  const graduated = await curveAt(rec.curve).graduated();

  // The pool only exists after graduation. Deriving a key before then would
  // produce a valid-looking id for a pool that has never been initialized.
  let poolKey = null;
  let poolId = null;
  if (graduated) {
    poolKey = buildPoolKey({
      token,
      quoteToken: rec.pairToken,
      fee: Number(rec.poolFee),
      tickSpacing: Number(rec.tickSpacing),
      hooks: config.memeHook,
    });
    poolId = poolIdOf(poolKey);
  }

  return {
    token,
    curve: rec.curve,
    deployer: rec.deployer,
    creatorFeeRecipient: rec.creatorFeeRecipient,
    pairToken: rec.pairToken,
    graduationThreshold: rec.graduationThreshold,
    poolFee: Number(rec.poolFee),
    tickSpacing: Number(rec.tickSpacing),
    creatorTaxBps: Number(rec.creatorTaxBps),
    buybackEnabled: rec.buybackEnabled,
    exists: true,
    graduated,
    poolKey,
    poolId,
  };
}

function describePhase(launch) {
  return launch && launch.graduated ? 'v4' : 'curve';
}

module.exports = { getLaunch, describePhase, curveAt, factory };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/evm/launch.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/evm/launch.js src/evm/launch.test.js
git commit -m "Resolve the v2 launch record and the curve/v4 phase"
```

---

### Task 5: Escrow — claimable read and claim

**Files:**
- Create: `src/evm/escrow.js`, `src/evm/simvault.js`
- Test: `src/evm/escrow.test.js`

**Interfaces:**
- Consumes: `abi.ESCROW_ABI`, `provider`, `config`.
- Produces:
  - `escrowBalanceEth() -> Promise<number>`
  - `claimFromEscrow() -> Promise<{ signature, ethClaimed, simulated, note? }>`
  - `simvault` → `{ accrue(rate), peek(), drain(), reset(eth) }`

- [ ] **Step 1: Write `src/evm/simvault.js`**

Copy verbatim from `d:/projects/ponsliqui/src/evm/simvault.js` (it is chain-agnostic).

- [ ] **Step 2: Write the failing test**

Create `src/evm/escrow.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
delete require.cache[require.resolve('../config')];

const { escrowBalanceEth, claimFromEscrow } = require('./escrow');
const simvault = require('./simvault');

test('DRY_RUN: escrow balance reads the simulated vault without draining it', async () => {
  simvault.reset(0.25);
  assert.strictEqual(await escrowBalanceEth(), 0.25);
  assert.strictEqual(simvault.peek(), 0.25);
});

test('DRY_RUN: claim drains the vault and reports the amount', async () => {
  simvault.reset(0.5);
  const c = await claimFromEscrow();
  assert.strictEqual(c.simulated, true);
  assert.ok(Math.abs(c.ethClaimed - 0.5) < 1e-9);
  assert.strictEqual(simvault.peek(), 0);
  assert.match(c.signature, /^claim_/);
});

test('DRY_RUN: claiming an empty vault reports nothing to claim', async () => {
  simvault.reset(0);
  const c = await claimFromEscrow();
  assert.strictEqual(c.ethClaimed, 0);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test src/evm/escrow.test.js`
Expected: FAIL — `Cannot find module './escrow'`

- [ ] **Step 4: Write `src/evm/escrow.js`**

```js
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test src/evm/escrow.test.js`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/evm/escrow.js src/evm/simvault.js src/evm/escrow.test.js
git commit -m "Claim native ETH from the v2 fee escrow, measured from its Claimed event"
```

---

### Task 6: Sweep — the two-phase dispatch and the sweepable calculation

The single most important correctness property in this project: fees live on the curve or the hook until swept, so the trigger must count them. See the spec section "The trigger must count unswept fees, not just the escrow".

**Files:**
- Create: `src/evm/sweep.js`
- Test: `src/evm/sweep.test.js`

**Interfaces:**
- Consumes: `launch.js`, `abi.js`, `config`, `provider`.
- Produces:
  - `creatorShareRaw(pendingRaw: bigint, protocolFeeShareBps: number) -> bigint` (PURE)
  - `sweepableRaw(launch) -> Promise<bigint>`
  - `sweepableEth(launch) -> Promise<number>`
  - `sweepFees(launch) -> Promise<{ swept: boolean, skipped: boolean, reason: string|null, signature: string|null }>`

- [ ] **Step 1: Write the failing test**

Create `src/evm/sweep.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
delete require.cache[require.resolve('../config')];

const { creatorShareRaw, isOperatorOnlyError } = require('./sweep');

const ETH = 10n ** 18n;

test('creator share removes the protocol bps and nothing else', () => {
  // 3000 bps protocol share -> creator keeps 70%
  assert.strictEqual(creatorShareRaw(ETH, 3000), (ETH * 7000n) / 10000n);
});

test('a zero protocol share leaves the whole amount', () => {
  assert.strictEqual(creatorShareRaw(ETH, 0), ETH);
});

test('creator share of nothing is nothing', () => {
  assert.strictEqual(creatorShareRaw(0n, 3000), 0n);
});

test('rounds down rather than inventing wei', () => {
  // 7 wei at 3000bps = 4.9 -> 4
  assert.strictEqual(creatorShareRaw(7n, 3000), 4n);
});

test('recognises the operator-only revert by name', () => {
  assert.strictEqual(isOperatorOnlyError(new Error('execution reverted: InternalSwapRequiresOperator()')), true);
  assert.strictEqual(isOperatorOnlyError(new Error('NotFeeSweepOperator')), true);
  assert.strictEqual(isOperatorOnlyError(new Error('insufficient funds')), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/evm/sweep.test.js`
Expected: FAIL — `Cannot find module './sweep'`

- [ ] **Step 3: Write `src/evm/sweep.js`**

```js
'use strict';

// Fees accrue ON the curve (pre-bond) or ON the hook (post-bond) and only reach
// the escrow when someone sweeps. So:
//
//   1. The TRIGGER must count unswept fees. Gating on the escrow alone
//      deadlocks — the bot sees zero, never sweeps, and nothing ever arrives.
//   2. A sweep may be refused. Both contracts revert when clearing pending
//      fees would need an internal swap, because only pons's trusted operator
//      may set that swap's slippage bound. That is expected, not exceptional:
//      the fees stay pending and the next cycle picks them up.
//
// Split math is transcribed from PonsV2BondingCurve._sweepFees and
// V2MemeHook._distribute — they are the same shape:
//
//   protocolAmount = pending * protocolFeeShareBps / 10000
//   creatorBucket  = pending - protocolAmount
//   buyback        = enabled ? min(buybackPending, creatorBucket) : 0
//   creatorAmount  = creatorBucket - buyback + creatorTax
//
// The creator tax bypasses the protocol split entirely and is paid in full.

const { Contract } = require('ethers');
const { formatEther } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');
const { CURVE_ABI, HOOK_ABI } = require('./abi');
const { NATIVE } = require('./pool');
const simvault = require('./simvault');

const BPS = 10000n;

/** The creator's share of a pending fee bucket, after the protocol's cut. */
function creatorShareRaw(pendingRaw, protocolFeeShareBps) {
  const pending = BigInt(pendingRaw);
  if (pending <= 0n) return 0n;
  return (pending * (BPS - BigInt(protocolFeeShareBps))) / BPS;
}

/** Both contracts refuse a sweep that would need pons's trusted operator. */
function isOperatorOnlyError(err) {
  const m = String((err && (err.shortMessage || err.message)) || '');
  return m.includes('InternalSwapRequiresOperator') || m.includes('NotFeeSweepOperator');
}

function curveAt(address, runner = provider) {
  return new Contract(address, CURVE_ABI, runner);
}
function hookAt(runner = provider) {
  return new Contract(config.memeHook, HOOK_ABI, runner);
}

/** Fees sitting unswept that would land in the escrow as ours. */
async function sweepableRaw(launch) {
  if (config.dryRun) return 0n; // the sim vault models the escrow directly

  if (!launch.graduated) {
    const c = curveAt(launch.curve);
    const [pending, tax, buyback, protocolBps] = await Promise.all([
      c.quoteFeeBalance(), c.creatorTaxBalance(), c.buybackQuoteBalance(), c.protocolFeeShareBps(),
    ]);
    const bucket = creatorShareRaw(pending, Number(protocolBps));
    const earmark = launch.buybackEnabled ? (buyback < bucket ? buyback : bucket) : 0n;
    return bucket - earmark + tax;
  }

  const h = hookAt();
  const quote = launch.pairToken || NATIVE;
  const [info, pending, tax, buyback] = await Promise.all([
    h.launches(launch.poolId),
    h.pendingFees(launch.poolId, quote),
    h.pendingCreatorTax(launch.poolId, quote),
    h.pendingBuyback(launch.poolId, quote),
  ]);
  if (!info.registered) return 0n;
  const bucket = creatorShareRaw(pending, Number(info.protocolFeeShareBps));
  const earmark = info.buybackEnabled ? (buyback < bucket ? buyback : bucket) : 0n;
  return bucket - earmark + tax;
}

async function sweepableEth(launch) {
  return Number(formatEther(await sweepableRaw(launch)));
}

/**
 * Push pending fees into the escrow. Best-effort by design: a refusal is
 * reported, never thrown, so the cycle proceeds to claim whatever is already
 * in the escrow.
 */
async function sweepFees(launch) {
  if (config.dryRun) {
    simvault.accrue(config.dryRunFeePerPoll);
    return { swept: true, skipped: false, reason: null, signature: `sweep_${Date.now().toString(36)}` };
  }

  const pending = await sweepableRaw(launch);
  if (pending <= 0n) {
    return { swept: false, skipped: true, reason: 'nothing pending to sweep', signature: null };
  }

  try {
    // minBuybackTokensOut = 0 is safe here only because buyback is disabled for
    // this launch; the contracts revert MinimumOutputRequired if it is enabled.
    const tx = launch.graduated
      ? await hookAt(wallet).sweepPoolFees(launch.poolId, 0, 0)
      : await curveAt(launch.curve, wallet).sweepFees(0);
    await tx.wait();
    console.log(`[tx] sweep fees (${launch.graduated ? 'hook' : 'curve'}): ${tx.hash}`);
    return { swept: true, skipped: false, reason: null, signature: tx.hash };
  } catch (err) {
    if (isOperatorOnlyError(err)) {
      const reason = 'sweep needs pons\'s trusted operator — fees stay pending for the next cycle';
      console.warn(`[sweep] ${reason}`);
      return { swept: false, skipped: true, reason, signature: null };
    }
    throw err;
  }
}

module.exports = { creatorShareRaw, isOperatorOnlyError, sweepableRaw, sweepableEth, sweepFees };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/evm/sweep.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/evm/sweep.js src/evm/sweep.test.js
git commit -m "Sweep fees on either phase and count unswept fees toward the trigger"
```

---

### Task 7: UniversalRouter V4_SWAP encoding

**Files:**
- Create: `src/evm/v4router.js`
- Test: `src/evm/v4router.test.js`

**Interfaces:**
- Consumes: `abi.js` (`EXACT_IN_SINGLE_TYPE`, `UNIVERSAL_ROUTER_ABI`), `pool.js`, `config`.
- Produces:
  - `V4_SWAP = 0x10`, `SWAP_EXACT_IN_SINGLE = 0x06`, `SETTLE_ALL = 0x0c`, `TAKE_ALL = 0x0f`
  - `encodeExactInSingle({ poolKey, zeroForOne, amountIn, amountOutMinimum }) -> { commands, inputs }` (PURE)
  - `swapExactInSingle({ poolKey, zeroForOne, amountIn, amountOutMinimum, deadlineSec }) -> Promise<TransactionResponse>`

- [ ] **Step 1: Write the failing test**

Create `src/evm/v4router.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { AbiCoder } = require('ethers');
process.env.DRY_RUN = 'true';

const { encodeExactInSingle, V4_SWAP } = require('./v4router');
const { buildPoolKey, NATIVE } = require('./pool');
const { EXACT_IN_SINGLE_TYPE } = require('./abi');

const ROBBIE = '0xe0eba1B76b73BE7bfA7716b6Ca96f724930e2263';
const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';
const coder = AbiCoder.defaultAbiCoder();

function key() {
  return buildPoolKey({ token: ROBBIE, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
}

test('commands is the single V4_SWAP byte', () => {
  const { commands } = encodeExactInSingle({ poolKey: key(), zeroForOne: true, amountIn: 1n, amountOutMinimum: 0n });
  assert.strictEqual(commands, '0x10');
  assert.strictEqual(V4_SWAP, 0x10);
});

test('emits exactly one input, holding three actions', () => {
  const { inputs } = encodeExactInSingle({ poolKey: key(), zeroForOne: true, amountIn: 1n, amountOutMinimum: 0n });
  assert.strictEqual(inputs.length, 1);
  const [actions, params] = coder.decode(['bytes', 'bytes[]'], inputs[0]);
  assert.strictEqual(actions, '0x060c0f'); // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
  assert.strictEqual(params.length, 3);
});

test('the swap params round-trip with the amounts and direction given', () => {
  const amountIn = 12345n;
  const minOut = 999n;
  const { inputs } = encodeExactInSingle({ poolKey: key(), zeroForOne: true, amountIn, amountOutMinimum: minOut });
  const [, params] = coder.decode(['bytes', 'bytes[]'], inputs[0]);
  const [decoded] = coder.decode([EXACT_IN_SINGLE_TYPE], params[0]);
  assert.strictEqual(decoded.zeroForOne, true);
  assert.strictEqual(decoded.amountIn, amountIn);
  assert.strictEqual(decoded.amountOutMinimum, minOut);
  assert.strictEqual(decoded.poolKey.currency0, NATIVE);
  assert.strictEqual(decoded.hookData, '0x');
});

test('settles the input currency and takes the output currency', () => {
  const { inputs } = encodeExactInSingle({ poolKey: key(), zeroForOne: true, amountIn: 500n, amountOutMinimum: 7n });
  const [, params] = coder.decode(['bytes', 'bytes[]'], inputs[0]);
  const [settleCurrency, settleAmount] = coder.decode(['address', 'uint256'], params[1]);
  const [takeCurrency, takeAmount] = coder.decode(['address', 'uint256'], params[2]);
  assert.strictEqual(settleCurrency, NATIVE);          // paying ETH in
  assert.strictEqual(settleAmount, 500n);
  assert.strictEqual(takeCurrency.toLowerCase(), ROBBIE.toLowerCase()); // taking tokens out
  assert.strictEqual(takeAmount, 7n);
});

test('reversing the direction swaps which currency is settled', () => {
  const { inputs } = encodeExactInSingle({ poolKey: key(), zeroForOne: false, amountIn: 5n, amountOutMinimum: 1n });
  const [, params] = coder.decode(['bytes', 'bytes[]'], inputs[0]);
  const [settleCurrency] = coder.decode(['address', 'uint256'], params[1]);
  assert.strictEqual(settleCurrency.toLowerCase(), ROBBIE.toLowerCase());
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/evm/v4router.test.js`
Expected: FAIL — `Cannot find module './v4router'`

- [ ] **Step 3: Write `src/evm/v4router.js`**

```js
'use strict';

// Uniswap v4 swaps go through the UniversalRouter, which takes a byte string of
// COMMANDS and a matching array of encoded inputs. A single-pool exact-in swap
// is one command (V4_SWAP) whose input carries three ACTIONS:
//
//   SWAP_EXACT_IN_SINGLE  do the swap
//   SETTLE_ALL            pay the input currency in
//   TAKE_ALL              take the output currency out
//
// Paying with native ETH means attaching msg.value and settling address(0).
// There is deliberately no ERC-20 input path here: this bot never sells, so it
// never needs a Permit2 approval.

const { Contract, AbiCoder, concat, toBeHex } = require('ethers');
const config = require('../config');
const { wallet } = require('./provider');
const { EXACT_IN_SINGLE_TYPE, UNIVERSAL_ROUTER_ABI } = require('./abi');
const { NATIVE } = require('./pool');

const V4_SWAP = 0x10;              // UniversalRouter Commands.V4_SWAP
const SWAP_EXACT_IN_SINGLE = 0x06; // v4-periphery Actions
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;

const coder = AbiCoder.defaultAbiCoder();

function keyTuple(k) {
  return [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];
}

/** Encode one exact-in single-pool swap for UniversalRouter.execute(). */
function encodeExactInSingle({ poolKey, zeroForOne, amountIn, amountOutMinimum }) {
  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const currencyOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;

  const actions = concat([toBeHex(SWAP_EXACT_IN_SINGLE, 1), toBeHex(SETTLE_ALL, 1), toBeHex(TAKE_ALL, 1)]);
  const params = [
    coder.encode([EXACT_IN_SINGLE_TYPE], [[keyTuple(poolKey), zeroForOne, amountIn, amountOutMinimum, '0x']]),
    coder.encode(['address', 'uint256'], [currencyIn, amountIn]),
    coder.encode(['address', 'uint256'], [currencyOut, amountOutMinimum]),
  ];

  return {
    commands: toBeHex(V4_SWAP, 1),
    inputs: [coder.encode(['bytes', 'bytes[]'], [actions, params])],
  };
}

/** Send the swap. Native input rides along as msg.value. */
async function swapExactInSingle({ poolKey, zeroForOne, amountIn, amountOutMinimum, deadlineSec = 600 }) {
  const { commands, inputs } = encodeExactInSingle({ poolKey, zeroForOne, amountIn, amountOutMinimum });
  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const value = currencyIn.toLowerCase() === NATIVE ? amountIn : 0n;

  const router = new Contract(config.universalRouter, UNIVERSAL_ROUTER_ABI, wallet);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec);
  return router.execute(commands, inputs, deadline, { value });
}

module.exports = {
  encodeExactInSingle, swapExactInSingle,
  V4_SWAP, SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/evm/v4router.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/evm/v4router.js src/evm/v4router.test.js
git commit -m "Encode Uniswap v4 exact-in swaps for the UniversalRouter"
```

---

### Task 8: Buy — curve and v4 dispatch with requote/retry

**Files:**
- Create: `src/evm/curve.js`, `src/evm/buy.js`
- Test: `src/evm/buy.test.js`

**Interfaces:**
- Consumes: `launch.js`, `pool.js`, `v4router.js`, `erc20.js`, `config`.
- Produces:
  - `curve.js` → `buyOnCurve({ curve, token, ethAmount, minTokensOut }) -> Promise<{signature, tokensBoughtRaw}>`, `quoteCurveOut({ curve, ethAmount }) -> Promise<bigint>`
  - `buy.js` → `buyToken({ launch, token, ethAmount }) -> Promise<{ signature, tokensBought, tokensBoughtRaw, decimals, simulated, venue }>` where `venue` is `'curve' | 'v4' | 'sim'`

- [ ] **Step 1: Write the failing test**

Create `src/evm/buy.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
delete require.cache[require.resolve('../config')];

const { buyToken, applySlippage } = require('./buy');

test('applySlippage lowers the minimum by the configured percent', () => {
  assert.strictEqual(applySlippage(10000n, 5), 9500n);
  assert.strictEqual(applySlippage(10000n, 0), 10000n);
  assert.strictEqual(applySlippage(10000n, 2.5), 9750n);
});

test('applySlippage rejects a nonsense percentage', () => {
  assert.throws(() => applySlippage(1n, 100), /SLIPPAGE_PCT/);
  assert.throws(() => applySlippage(1n, -1), /SLIPPAGE_PCT/);
});

test('DRY_RUN buy simulates and reports raw units', async () => {
  const launch = { graduated: false, curve: '0x00000000000000000000000000000000000c0f1e' };
  const r = await buyToken({ launch, token: '0x00000000000000000000000000000000000a1b69', ethAmount: 0.5 });
  assert.strictEqual(r.simulated, true);
  assert.strictEqual(r.venue, 'sim');
  assert.ok(r.tokensBought > 0);
  assert.strictEqual(BigInt(r.tokensBoughtRaw) > 0n, true);
});

test('DRY_RUN buy of zero returns zero without throwing', async () => {
  const launch = { graduated: true };
  const r = await buyToken({ launch, token: '0x00000000000000000000000000000000000a1b69', ethAmount: 0 });
  assert.strictEqual(r.tokensBought, 0);
  assert.strictEqual(r.tokensBoughtRaw, '0');
});

// DRY_RUN short-circuits before the venue split, so the live dispatch is
// asserted at the source level instead — the same technique ponsliqui uses to
// pin its claim path. Without this, a buy that silently always took one venue
// would pass every other test in this file.
test('the live path dispatches on graduation, and never sells', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'buy.js'), 'utf8');
  assert.match(src, /launch\.graduated/, 'must branch on the phase');
  assert.match(src, /swapExactInSingle/, 'graduated path must use the v4 router');
  assert.match(src, /buyOnCurve/, 'pre-graduation path must use the curve');
  assert.doesNotMatch(src, /permit2|Permit2/, 'this bot never sells, so it needs no Permit2 path');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/evm/buy.test.js`
Expected: FAIL — `Cannot find module './buy'`

- [ ] **Step 3: Write `src/evm/curve.js`**

```js
'use strict';

// Pre-graduation the token has no pool — it trades against its own bonding
// curve. buy() takes the quote amount as an argument AND as msg.value on a
// native-quote launch, which every pons v2 ETH launch is.

const { Contract } = require('ethers');
const { provider, wallet } = require('./provider');
const { CURVE_ABI } = require('./abi');
const { readTokenBalance } = require('./erc20');

function curveAt(address, runner = provider) {
  return new Contract(address, CURVE_ABI, runner);
}

/** Constant-product quote against the curve's current reserves. */
async function quoteCurveOut({ curve, ethAmountRaw }) {
  const [quoteReserve, tokenReserve] = await curveAt(curve).getReserves();
  if (quoteReserve <= 0n || tokenReserve <= 0n) return 0n;
  // x*y=k with no fee applied here; the curve charges feeBps internally, so the
  // caller's slippage tolerance absorbs the difference.
  return (ethAmountRaw * tokenReserve) / (quoteReserve + ethAmountRaw);
}

async function buyOnCurve({ curve, token, ethAmountRaw, minTokensOut }) {
  const before = await readTokenBalance(token, wallet.address);
  const tx = await curveAt(curve, wallet).buy(ethAmountRaw, minTokensOut, wallet.address, { value: ethAmountRaw });
  await tx.wait();
  const after = await readTokenBalance(token, wallet.address);
  console.log(`[tx] buy ${token} on the curve: ${tx.hash}`);
  return { signature: tx.hash, tokensBoughtRaw: after - before };
}

module.exports = { curveAt, quoteCurveOut, buyOnCurve };
```

- [ ] **Step 4: Write `src/evm/buy.js`**

```js
'use strict';

// One buy entry point for both phases. Everything is bought with NATIVE ETH,
// so there is no wrapping and no allowance to maintain. Amounts bought are
// measured from the wallet's balance delta rather than trusting a return value.

const { parseEther } = require('ethers');
const config = require('../config');
const { wallet } = require('./provider');
const { getDecimals, readTokenBalance } = require('./erc20');
const { buildPoolKey, poolIdOf, isZeroForOne, quoteExactInSingle, NATIVE } = require('./pool');
const { swapExactInSingle } = require('./v4router');
const { quoteCurveOut, buyOnCurve } = require('./curve');

const BUY_ATTEMPTS = 3;
const BPS = 10000n;

/** Lower a quoted output by the configured slippage tolerance. */
function applySlippage(quoted, slippagePct) {
  if (!(slippagePct >= 0 && slippagePct < 100)) {
    throw new Error(`SLIPPAGE_PCT must be in [0, 100): ${slippagePct}`);
  }
  return (BigInt(quoted) * BigInt(Math.round((100 - slippagePct) * 100))) / BPS;
}

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Buy `token` with `ethAmount` native ETH.
 * @param {{launch: object, token: string, ethAmount: number}} opts
 *   `launch` decides the venue: the bonding curve before graduation, the v4
 *   pool after. For the REWARD token (already graduated) pass its own launch.
 */
async function buyToken({ launch, token, ethAmount }) {
  if (!(ethAmount > 0)) {
    return { signature: null, tokensBought: 0, tokensBoughtRaw: '0', decimals: 18, simulated: config.dryRun, venue: 'none' };
  }

  if (config.dryRun) {
    const decimals = 18;
    const tokensBought = +(ethAmount * 1_000_000 * (0.97 + Math.random() * 0.06)).toFixed(0);
    return {
      signature: fakeSig('buy'),
      tokensBought,
      tokensBoughtRaw: (BigInt(tokensBought) * 10n ** BigInt(decimals)).toString(),
      decimals,
      simulated: true,
      venue: 'sim',
    };
  }

  const amountIn = parseEther(String(ethAmount));
  const decimals = await getDecimals(token);
  const venue = launch.graduated ? 'v4' : 'curve';

  // Re-quote on every attempt. A one-block price move makes the minimum-output
  // check revert, which is the protection working — but it must not kill the
  // cycle, so wait out the move and try again against a fresh quote.
  let lastErr;
  for (let attempt = 1; attempt <= BUY_ATTEMPTS; attempt += 1) {
    try {
      const before = await readTokenBalance(token, wallet.address);
      let signature;

      if (launch.graduated) {
        const poolKey = launch.poolKey || buildPoolKey({
          token, quoteToken: launch.pairToken || NATIVE,
          fee: launch.poolFee, tickSpacing: launch.tickSpacing, hooks: config.memeHook,
        });
        const zeroForOne = isZeroForOne(poolKey, NATIVE);
        const quoted = await quoteExactInSingle({ poolKey, zeroForOne, amountIn });
        if (quoted <= 0n) throw new Error(`v4 pool quoted zero for ${token}`);
        const tx = await swapExactInSingle({
          poolKey, zeroForOne, amountIn,
          amountOutMinimum: applySlippage(quoted, config.slippagePct),
        });
        await tx.wait();
        console.log(`[tx] buy ${token} on v4 (pool ${poolIdOf(poolKey).slice(0, 10)}…): ${tx.hash}`);
        signature = tx.hash;
      } else {
        const quoted = await quoteCurveOut({ curve: launch.curve, ethAmountRaw: amountIn });
        if (quoted <= 0n) throw new Error(`curve quoted zero for ${token}`);
        const res = await buyOnCurve({
          curve: launch.curve, token, ethAmountRaw: amountIn,
          minTokensOut: applySlippage(quoted, config.slippagePct),
        });
        signature = res.signature;
      }

      const boughtRaw = (await readTokenBalance(token, wallet.address)) - before;
      return {
        signature,
        tokensBought: Number(boughtRaw) / 10 ** decimals,
        tokensBoughtRaw: boughtRaw.toString(),
        decimals,
        simulated: false,
        venue,
      };
    } catch (err) {
      lastErr = err;
      console.warn(`[buy] attempt ${attempt}/${BUY_ATTEMPTS} failed on ${venue}: ${err.shortMessage || err.message}`);
      if (attempt < BUY_ATTEMPTS) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

module.exports = { buyToken, applySlippage };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test src/evm/buy.test.js`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/evm/curve.js src/evm/buy.js src/evm/buy.test.js
git commit -m "Buy with native ETH on either the bonding curve or the v4 pool"
```

---

### Task 9: Burn, holders, exclusions

**Files:**
- Create: `src/evm/send.js`, `src/evm/burn.js`, `src/services/fetchJson.js`, `src/evm/holders.js`, `src/evm/exclude.js`
- Test: `src/evm/burn.test.js`, `src/evm/holders.test.js`, `src/evm/exclude.test.js`

**Interfaces:**
- Produces:
  - `send.js` → `sendTx(fn) -> Promise<TransactionResponse>` (retries once on a stale-nonce reject)
  - `burn.js` → `burnToken(token, amountRaw) -> Promise<{signature, burnedRaw, burned, deadAddress, simulated}>`
  - `fetchJson.js` → `fetchJson(url, opts) -> Promise<object>` (retries 429/5xx)
  - `holders.js` → `filterEligible(accounts, minHoldRaw, excludeSet)`, `countOwners(accounts)`, `snapshotEligibleHolders({token, minHoldRaw, exclude}) -> Promise<{holders, totalHolders}>`
  - `exclude.js` → `buildExcludeSet(launch) -> Promise<Set<string>>`

- [ ] **Step 1: Port the three chain-agnostic files verbatim**

Copy from ponsliqui, unchanged — they contain no v1 assumptions:
- `d:/projects/ponsliqui/src/evm/send.js` → `src/evm/send.js`
- `d:/projects/ponsliqui/src/services/fetchJson.js` → `src/services/fetchJson.js`
- `d:/projects/ponsliqui/src/evm/holders.js` → `src/evm/holders.js`

In `holders.js`, change the DRY_RUN simulated set to use `wallet.address` as before but leave the logic alone. Also copy their tests:
- `d:/projects/ponsliqui/src/evm/send.test.js` → `src/evm/send.test.js`
- `d:/projects/ponsliqui/src/services/fetchJson.test.js` → `src/services/fetchJson.test.js`
- `d:/projects/ponsliqui/src/evm/holders.test.js` → `src/evm/holders.test.js`

- [ ] **Step 2: Port `burn.js`**

Copy `d:/projects/ponsliqui/src/evm/burn.js` and `burn.test.js` verbatim — burning is a plain ERC-20 transfer to the dead address and is identical across protocol versions.

- [ ] **Step 3: Write the failing exclusion test**

Create `src/evm/exclude.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
process.env.AIRDROP_EXCLUDE = '0x1111111111111111111111111111111111111111';
delete require.cache[require.resolve('../config')];

const config = require('../config');
const { buildExcludeSet } = require('./exclude');

test('excludes every contract that custodies tokens but is not a holder', async () => {
  const launch = { curve: '0x00000000000000000000000000000000000c0f1e', graduated: true };
  const set = await buildExcludeSet(launch);
  for (const addr of [
    config.wallet.address, config.deadAddress, config.poolManager, config.memeHook,
    config.buybackVault, config.feeEscrow, config.v2Factory, config.rewardToken, launch.curve,
  ]) {
    assert.ok(set.has(String(addr).toLowerCase()), `expected ${addr} to be excluded`);
  }
});

test('honours extra addresses from AIRDROP_EXCLUDE', async () => {
  const set = await buildExcludeSet({ curve: null, graduated: false });
  for (const a of config.airdropExclude) assert.ok(set.has(a.toLowerCase()));
});

test('tolerates a launch with no curve address', async () => {
  const set = await buildExcludeSet({ curve: null, graduated: false });
  assert.ok(set.size > 0);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test src/evm/exclude.test.js`
Expected: FAIL — `Cannot find module './exclude'`

- [ ] **Step 5: Write `src/evm/exclude.js`**

```js
'use strict';

// Addresses that hold the token but are not people. On v4 the POOL MANAGER is
// the big one: it custodies every pool's liquidity, so it shows up as one of the
// largest holders of any graduated token. Pre-graduation the BONDING CURVE holds
// the entire unsold supply and would otherwise take almost the whole airdrop.

const config = require('../config');
const { wallet } = require('./provider');

async function buildExcludeSet(launch = null) {
  const set = new Set();
  const add = (a) => { if (a) set.add(String(a).toLowerCase()); };

  add(wallet.address);        // us
  add(config.deadAddress);    // burned supply
  add(config.poolManager);    // v4 liquidity custodian
  add(config.memeHook);       // pending fee inventory
  add(config.buybackVault);   // vesting locks
  add(config.feeEscrow);      // fee custody
  add(config.v2Factory);      // launch plumbing
  add(config.rewardToken);    // the reward token contract itself
  if (launch && launch.curve) add(launch.curve); // unsold supply pre-graduation
  for (const a of config.airdropExclude) add(a);

  return set;
}

module.exports = { buildExcludeSet };
```

- [ ] **Step 6: Run all the tests from this task**

Run: `node --test src/evm/exclude.test.js src/evm/burn.test.js src/evm/holders.test.js src/evm/send.test.js src/services/fetchJson.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/evm/send.js src/evm/burn.js src/evm/holders.js src/evm/exclude.js src/services/fetchJson.js src/evm/*.test.js src/services/fetchJson.test.js
git commit -m "Add burning, holder snapshots, and v4-aware airdrop exclusions"
```

---

### Task 10: Distribution math and the airdrop pipeline

**Files:**
- Create: `src/services/distribution.js`, `src/evm/airdrop.js`
- Test: `src/services/distribution.test.js`

**Interfaces:**
- Produces:
  - `computeWeightedAllocations(holders, totalRaw, {capPct, supplyRaw, clusters}) -> [{owner, amountRaw}]`
  - `airdropToken({ rewardToken, allocations, cycleId }) -> Promise<{sent, failed}>`

- [ ] **Step 1: Port both files verbatim**

Copy from ponsliqui unchanged — both are chain-agnostic and already well tested:
- `d:/projects/ponsliqui/src/services/distribution.js` → `src/services/distribution.js`
- `d:/projects/ponsliqui/src/services/distribution.test.js` → `src/services/distribution.test.js`
- `d:/projects/ponsliqui/src/evm/airdrop.js` → `src/evm/airdrop.js`

- [ ] **Step 2: Add a test for the exact-sum property**

Append to `src/services/distribution.test.js`:

```js
test('allocations sum exactly to the amount bought, leaving no dust behind', () => {
  const holders = [
    { owner: '0xaa', balanceRaw: '333' },
    { owner: '0xbb', balanceRaw: '333' },
    { owner: '0xcc', balanceRaw: '334' },
  ];
  const total = 1000000n;
  const out = computeWeightedAllocations(holders, total.toString(), {});
  const sum = out.reduce((s, a) => s + BigInt(a.amountRaw), 0n);
  assert.strictEqual(sum, total);
});

test('a holder with zero balance receives nothing', () => {
  const out = computeWeightedAllocations(
    [{ owner: '0xaa', balanceRaw: '0' }, { owner: '0xbb', balanceRaw: '100' }],
    '500', {}
  );
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].owner, '0xbb');
});
```

- [ ] **Step 3: Run the tests**

Run: `node --test src/services/distribution.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/distribution.js src/services/distribution.test.js src/evm/airdrop.js
git commit -m "Port the weighted distribution math and the airdrop pipeline"
```

---

### Task 11: MongoDB store

**Files:**
- Create: `src/db/index.js`, `src/db/repository.js`
- Test: `src/db/airdrops.test.js`

**Interfaces:**
- Produces: `db.connect()`, `db.close()`, `db.getDb()`; `repo.createCycle`, `repo.finishCycle`, `repo.addStep`, `repo.getCycleWithSteps`, `repo.getCycles`, `repo.getLastCycle`, `repo.getAllSteps`, `repo.getStats`, `repo.addAirdrop`, `repo.getAirdrops`, `repo.getAirdropTotals`.

- [ ] **Step 1: Port verbatim**

Copy from ponsliqui — the schema is protocol-independent:
- `d:/projects/ponsliqui/src/db/index.js` → `src/db/index.js`
- `d:/projects/ponsliqui/src/db/repository.js` → `src/db/repository.js`
- `d:/projects/ponsliqui/src/db/airdrops.test.js` → `src/db/airdrops.test.js`

- [ ] **Step 2: Add the sweep fields to `finishCycle`'s allow-list**

In `src/db/repository.js`, extend the `allowed` array in `finishCycle`:

```js
  const allowed = [
    'status', 'mode', 'phase', 'eth_claimed', 'eth_spent_buy',
    'tokens_bought', 'tokens_burned', 'burn_sig',
    'eligible_holders', 'total_holders',
    'sweep_skipped', 'sweep_reason',
    'note', 'error',
  ];
```

And add matching nulls to the `createCycle` document: `phase: null, sweep_skipped: 0, sweep_reason: null`.

- [ ] **Step 3: Run the test**

Run: `node --test src/db/airdrops.test.js`
Expected: PASS (may take ~20s the first time — `mongodb-memory-server` downloads a binary)

- [ ] **Step 4: Commit**

```bash
git add src/db/
git commit -m "Port the MongoDB store and record the sweep outcome per cycle"
```

---

### Task 12: The cycle

**Files:**
- Create: `src/jobs/cycle.js`
- Test: `src/jobs/cycle.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `runCycle() -> Promise<cycle>`, `splitClaim(claimedEth) -> {rewardEth, burnEth, devEth, burnSkipped}` (PURE)

- [ ] **Step 1: Write the failing test**

Create `src/jobs/cycle.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
process.env.REWARD_BUY_PCT = '80';
process.env.BURN_PCT = '0.1';
process.env.MIN_BURN_ETH = '0.0001';
delete require.cache[require.resolve('../config')];

const { splitClaim } = require('./cycle');

test('splits a claim 80 / 0.1 / 19.9', () => {
  const s = splitClaim(1);
  assert.strictEqual(s.rewardEth, 0.8);
  assert.strictEqual(s.burnEth, 0.001);
  assert.strictEqual(s.devEth, 0.199);
  assert.strictEqual(s.burnSkipped, false);
});

test('the three legs always re-add to the claim', () => {
  for (const claim of [0.001, 0.5, 1, 3.14159, 21.368470124]) {
    const s = splitClaim(claim);
    const total = s.rewardEth + (s.burnSkipped ? 0 : s.burnEth) + s.devEth;
    assert.ok(Math.abs(total - claim) < 1e-9, `claim ${claim} lost ${claim - total}`);
  }
});

test('skips a burn that would cost more in gas than it burns', () => {
  // 0.1% of 0.005 ETH = 5e-6, below MIN_BURN_ETH of 1e-4
  const s = splitClaim(0.005);
  assert.strictEqual(s.burnSkipped, true);
  // the skipped burn folds into the dev cut rather than vanishing
  assert.ok(Math.abs(s.rewardEth + s.devEth - 0.005) < 1e-9);
});

test('a zero claim produces zero legs', () => {
  const s = splitClaim(0);
  assert.strictEqual(s.rewardEth, 0);
  assert.strictEqual(s.devEth, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/jobs/cycle.test.js`
Expected: FAIL — `Cannot find module './cycle'`

- [ ] **Step 3: Write `src/jobs/cycle.js`**

```js
'use strict';

// One reward-and-burn cycle:
//
//   sweep pending fees into the escrow      (best-effort — may need pons's operator)
//   claim the escrow                        -> native ETH
//     -> REWARD_BUY_PCT: buy ROBBIE and airdrop it to BABY ROBBIE holders
//     -> BURN_PCT:       buy BABY ROBBIE and burn it
//     -> remainder:      stays in the wallet as native ETH (dev cut + gas)
//
// Each step is recorded; a thrown step fails the cycle without crashing.

const config = require('../config');
const repo = require('../db/repository');
const { getLaunch, describePhase } = require('../evm/launch');
const { sweepFees } = require('../evm/sweep');
const { claimFromEscrow } = require('../evm/escrow');
const { buyToken } = require('../evm/buy');
const { burnToken } = require('../evm/burn');
const { getTokenSupplyRaw } = require('../evm/erc20');
const { snapshotEligibleHolders } = require('../evm/holders');
const { buildExcludeSet } = require('../evm/exclude');
const { computeWeightedAllocations } = require('../services/distribution');
const { airdropToken } = require('../evm/airdrop');

/**
 * Split a claim into its three legs. Pure, so the invariant that the legs
 * re-add to the claim is directly testable.
 *
 * A burn below MIN_BURN_ETH is skipped rather than attempted — 0.1% of a small
 * claim costs more in gas than it removes from supply. The skipped amount folds
 * into the dev cut; it does NOT accumulate toward the next cycle.
 */
function splitClaim(claimedEth) {
  const pct = (p) => +(claimedEth * (p / 100)).toFixed(9);
  const rewardEth = pct(config.rewardBuyPct);
  const burnEth = pct(config.burnPct);
  const burnSkipped = burnEth > 0 && burnEth < config.minBurnEth;
  const devEth = +(claimedEth - rewardEth - (burnSkipped ? 0 : burnEth)).toFixed(9);
  return { rewardEth, burnEth, devEth, burnSkipped };
}

/** Buy the reward token and airdrop it pro-rata to holders of the fee token. */
async function runRewardLeg(cycleId, { launch, rewardLaunch, wethAmount }) {
  const log = (m) => console.log(`[cycle ${cycleId}] [reward] ${m}`);

  const buy = await buyToken({ launch: rewardLaunch, token: config.rewardToken, ethAmount: wethAmount });
  await repo.addStep({
    cycleId, name: 'buy', status: 'ok', signature: buy.signature,
    detail: { leg: 'reward', token: config.rewardToken, ethSpent: wethAmount, tokensBought: buy.tokensBought, venue: buy.venue },
  });
  log(`bought ${buy.tokensBought} ${config.rewardSymbol} with ${wethAmount} ETH`);

  const minHoldRaw = (BigInt(Math.trunc(config.minHold)) * 10n ** 18n).toString();
  const exclude = await buildExcludeSet(launch);
  const { holders, totalHolders } = await snapshotEligibleHolders({ token: launch.token, minHoldRaw, exclude });
  log(`${holders.length} eligible holders (>= ${config.minHold}) of ${totalHolders} total`);

  const capPct = config.rewardCapPct > 0 ? config.rewardCapPct : null;
  const supplyRaw = capPct == null ? null : (await getTokenSupplyRaw(launch.token)).toString();
  const allocations = computeWeightedAllocations(holders, buy.tokensBoughtRaw || '0', { capPct, supplyRaw, clusters: config.clusters });
  const air = await airdropToken({ rewardToken: config.rewardToken, allocations, cycleId });
  await repo.addStep({
    cycleId, name: 'airdrop', status: air.failed ? 'failed' : 'ok',
    detail: { token: config.rewardToken, recipients: allocations.length, sent: air.sent, failed: air.failed },
  });
  log(`airdrop ${config.rewardSymbol} sent=${air.sent} failed=${air.failed}`);

  return { tokensBought: buy.tokensBought, sent: air.sent, failed: air.failed, eligibleHolders: holders.length, totalHolders };
}

async function runCycle() {
  const id = await repo.createCycle({ dryRun: config.dryRun });
  const log = (msg) => console.log(`[cycle ${id}] ${msg}`);

  try {
    if (!config.tokenAddress) throw new Error('TOKEN_ADDRESS (BABY ROBBIE) is required');
    if (!config.rewardToken) throw new Error('REWARD_TOKEN (ROBBIE) is required');

    const launch = await getLaunch();
    const phase = describePhase(launch);
    log(`phase=${phase}${launch.graduated ? ` pool=${String(launch.poolId).slice(0, 10)}…` : ` curve=${launch.curve}`}`);

    // 1. Sweep pending fees into the escrow. Never fatal.
    const sweep = await sweepFees(launch);
    await repo.addStep({
      cycleId: id, name: 'sweep', status: sweep.swept ? 'ok' : 'skipped',
      signature: sweep.signature, detail: { phase, reason: sweep.reason },
    });
    if (sweep.skipped) log(`sweep skipped: ${sweep.reason}`);

    // 2. Claim the escrow.
    const claim = await claimFromEscrow();
    await repo.addStep({ cycleId: id, name: 'claim', status: 'ok', signature: claim.signature, detail: { ethClaimed: claim.ethClaimed } });
    log(`claimed ${claim.ethClaimed} ETH`);

    const claimed = claim.ethClaimed;
    if (!(claimed > 0)) {
      await repo.finishCycle(id, {
        status: 'skipped', phase, eth_claimed: 0,
        sweep_skipped: sweep.skipped ? 1 : 0, sweep_reason: sweep.reason,
        note: 'nothing claimed',
      });
      log('skipped: nothing to work with');
      return repo.getCycleWithSteps(id);
    }

    // 3. Split.
    const { rewardEth, burnEth, devEth, burnSkipped } = splitClaim(claimed);
    log(`split: ${rewardEth} -> ${config.rewardSymbol} reward (${config.rewardBuyPct}%), ${burnEth} -> ${config.tokenSymbol} burn (${config.burnPct}%${burnSkipped ? ', SKIPPED as dust' : ''}), keep ${devEth} for dev/gas`);

    // 4. Reward leg. The reward token is already graduated, so it always
    //    trades on v4 regardless of which phase OUR token is in.
    let reward = { sent: 0, failed: 0, tokensBought: 0, eligibleHolders: 0, totalHolders: 0 };
    if (rewardEth > 0) {
      const rewardLaunch = config.dryRun
        ? { graduated: true, poolKey: null, poolFee: 0, tickSpacing: 200, pairToken: null }
        : await getLaunch(config.rewardToken);
      reward = await runRewardLeg(id, { launch, rewardLaunch, wethAmount: rewardEth });
    }

    // 5. Burn leg.
    let burned = 0;
    let burnSig = null;
    if (burnEth > 0 && !burnSkipped) {
      const buyBurn = await buyToken({ launch, token: launch.token, ethAmount: burnEth });
      await repo.addStep({
        cycleId: id, name: 'buy', status: 'ok', signature: buyBurn.signature,
        detail: { leg: 'burn', token: launch.token, ethSpent: burnEth, tokensBought: buyBurn.tokensBought, venue: buyBurn.venue },
      });
      const burn = await burnToken(launch.token, buyBurn.tokensBoughtRaw);
      await repo.addStep({ cycleId: id, name: 'burn', status: 'ok', signature: burn.signature, detail: { tokensBurned: burn.burned, burnedRaw: burn.burnedRaw, deadAddress: burn.deadAddress } });
      burned = burn.burned;
      burnSig = burn.signature;
      log(`burned ${burn.burned} ${config.tokenSymbol} -> ${burn.deadAddress}`);
    } else if (burnSkipped) {
      await repo.addStep({ cycleId: id, name: 'burn', status: 'skipped', detail: { ethWouldSpend: burnEth, minBurnEth: config.minBurnEth, reason: 'below MIN_BURN_ETH — gas would exceed the burn' } });
    }

    // 6. Dev cut needs no transaction: it is already native ETH in the wallet.

    await repo.finishCycle(id, {
      status: 'complete', mode: 'reward-burn', phase,
      eth_claimed: claimed, eth_spent_buy: rewardEth,
      tokens_bought: reward.tokensBought, tokens_burned: burned, burn_sig: burnSig,
      eligible_holders: reward.eligibleHolders, total_holders: reward.totalHolders,
      sweep_skipped: sweep.skipped ? 1 : 0, sweep_reason: sweep.reason,
      note: `airdrop sent ${reward.sent}`,
    });
    log('complete (reward-burn)');
    return repo.getCycleWithSteps(id);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({ cycleId: id, name: 'error', status: 'failed', detail: { message } });
    await repo.finishCycle(id, { status: 'failed', error: message });
    log(`FAILED: ${message}`);
    return repo.getCycleWithSteps(id);
  }
}

module.exports = { runCycle, runRewardLeg, splitClaim };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/jobs/cycle.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/jobs/cycle.js src/jobs/cycle.test.js
git commit -m "Run the sweep-claim-reward-burn cycle with a dust-safe burn leg"
```

---

### Task 13: Scheduler and the trigger gate

**Files:**
- Create: `src/jobs/scheduler.js`
- Test: `src/jobs/scheduler.test.js`

**Interfaces:**
- Produces: `start()`, `pause()`, `resume()`, `triggerNow()`, `pollOnce(trigger)`, `getState()`, `getClaimableEth()`.

- [ ] **Step 1: Write the failing test**

Create `src/jobs/scheduler.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
process.env.TRIGGER_MODE = 'accumulation';
process.env.CLAIM_EVERY_ETH = '0.05';
delete require.cache[require.resolve('../config')];

const scheduler = require('./scheduler');
const simvault = require('../evm/simvault');

test('pause blocks a poll and resume unblocks it', async () => {
  scheduler.pause();
  const r = await scheduler.pollOnce('poll');
  assert.strictEqual(r.ran, false);
  assert.strictEqual(r.reason, 'paused');
  scheduler.resume();
  assert.strictEqual(scheduler.getState().paused, false);
});

test('accumulation mode holds below the threshold', async () => {
  simvault.reset(0.001);
  const r = await scheduler.pollOnce('poll');
  assert.strictEqual(r.ran, false);
  assert.match(r.reason, /below accumulation threshold/);
});

test('getState reports the configured trigger', () => {
  const s = scheduler.getState();
  assert.strictEqual(s.triggerMode, 'accumulation');
  assert.strictEqual(s.claimEveryEth, 0.05);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/jobs/scheduler.test.js`
Expected: FAIL — `Cannot find module './scheduler'`

- [ ] **Step 3: Write `src/jobs/scheduler.js`**

Port `d:/projects/ponsliqui/src/jobs/scheduler.js` with one substantive change — the claimable read must include unswept fees:

```js
'use strict';

const cron = require('node-cron');
const config = require('../config');
const { runCycle } = require('./cycle');
const { getLaunch } = require('../evm/launch');
const { escrowBalanceEth } = require('../evm/escrow');
const { sweepableEth } = require('../evm/sweep');
const bus = require('../events');

const state = {
  task: null, paused: false, isRunning: false,
  lastRunAt: null, lastResult: null, lastClaimable: null, startedAt: null, lastPhase: null,
};

/**
 * What a cycle could realistically collect right now: what is already in the
 * escrow PLUS what a sweep would move into it. Reading the escrow alone
 * deadlocks — before the first sweep it is zero while the fees sit on the
 * curve or the hook, so the bot would never fire and never sweep.
 */
async function getClaimableEth() {
  if (config.dryRun) return escrowBalanceEth();
  if (!config.tokenAddress) return 0;
  const launch = await getLaunch();
  state.lastPhase = launch.graduated ? 'v4' : 'curve';
  const [inEscrow, pending] = await Promise.all([escrowBalanceEth(), sweepableEth(launch)]);
  return inEscrow + pending;
}

async function pollOnce(trigger) {
  if (state.paused) return { ran: false, reason: 'paused' };
  if (state.isRunning) {
    console.log(`[scheduler] ${trigger} tick ignored — a cycle is already running`);
    return { ran: false, reason: 'cycle already running' };
  }

  // Hold the run flag across the balance read too, so a manual POST /api/run
  // landing between the read and the cycle cannot spawn a second concurrent
  // cycle and contend for the wallet nonce.
  state.isRunning = true;
  try {
    if (config.dryRun) {
      // Simulate fees arriving so cycles have something to work with.
      require('../evm/simvault').accrue(config.dryRunFeePerPoll);
    }
    const claimable = await getClaimableEth();
    state.lastClaimable = claimable;
    if (!(claimable > 0)) return { ran: false, claimable, reason: 'nothing claimable' };

    if (config.triggerMode === 'accumulation' && claimable < config.claimEveryEth) {
      return { ran: false, claimable, reason: `below accumulation threshold (${claimable} < ${config.claimEveryEth} ETH)` };
    }

    state.lastRunAt = new Date().toISOString();
    const cycle = await runCycle();
    state.lastResult = { id: cycle.id, status: cycle.status };
    return { ran: true, claimable, cycle };
  } finally {
    state.isRunning = false;
  }
}

function start() {
  if (state.task) return;
  if (!cron.validate(config.pollSchedule)) throw new Error(`Invalid POLL_SCHEDULE: ${config.pollSchedule}`);
  state.startedAt = new Date().toISOString();
  state.task = cron.schedule(config.pollSchedule, () => {
    pollOnce('poll').catch((err) => console.error('[scheduler] poll error:', err));
  });
  const gate = config.triggerMode === 'accumulation' ? ` threshold=${config.claimEveryEth} ETH` : '';
  console.log(`[scheduler] started — mode="${config.triggerMode}" schedule="${config.pollSchedule}"${gate} (dryRun=${config.dryRun})`);
}

function pause() { state.paused = true; const s = getState(); bus.emit('scheduler', s); return s; }
function resume() { state.paused = false; const s = getState(); bus.emit('scheduler', s); return s; }

async function triggerNow() {
  if (state.isRunning) return { skipped: true, reason: 'cycle already running' };
  state.isRunning = true;
  state.lastRunAt = new Date().toISOString();
  try {
    const cycle = await runCycle();
    state.lastResult = { id: cycle.id, status: cycle.status };
    return cycle;
  } finally {
    state.isRunning = false;
  }
}

function getState() {
  return {
    triggerMode: config.triggerMode, pollSchedule: config.pollSchedule, claimEveryEth: config.claimEveryEth,
    paused: state.paused, isRunning: state.isRunning, lastRunAt: state.lastRunAt,
    lastResult: state.lastResult, lastClaimable: state.lastClaimable, phase: state.lastPhase,
    startedAt: state.startedAt,
  };
}

module.exports = { start, pause, resume, triggerNow, pollOnce, getState, getClaimableEth };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/jobs/scheduler.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/jobs/scheduler.js src/jobs/scheduler.test.js
git commit -m "Gate the trigger on escrow plus unswept fees"
```

---

### Task 14: Services, routes, and the server

**Files:**
- Create: `src/evm/price.js`, `src/services/{format,countdown,metrics,marketdata}.js`, `src/middleware/auth.js`, `src/routes/{status,cycles,control,metrics,stream,public}.js`, `server.js`
- Test: `src/services/format.test.js`, `src/services/countdown.test.js`

**Interfaces:**
- Produces: the HTTP surface listed in the spec.

- [ ] **Step 1: Port the chain-agnostic services and routes**

Copy verbatim from ponsliqui:
- `src/evm/price.js`, `src/services/countdown.js`, `src/services/format.js`, `src/services/marketdata.js`, `src/middleware/auth.js`
- `src/routes/cycles.js`, `src/routes/control.js`, `src/routes/metrics.js`, `src/routes/stream.js`, `src/routes/public.js`
- `src/services/countdown.test.js`, `src/services/format.test.js`

- [ ] **Step 2: Rewrite `src/services/metrics.js` for the escrow**

```js
'use strict';

// "Unclaimed" here means everything a cycle could collect: the escrow balance
// plus fees still pending on the curve or hook.

const { getClaimableEth } = require('../jobs/scheduler');

async function getUnclaimedEth() {
  return { eth: await getClaimableEth(), at: Date.now() };
}

module.exports = { getUnclaimedEth };
```

- [ ] **Step 3: Write `src/routes/status.js`**

Port ponsliqui's, replacing the `config` block with the v2 shape and adding phase:

```js
      config: {
        triggerMode: config.triggerMode,
        pollSchedule: config.pollSchedule,
        claimEveryEth: config.claimEveryEth,
        rewardBuyPct: config.rewardBuyPct,
        burnPct: config.burnPct,
        devPct: config.devPct,
        minBurnEth: config.minBurnEth,
        minHold: config.minHold,
        deadAddress: config.deadAddress,
      },
```

and add, beside `token`:

```js
      phase: scheduler.getState().phase,   // 'curve' | 'v4' | null
```

- [ ] **Step 4: Write `server.js`**

Port ponsliqui's `server.js`, changing the name and description strings to babyrobbie and adding `GET /api/unclaimed` to the endpoint list. Everything else — CORS allow-list, the quiet one-line-per-origin rejection log, graceful shutdown — is unchanged.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS, all files

- [ ] **Step 6: Start the server and smoke-test it**

Run: `npm start` (needs a local mongod, or set `MONGODB_URI`)
Then: `curl -s localhost:3000/ | head -20` and `curl -s localhost:3000/api/status`
Expected: JSON with `dryRun: true`, `chainId: 4663`, a wallet address, and `scheduler.triggerMode`.

- [ ] **Step 7: Commit**

```bash
git add src/services/ src/routes/ src/middleware/ src/evm/price.js server.js
git commit -m "Add the HTTP surface, SSE stream, and phase-aware status"
```

---

### Task 15: Operator scripts, env example, and README

**Files:**
- Create: `scripts/_util.js`, `scripts/check.js`, `scripts/sweep.js`, `scripts/claim.js`, `scripts/buy.js`, `scripts/burn.js`, `scripts/run-once.js`, `.env.example`, `README.md`

- [ ] **Step 1: Port `scripts/_util.js`**

Copy from ponsliqui verbatim (arg parsing, `hr()`, `--confirm` gate).

- [ ] **Step 2: Write `scripts/check.js`**

Read-only preflight. Sends nothing. It must verify the one thing that silently starves the bot — that this wallet is the token's `creatorFeeRecipient`:

```js
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
  console.log('token      :', config.tokenAddress || '⚠️ MISSING — set TOKEN_ADDRESS (BABY ROBBIE)');
  console.log('reward     :', config.rewardToken, `(${config.rewardSymbol} — bought + airdropped)`);
  console.log('split      :', `${config.rewardBuyPct}% reward / ${config.burnPct}% burn / ${config.devPct}% dev`);
  console.log('minHold    :', config.minHold, `${config.tokenSymbol} to qualify`);
  console.log('minBurnEth :', config.minBurnEth, '(burns below this are skipped as dust)');

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
```

- [ ] **Step 3: Write the remaining scripts**

Each is a thin `--confirm`-gated wrapper. `scripts/sweep.js` in full — the other four follow this exact shape:

```js
'use strict';
// Sweep pending fees into the escrow.  node scripts/sweep.js --confirm
const { config, confirmed, hr } = require('./_util');
const { getLaunch, describePhase } = require('../src/evm/launch');
const { sweepFees, sweepableEth } = require('../src/evm/sweep');

(async () => {
  const launch = await getLaunch();
  hr(`SWEEP (${describePhase(launch)})`);
  console.log('pending    :', await sweepableEth(launch), 'ETH');
  if (!confirmed) {
    console.log('\n(dry — pass --confirm to send)');
    process.exit(0);
  }
  const r = await sweepFees(launch);
  console.log(r.swept ? `✅ swept: ${r.signature}` : `⏭️  skipped: ${r.reason}`);
  process.exit(0);
})().catch((e) => { console.error('\n❌ sweep failed:', e.message); process.exit(1); });
```

The rest, same shape, differing only in the body:

- `claim.js` → prints `escrowBalanceEth()`, then `claimFromEscrow()`.
- `buy.js <eth>` → reads the amount from `process.argv[2]`, then
  `buyToken({ launch, token: config.tokenAddress, ethAmount })`.
- `burn.js <eth>` → `buyToken(...)` then `burnToken(config.tokenAddress, res.tokensBoughtRaw)`.
- `run-once.js` → `await db.connect()`, `await runCycle()`, print the returned
  cycle with `JSON.stringify(cycle, null, 2)`, `await db.close()`.

- [ ] **Step 4: Write `.env.example`**

Every variable from `config.js`, grouped and commented, with the verified addresses as defaults, `DRY_RUN=true`, and `TOKEN_ADDRESS=` left blank with a note that it is filled in after launching BABY ROBBIE.

- [ ] **Step 5: Write `README.md`**

Cover: the three-way split diagram, the two phases and why both exist, the `creatorFeeRecipient` requirement (with the note that it is set in `TokenParams` at launch and may differ from the launching wallet), the verified address table, the `InternalSwapRequiresOperator` behaviour, the disperse-contract recommendation, quick start, and the going-live checklist ending in `node scripts/check.js`.

- [ ] **Step 6: Run the full suite and the preflight**

Run: `npm test`
Expected: PASS

Run: `node scripts/check.js`
Expected: prints config, reads the live factory wiring, confirms the three `✓` marks, and exits 0 with "Set TOKEN_ADDRESS to run the remaining checks."

- [ ] **Step 7: Commit and push**

```bash
git add scripts/ .env.example README.md
git commit -m "Add operator scripts, env example, and README"
git push origin main
```

---

## Post-implementation checklist

Not tasks — the operator's list, in order, once the code is green:

1. Launch BABY ROBBIE on pons v2 with `creatorFeeRecipient` = the bot wallet and `creatorTaxBps` = 50 or 100 (0.5% or 1%).
2. Set `TOKEN_ADDRESS` in `.env`; run `node scripts/check.js` and confirm the `feeRecip.` line shows ✓.
3. Deploy `Disperse.sol` from `pons-launcher/contracts/` and set `DISPERSE_ADDRESS` before holder count grows.
4. Fund the wallet with native ETH for gas.
5. Dust-test live: `node scripts/sweep.js --confirm`, `node scripts/claim.js --confirm`, `node scripts/buy.js 0.001 --confirm`, `node scripts/burn.js 0.001 --confirm`.
6. `node scripts/run-once.js --confirm`, read the cycle, then `DRY_RUN=false npm start`.
