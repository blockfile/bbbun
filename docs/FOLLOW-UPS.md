# Known follow-ups

Deferred items from the build. None block operation; all were reviewed and
consciously left. Recorded here so they are not lost with the build scratch.

## Worth doing before heavy traffic

- **`AIRDROP_BATCH_SIZE` nonce resync race** — `src/evm/airdrop.js:135`. On a send
  failure the pipeline resyncs via `getTransactionCount(pending)` while up to
  `AIRDROP_BATCH_SIZE` locally-nonced transactions are still in flight, so it can
  return a nonce an unmined transaction already claimed. Inherited from the
  ported pipeline and never observed; speculative without a repro, but the window
  widens as holder count grows.
- **`MIN_HOLD` assumes 18 decimals** — `src/jobs/cycle.js:48` builds `minHoldRaw`
  with a hardcoded `10n ** 18n` while every other amount in the file goes through
  `getDecimals`. Correct for pons v2 today; silently wrong by orders of magnitude
  if `TOKEN_ADDRESS` ever points at a non-18-decimal token.
- **Deploy the disperse contract.** `contracts/Disperse.sol` in the sibling
  `pons-launcher` project. Airdrop gas scales with holder count every cycle;
  retrofitting after the holder list grows means paying the difference on every
  cycle in between.

## Cosmetic / low value

- `src/evm/simvault.js:5` — comment says real fees accrue "in the token's V3 LP
  position". That is v1 language; on pons v2 they accrue on the bonding curve or
  the V2MemeHook and reach the escrow via a sweep. Comment only.
- `src/evm/pool.js` re-exports `QUOTE_SINGLE_TYPE`, which no module imports.
- `src/evm/buy.js` — the curve path reads `balanceOf` four times per attempt
  where two suffice: `buyOnCurve` computes its own delta and returns
  `tokensBoughtRaw`, which `buy.js` ignores in favour of its own before/after
  read. Wasted RPC round trips, no correctness impact.
- `src/jobs/scheduler.test.js` — the cron test asserts `cron.validate()` directly
  rather than asserting `start()` throws on a bad `POLL_SCHEDULE`.
- `src/evm/sweep.js` — the operator-error selector match uses `includes()` rather
  than an anchored `startsWith()`. Safe for a bare 4-byte revert; worth anchoring
  for defence in depth.
- `GAS_RESERVE_ETH` is read into config and documented but referenced by no code.
  Nothing verifies the wallet retains gas before a buy.

## Testing gaps

- **No live-chain integration test.** The v4 path was validated against bbbun's own reward token (BUN, 0xe0eb…2263) and its
  real pool only through the `poolId` derivation assertion; the curve path has no
  committed live fixture. The spec's open-risk note suggested resolving an
  unbonded curve dynamically from recent `TokenLaunched` events — that was done
  by hand during the build (the `$NYAM` curve) but never committed as a test.
- **`check.js` reports no live quote.** The spec asks for one. As it stands the
  v4 quoter is first exercised on the live buy path, with real money.
- **No wiring validation at boot.** `check.js` re-reads `factory.feeEscrow()`,
  `factory.memeHook()` and `hook.poolManager()` from chain, but it is a manual
  script; `server.js` boots without it. pons has redeployed v2 contracts without
  a changelog before, which is why those reads exist.
- **DRY_RUN accrues fees twice per cycle** (once in the scheduler tick, once in
  the simulated sweep), so a simulated claim is always double the `claimable` the
  scheduler logged, and the "nothing claimed → skipped" branch is unreachable
  under `DRY_RUN`.
- **`/api/status` reports `phase: null` under DRY_RUN** — `state.lastPhase` is
  set only on the live path.
