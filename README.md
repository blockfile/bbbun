# babyrobbie

**Creator-fee reward bot for BABY ROBBIE, a pons v2 token on Robinhood Chain (Uniswap v4).**

Every cycle, it claims BABY ROBBIE's creator fees — paid out as **native ETH**
— and recycles them:

```
BABY ROBBIE creator fees  (claimed as native ETH from the pons v2 fee escrow)
  ├─ 80%  → buy ROBBIE  → airdrop to BABY ROBBIE holders (>=100k, pro-rata)
  └─ 20%  → dev cut + gas  (stays native ETH in the wallet, no action needed)
```

**There is no burn leg.** Nothing in this bot buys or burns BABY ROBBIE — an
earlier revision did, and it was removed. BABY ROBBIE's own trading generates
the fees that fund the cycle; ROBBIE is the only thing ever bought, and it is
only ever bought to hand out to BABY ROBBIE holders.

`DRY_RUN=true` is the default everywhere. Every script that can send a
transaction requires `--confirm`; without it, it prints a preview and exits.

## The two phases, and why the bot handles both

A pons v2 launch mints the whole token supply onto a **bonding curve**. The
token trades there — and only there — until `graduationThreshold` (4.2 ETH) is
raised, at which point the factory seeds a **Uniswap v4 pool** and the curve
halts. BABY ROBBIE starts on the curve and would earn this bot nothing until
graduation if only the v4 path existed, so `sweep` and `buy` each dispatch on
`curve.graduated()` and support both venues.

Both phases pay the creator's share into the same escrow:

```
CURVE phase (pre-graduation)          V4 phase (post-graduation)
  curve.sweepFees(minBuybackOut)        hook.sweepPoolFees(poolId, …)
         │                                      │
         └──────────► V2FeeEscrow ◄─────────────┘
                   escrow.balanceOf(wallet)   ← claimable, read-only
                   escrow.claim()             ← withdrawal, native ETH
```

Fees accrue *on* the curve or *on* the hook and only reach the escrow once
someone sweeps — the bot's cycle does that first, then claims. There is no
wrapping and no approval anywhere in the buy path: everything is spent and
received as native ETH (`address(0)`), never WETH, and there is no Permit2
allowance to maintain because the bot only ever buys, never sells.

## `creatorFeeRecipient` — the one thing that must not be wrong

**`WALLET_PRIVATE_KEY` must belong to BABY ROBBIE's `creatorFeeRecipient`.**
That single address is the *only* one authorized to sweep pending fees **and**
to claim the escrow, in both phases — on the curve it literally *is*
`curve.deployer`; on the hook it is `launches[poolId].creator`; the escrow
credits whichever address holds that role.

It is set once in `TokenParams` at launch and **can differ from the wallet
that launches the token** — the pons-launcher dev wallet can launch BABY
ROBBIE while this bot's wallet is named as the fee recipient and takes the
fees. If the wrong address ends up as `creatorFeeRecipient`, the bot runs
without throwing a single error — it just has nothing to sweep or claim, ever.
The cycle silently starves.

`node scripts/check.js` exists largely to catch this before it costs you
anything. Its `feeRecip.` line is the most important thing it prints:

```
feeRecip.  : 0x1234...  ✓ (this wallet — authorized to sweep AND claim)
```

If it instead shows `⚠️ NOT this wallet`, stop — nothing downstream will work
until the token's `creatorFeeRecipient` is fixed (or `WALLET_PRIVATE_KEY` is
changed to match it).

`check.js` is a manual preflight, so the running bot does not rely on you
having remembered it: **every cycle re-checks the launch record it already
reads** and logs a loud `creatorFeeRecipient MISMATCH` warning naming both
addresses when they differ. It warns rather than throws — an operator may be
mid-migration — and the result is published as `feeRecipientOk` on
`/api/status`.

The other launch-time lever worth knowing: `creatorTaxBps`, capped at 1000
(10%), is an extra per-trade tax paid to the creator in full, on top of the
protocol's normal fee split. Without it the bot's only income is the
creator's share of the 1% hook fee (0.7% of volume); a 1% tax roughly doubles
that, a 10% tax multiplies it by about fifteen. Both settings are chosen once
at launch, in `pons-launcher`, not in this repo.

## Verified addresses (Robinhood Chain, chain id 4663)

Read from chain and confirmed against verified sources on Blockscout,
2026-08-14. All are overridable via `.env` and ship as the defaults in
`.env.example`; `scripts/check.js` re-reads the escrow, hook, and pool manager
live from the factory on every run and flags any drift.

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
| ROBBIE (reward token) | `0xe0eba1B76b73BE7bfA7716b6Ca96f724930e2263` |

## When a sweep is refused — `InternalSwapRequiresOperator`

Both the curve and the hook revert `InternalSwapRequiresOperator` when
clearing pending fees would require an internal swap (memecoin-denominated
fees, or a pending buyback), because only pons's trusted operator is allowed
to set that swap's slippage bound.

**This is expected behaviour, not a bug.** `scripts/sweep.js` and the cycle's
sweep step both treat it as non-fatal: they log it, skip the sweep, and go
straight to claiming whatever is already sitting in the escrow. No fees are
lost — they stay pending, and the next cycle (or pons's own operator sweep)
picks them up. If you see a log line like

```
[sweep] sweep needs pons's trusted operator — fees stay pending for the next cycle
```

that is the bot working correctly, not failing.

## Airdrop at scale: deploy a Disperse contract

Without `DISPERSE_ADDRESS` set, the airdrop sends one ERC-20 transfer per
recipient (pipelined, not serial, but still one transaction each). ROBBIE
alone already has thousands of holders, and BABY ROBBIE, with a 100k minimum
against a 1B supply, is likely to as well — that is thousands of transactions
every cycle.

**Deploy `Disperse.sol` from the sibling `pons-launcher/contracts/` project
and set `DISPERSE_ADDRESS` before your holder count grows.** With it set, each
airdrop batch (`AIRDROP_BATCH_SIZE` recipients) becomes a single
`disperseToken(token, recipients[], values[])` transaction.

**The reward token needs a one-off `approve()` to the disperse contract first —
the bot does not do this for you, and does not check the allowance.** Without
it every batch reverts and no ROBBIE reaches anyone. A cycle that bought ROBBIE
and then delivered it to *nobody* is recorded as `failed` (not `complete`) with
that cause named in its `error`, so `totals.failed` on `/api/status` is the
number to watch. A cycle with no *eligible* holders is different, and stays
`complete` with a note.

## Config

Every variable is documented in `.env.example`; the ones worth knowing before
you start:

| Env | Default | Meaning |
|---|---|---|
| `WALLET_PRIVATE_KEY` | — | must be BABY ROBBIE's `creatorFeeRecipient` |
| `TOKEN_ADDRESS` | — | BABY ROBBIE, filled in after launch |
| `REWARD_BUY_PCT` | `80` | % of each claim used to buy ROBBIE + airdrop it (dev cut = the rest) |
| `MIN_REWARD_ETH` | `0.000001` | reward legs smaller than this are skipped for the cycle, not attempted |
| `MIN_HOLD` | `100000` | minimum BABY ROBBIE balance to qualify for the airdrop |
| `REWARD_CAP_PCT` | `0` | per-wallet airdrop weight cap, % of supply (0 = pure pro-rata) |
| `CLUSTERS` | `[]` | address groups capped as one holder (casing ignored) |
| `TRIGGER_MODE` | `interval` | `interval` (every tick) or `accumulation` (by ETH threshold) |
| `POLL_SCHEDULE` | `*/5 * * * *` | how often the scheduler ticks (every 5 minutes) |
| `CLAIM_EVERY_ETH` | `0.005` | accumulation mode: fire once claimable ≥ this (ETH) |
| `SLIPPAGE_PCT` | `5` | buy-swap slippage tolerance, percent (curve and v4 both) |
| `DISPERSE_ADDRESS` | — | batch-transfer contract; blank → pipelined transfers |

## Quick start

```bash
npm install
cp .env.example .env       # defaults are safe: DRY_RUN=true, ephemeral wallet
npm start                  # needs MongoDB (local mongod or set MONGODB_URI)
npm test                   # unit + integration tests (in-memory MongoDB)
```

## Going live

`cp .env.example .env` leaves `DRY_RUN=true`, and **`--confirm` does not
override it**. While `DRY_RUN=true`, every mutating script prints
`[DRY_RUN] simulating: …` and sends nothing — `--confirm` only gets you past
the preview. Setting `DRY_RUN=false` is what arms the bot, so it is its own
step below (step 6). Everything above it is a simulation; everything from it
down spends real ETH.

1. Launch BABY ROBBIE on pons v2 with `creatorFeeRecipient` = the bot wallet
   and `creatorTaxBps` = 50 or 100 (0.5% or 1%).
2. Set `WALLET_PRIVATE_KEY` and `TOKEN_ADDRESS` in `.env`, then run
   `node scripts/check.js` and confirm the `feeRecip.` line shows ✓. It is
   read-only, so it tells you the truth even with `DRY_RUN=true` still set.
3. Deploy `Disperse.sol` from `pons-launcher/contracts/`, set
   `DISPERSE_ADDRESS`, and send the one-off `approve()` of ROBBIE to that
   contract — the bot does not do it for you, and without it every airdrop
   batch reverts.
4. Fund the wallet with native ETH for gas.
5. Rehearse the whole cycle in simulation: `node scripts/run-once.js --confirm`,
   then read the printed cycle end to end. Still `DRY_RUN=true`, still nothing
   sent — this is your last free look at the shape of a cycle.
6. **Set `DRY_RUN=false` in `.env`.** Nothing below this line is a rehearsal.
7. Dust-test live, in this order. Each now sends a REAL transaction, and each
   pauses 3 seconds first so you can Ctrl+C:
   - `node scripts/sweep.js --confirm` — moves pending fees into the escrow
   - `node scripts/claim.js --confirm` — withdraws the escrow as native ETH
   - `node scripts/buy.js 0.001 --confirm` — one small real buy
   - `node scripts/run-once.js --confirm` — one real end-to-end cycle
8. `npm start`. The scheduler now runs live cycles on `POLL_SCHEDULE`. Check
   `/api/status`: after the first cycle `feeRecipientOk` must be `true`, and
   `totals.failed` must stay at `0` — a cycle whose airdrop reached nobody is
   recorded as `failed`, with the likely cause in its `error`.

## Scripts

All read-only unless noted; mutating ones require `--confirm` (see above).

| Script | What it does |
|---|---|
| `node scripts/check.js` | Read-only preflight. Sends nothing. Prints config, re-reads the factory wiring live, and (once `TOKEN_ADDRESS` is set) the launch record, phase, `creatorFeeRecipient` check, and claimable balances. |
| `node scripts/sweep.js [--confirm]` | Sweeps pending fees into the escrow (best-effort — see `InternalSwapRequiresOperator` above). |
| `node scripts/claim.js [--confirm]` | Withdraws the whole escrow balance to the wallet, as native ETH. |
| `node scripts/buy.js <ethAmount> [--confirm]` | Buys BABY ROBBIE with native ETH, on whichever venue it is currently trading on. |
| `node scripts/run-once.js [--confirm]` | Runs one full cycle (sweep → claim → split → buy ROBBIE → airdrop) and prints the persisted result. |

## API

The Express API (`/activity`, `/stats`, `/summary`, `/accrual`, `/countdown`,
`/api/status`, `/api/unclaimed`, `/api/stream` (SSE), `/api/cycles`,
`/api/cycles/:id`, `/api/airdrops`, `/api/transactions`,
`POST /api/run|pause|resume`) and the scheduler are the shared infra ported
from `ponsliqui`, the sibling bot for pons **v1** tokens.

## Design

See
[`docs/superpowers/specs/2026-08-14-babyrobbie-design.md`](docs/superpowers/specs/2026-08-14-babyrobbie-design.md)
and the plan in
[`docs/superpowers/plans/`](docs/superpowers/plans/).
