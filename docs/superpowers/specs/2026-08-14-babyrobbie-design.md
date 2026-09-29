# babyrobbie — design

> **Inherited from babyrobbie.** This document records how the parent bot
> (BABY ROBBIE / ROBBIE) was designed and built. BBBUN forked it on 2026-09-29
> and pays BUN to BABYBUNDLECAT holders, with a buyback+burn leg the parent
> never had. Names below are the parent's, deliberately left unchanged.

**Creator-fee reward bot for a pons v2 token on Robinhood Chain (Uniswap v4).**

Date: 2026-08-14

## Summary

BABY ROBBIE is launched on the pons v2 launchpad. Its trading generates creator
fees. This bot claims those fees on a timer and recycles them into three streams:

```
BABY ROBBIE creator fees  (claimed as native ETH from the pons v2 fee escrow)
  ├─ 80%  → buy ROBBIE  → airdrop to BABY ROBBIE holders (>=100k, pro-rata)
  └─ 20%  → dev cut + gas  (stays native, no action needed)
```

BABY ROBBIE's trading fees fund the cycle and its holders are the recipients.
ROBBIE is only ever bought and handed out.

**There is no burn leg.** An earlier revision of this design bought BABY ROBBIE
with 0.1% of each claim and sent it to the dead address; that was dropped, and
its share folds into the dev cut, which is defined as the remainder. Nothing in
this project buys or burns BABY ROBBIE.

This is a sibling of `ponsliqui`, which does the same job for a pons **v1**
token. pons v2 is a different protocol, not a newer version of v1, so the entire
chain layer is new. Everything above it is a port of ponsliqui's proven code.

## Why v1's approach does not carry over

| | ponsliqui (pons v1) | babyrobbie (pons v2 → Uniswap v4) |
|---|---|---|
| Claim fees | `locker.collectFees(token)` → WETH | `sweep` → `escrow.claim()` → **native ETH** |
| Read claimable | static-call V3 `collect()` | `escrow.balanceOf(wallet)` |
| Buy | V3 `SwapRouter02.exactInputSingle` | **v4 UniversalRouter** `execute()` (V4_SWAP) |
| Currency | WETH — wrap + approve | native ETH — no wrap, no approve, no Permit2 |
| Pool | exists from launch | bonding curve first, v4 pool at graduation |

The native-ETH property removes three whole failure modes ponsliqui has to
handle: wrapping a shortfall, keeping a router allowance, and unwrapping the
remainder at the end of a cycle. The dev cut needs no transaction at all.

## Verified on-chain facts

All addresses read from Robinhood Chain (chain id 4663) on 2026-08-14 and
confirmed against verified sources on Blockscout.

| What | Address |
|---|---|
| pons v2 Factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| V2MemeHook | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` |
| V2FeeEscrow | `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` |
| V2BuybackVault | `0x42df2a798f82289E177311362e8f5ccC45c1219c` |
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| UniversalRouter | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| StateView | `0x0284Cb0bcbaa8B87A8AA409D0e41afA7a76355F2` |
| V4Quoter | `0x5c3db48cFd8352D845fac70009d714F0Ce1d7914` |
| Permit2 (unused — buys are native) | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| ROBBIE (reward token) | `0xe0eba1B76b73BE7bfA7716b6Ca96f724930e2263` |
| pons fee-sweep operator | `0x49BbF2b70955Fb3a106e084D4BFDa92d334573d2` |

**ROBBIE** (`$ROBBIE`, 18 decimals, 1B supply) was launched on pons v2 and has
already graduated. Its v4 PoolKey is `(native 0x0, ROBBIE, fee 0, tickSpacing
200, hooks = V2MemeHook)`, giving poolId
`0x813707ded6381854b2d96c3d942960c5d362244a0903ac7d5c4d471e0c6b175f`. This is
used as a live read-only fixture in tests, since it is a real graduated pool.

**Fee economics** (global hook policy, read live): `hookFeeBps = 100` — 1% of
every swap is taken by the hook. `protocolFeeShareBps = 3000` — the protocol
keeps 30%, the creator receives 70% of that 1%. A launch may additionally set
`creatorTaxBps`, charged on top and paid entirely to the creator.

As evidence the claim path works end to end: ROBBIE's creator
(`0xBFcC109e48fb1e28489FD3cd00C7266d3E9445AE`) had **21.37 ETH** sitting
claimable in the escrow at the time of writing.

## The two phases, and why the escrow unifies them

A pons v2 launch mints the whole supply into a `PonsV2BondingCurve`. The token
trades on that curve until `graduationThreshold` (4.2 ETH) is raised, at which
point the factory seeds a Uniswap v4 pool and the curve halts.

Both phases pay the creator's share into the **same** `V2FeeEscrow`:

```
CURVE phase (pre-graduation)          V4 phase (post-graduation)
  curve.sweepFees(minBuybackOut)        hook.sweepPoolFees(poolId, …)
  authorized: curve.deployer            authorized: launches[poolId].creator
         │                                      │
         └──────────► V2FeeEscrow ◄─────────────┘
                   escrow.balanceOf(wallet)   ← one claimable read
                   escrow.claim()             ← one withdrawal, native ETH
```

Supporting both phases is therefore cheap: one `sweep()` and one `buy()`
abstraction, each switching on `curve.graduated()`. It is also necessary —
BABY ROBBIE launches onto the curve and would earn nothing until 4.2 ETH is
raised if only the v4 path existed.

### Authorization is a single role

On the curve, `setCreatorFeeRecipient(newRecipient)` literally reassigns
`deployer = newRecipient`. On the hook, it reassigns `launches[poolId].creator`.
Both sweep functions authorize against exactly that field, and the escrow credits
that same address.

So one wallet — BABY ROBBIE's **`creatorFeeRecipient`** — can sweep *and* claim in
both phases. It is set in `TokenParams` at launch and may differ from the wallet
that launches the token, so the pons-launcher dev wallet can launch while this
bot's wallet takes the fees.

### Launch-time settings that decide how much the bot earns

Two fields in `TokenParams` are set once, at launch, and cannot be raised
afterwards. They are the largest lever on this bot's revenue and belong in the
launch checklist, not in this repo's config:

- **`creatorFeeRecipient`** — must be this bot's wallet, per the section above.
- **`creatorTaxBps`** — an extra tax charged on every trade and paid to the
  creator **in full**, with no protocol share taken. The factory caps it at
  `maxCreatorTaxBps = 1000` (10%). Live launches use the full range: `$NYAM`
  runs 0, `FORGE` runs 100 (1%), `hRWA` runs 1000 (10%).

Without a creator tax the bot's only income is the creator's 70% of the 1%
trade fee — that is, 0.7% of volume. Setting `creatorTaxBps` adds its full value
on top, so a 1% tax more than doubles the bot's income and a 10% tax is roughly
fifteen times it. It also makes the token more expensive to trade, which is the
trade-off to weigh before launch.

The launch fee itself is 0.0005 ETH.

### The operator caveat

Both sweep functions revert `InternalSwapRequiresOperator` when the pool or curve
holds memecoin-denominated pending fees, or a pending buyback, because clearing
those requires an internal swap with a slippage bound only pons's trusted
operator may set.

This is expected, not exceptional. The bot treats a failed sweep as
non-fatal: it logs, skips, and claims whatever is already sitting in the escrow.
Fees are never lost — they stay pending until pons's operator sweeps them, and
the next cycle picks them up.

## Architecture

Node 20, CommonJS, Express, MongoDB, ethers v6, node-cron — ponsliqui's stack.

```
REUSED from ponsliqui             REWRITTEN for v2/v4
  jobs/scheduler.js                 evm/escrow.js    claimable + claim
  jobs/cycle.js      (reshaped)     evm/launch.js    v2 factory record, phase
  services/distribution.js          evm/sweep.js     curve | hook dispatch
  services/format, countdown        evm/buy.js       curve | v4 dispatch
  services/fetchJson, metrics       evm/v4router.js  UniversalRouter V4_SWAP
  evm/airdrop.js                    evm/curve.js     curve buy + reads
  evm/holders.js                    evm/pool.js      PoolKey, poolId, quote
  evm/erc20.js       (minus WETH)   evm/exclude.js   v4-aware exclusions
  db/ routes/ events (SSE)          evm/escrow.js    claim (native ETH)
  scripts/*.js       (retargeted)
```

### Module responsibilities

- **`evm/launch.js`** — reads `factory.getLaunchedToken(token)` once per cycle
  and derives the phase: `{ curve, creatorFeeRecipient, graduated, poolFee,
  tickSpacing, poolId }`. Every phase decision downstream reads this one record,
  so a cycle cannot straddle two phases inconsistently.
- **`evm/pool.js`** — pure PoolKey construction and `poolId =
  keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))`, plus
  quotes via V4Quoter and price reads via StateView. Native ETH is `address(0)`
  and always sorts to `currency0`.
- **`evm/v4router.js`** — encodes `UniversalRouter.execute(commands, inputs,
  deadline)` for a single V4_SWAP: actions `SWAP_EXACT_IN_SINGLE`, `SETTLE_ALL`,
  `TAKE_ALL`, with `msg.value` carrying the ETH. No approval path exists here
  deliberately — the bot only ever buys with native ETH and never sells.
- **`evm/sweep.js`** — dispatches on `graduated`, swallows
  `InternalSwapRequiresOperator`, returns `{ swept, skipped, reason }`.
- **`evm/buy.js`** — dispatches on `graduated`; re-quotes and retries up to 3
  times on revert, as ponsliqui does.
- **`evm/exclude.js`** — the exclusion set for airdrops. Beyond ponsliqui's
  entries this must exclude the **PoolManager** (it custodies all v4 pool
  liquidity and shows up as a large holder), the **bonding curve**, the
  **hook**, the **buyback vault**, and the **escrow**.

### The cycle

```
tick (POLL_SCHEDULE)
  └─ claimable = escrow.balanceOf(wallet) + sweepable(phase)
     gate: interval (any > 0) | accumulation (>= CLAIM_EVERY_ETH)
        └─ runCycle()
           1. sweep    graduated ? hook.sweepPoolFees : curve.sweepFees   [best-effort]
           2. claim    escrow.claim()  → native ETH, measured from the receipt
           3. split    80% / 20% of the claimed amount
           4. reward   buy ROBBIE → snapshot BABY ROBBIE holders → airdrop pro-rata
           5. dev      no action — already native ETH
```

Each step is persisted to MongoDB and pushed to SSE clients. A thrown step
records an `error` step and fails the cycle without crashing the process.

### The trigger must count unswept fees, not just the escrow

Fees accrue **on the curve or the hook** and only reach the escrow when someone
sweeps. Before the first sweep `escrow.balanceOf(wallet)` reads zero even though
real money is waiting — verified live on the unbonded `$NYAM` curve, which held
0.005885 ETH in `quoteFeeBalance` against an escrow balance of 0.

Gating on the escrow alone therefore deadlocks: the bot sees nothing claimable,
never sweeps, so nothing ever reaches the escrow. The claimable figure is:

```
claimable = escrow.balanceOf(wallet) + sweepable(phase)

sweepable, curve phase = creatorShare(curve.quoteFeeBalance())
                       + curve.creatorTaxBalance()
sweepable, v4 phase    = creatorShare(hook.pendingFees(poolId, quote))
                       + hook.pendingCreatorTax(poolId, quote)

creatorShare(x) = x * (10000 - protocolFeeShareBps) / 10000
```

The creator tax is not subject to the protocol share — it is paid to the creator
in full. The buyback earmark is subtracted from the creator bucket only when the
launch enables buyback, which this one will not.

### Claimed amount is measured, not estimated

The amount is parsed from the escrow's own `Claimed(address indexed recipient,
uint256 amount)` event in the claim receipt — not from the pre-claim
`balanceOf` read, and not from a native-balance delta, which gas would pollute.
This mirrors ponsliqui's decision to parse actual `Transfer` logs rather than
trust an estimate, and it matters because a sweep landing between the read and
the claim would otherwise under-count.

## Airdrop

Ported from ponsliqui unchanged in shape: snapshot holders from the Blockscout
REST API (verified working for v2 tokens — paginated
`/api/v2/tokens/{token}/holders`), filter to `>= MIN_HOLD` and drop exclusions,
compute BigInt allocations with largest-remainder so they sum exactly to the
amount bought, then send.

Sending uses ponsliqui's sliding-window pipeline (locally-tracked nonce, fixed
gas, confirmation off the submission path) or a disperse contract when
`DISPERSE_ADDRESS` is set.

**Gas is the real constraint.** ROBBIE has 2,628 holders; BABY ROBBIE's count is
unknown until launch, but at a 100k min-hold against a 1B supply (0.01%) most
holders will qualify, implying thousands of transfers per cycle. Deploying the
`Disperse.sol` contract from the sibling `pons-launcher` project and setting
`DISPERSE_ADDRESS` collapses each batch into one transaction and is strongly
recommended before going live. The 19.9% dev cut exists to fund this.

## Configuration

```
REWARD_BUY_PCT=80          # buy ROBBIE + airdrop
                           # dev = 100 - 80 = 20, kept as native ETH
MIN_HOLD=100000            # min BABY ROBBIE balance to qualify
TOKEN_ADDRESS=             # BABY ROBBIE — blank until launched
REWARD_TOKEN=0xe0eba1B76b73BE7bfA7716b6Ca96f724930e2263
```

All verified v2/v4 addresses ship as defaults. `WALLET_PRIVATE_KEY` must be
BABY ROBBIE's `creatorFeeRecipient`. `DRY_RUN=true` is the default and simulates
every chain call.

## Error handling

- **Sweep unauthorized** (`InternalSwapRequiresOperator`) — log, skip, claim the
  existing escrow balance, continue. Not a cycle failure.
- **Buy revert** — re-quote and retry 3 times. More likely on v4 than v3 because
  the hook takes 1% and caps internal price impact at 300 bps.
- **Holders fetch** — retry transient explorer 5xx/429, as ponsliqui does, so a
  Blockscout blip does not fail a cycle after ROBBIE has already been bought.
- **Nothing claimable** — cycle recorded as `skipped`, no transactions sent.

## Testing

`node --test` with `mongodb-memory-server`, as ponsliqui.

Ported suites cover distribution math, holder filtering, the airdrop pipeline,
scheduler gating, and config parsing. New suites cover:

- **poolId derivation** — asserted against ROBBIE's known
  `0x813707ded6381854b2d96c3d942960c5d362244a0903ac7d5c4d471e0c6b175f`.
- **V4_SWAP encoding** — commands, actions and input encoding for a native-ETH
  exact-in swap.
- **Phase dispatch** — curve vs v4 for both sweep and buy.
- **Split math** — the reward and dev legs always re-add to the claim.
- **Exclusions** — PoolManager, curve, hook, vault and escrow are all dropped.

## Scripts

Read-only preflight and dust-tests, each requiring `--confirm` to send:

- `check.js` — verifies the wallet is BABY ROBBIE's `creatorFeeRecipient`,
  reports the phase, escrow balance, resolved poolId and a live quote. Degrades
  gracefully when `TOKEN_ADDRESS` is unset.
- `sweep.js`, `claim.js`, `buy.js`, `run-once.js`.

## API

Ported from ponsliqui: public frontend-shaped endpoints (`/activity`, `/stats`,
`/summary`, `/accrual`, `/countdown`), the operational API (`/api/status`,
`/api/cycles`, `/api/airdrops`, `/api/transactions`, `/api/stream` SSE), and
API-key-protected controls (`POST /api/run|pause|resume`).

`/api/status` gains phase reporting: which phase the token is in, progress
toward the 4.2 ETH graduation threshold while on the curve, and whether the last
sweep was skipped for lack of operator authorization.

## Out of scope

- Launching BABY ROBBIE. That is `pons-launcher`'s job; this bot takes
  `TOKEN_ADDRESS` once the token exists.
- Selling any token. The bot only buys and transfers, which is why no Permit2
  approval path is built.
- Burning anything. See the note under Summary.
- A frontend. The public endpoints are shaped for one, but the site lives
  elsewhere, as with ponsliqui.

## Open risks

1. **BABY ROBBIE does not exist yet.** Development and tests run against
   `DRY_RUN` plus two live read-only fixtures, both confirmed on chain:
   ROBBIE's graduated v4 pool for the post-bond path, and the unbonded `$NYAM`
   curve (`0x70abE52baaFfDE66ea2f291D5d984A888473aCd6`, token
   `0xC73C4456960c770003efc5D7627b8d71FE3D6297`) for the curve path. Curves are
   short-lived — they graduate — so the test should resolve an unbonded curve
   dynamically from recent `TokenLaunched` events rather than pin this address.
2. **Airdrop gas at scale**, addressed by `DISPERSE_ADDRESS` above.
3. **pons may redeploy v2 contracts without a changelog.** The sibling project
   documents that the published docs list superseded addresses. Every address is
   therefore configurable, and `check.js` validates the wiring at boot by
   reading `factory.feeEscrow()`, `factory.memeHook()` and
   `hook.poolManager()` rather than trusting the constants.
