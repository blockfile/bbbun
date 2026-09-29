'use strict';

// Endpoints for the bbbun.com site (the `tokenmeme6` frontend).
//
// The field names here are NOT ours to choose — they are what that site's
// parsers read (`src/api/stats.js`, `src/api/rewards.js`). Renaming a key
// breaks the site silently: its parsers coerce a missing field to 0 rather
// than erroring, so a typo shows up as a zeroed stat, not a failed request.
//
// Deliberately separate from routes/public.js, which serves a DIFFERENT
// frontend contract (/activity, /stats, /summary at the root). Two sites, two
// contracts; keeping them apart means changing one cannot break the other.

const express = require('express');
const config = require('../config');
const { burnedPctOfSupply } = require('../evm/burn');
const { getHolderCount } = require('../services/holdercount');
const repo = require('../db/repository');
const { getMarketData } = require('../services/marketdata');
const { nextRun } = require('../services/countdown');

const router = express.Router();

// How many payouts the feed returns.
//
// This MUST comfortably exceed the recipients in one cycle, or the ledger
// cannot show even a single drop: the site fetches once and paginates what it
// gets, so a holder in the older part of the latest cycle searches their wallet
// and finds nothing — indistinguishable, to them, from not being paid. That is
// exactly what happened at the old value of 100 against 134 recipients.
//
// Sized for several cycles of headroom at the current holder count. A row is
// ~150 bytes of JSON, so even the cap is a couple of MB, served from a 5s cache.
const FEED_LIMIT = 1000;
const FEED_LIMIT_MAX = 5000;

// Tiny in-memory TTL cache, de-duping concurrent requests. Copied rather than
// shared with routes/public.js on purpose: these two route files serve
// independent contracts and should not acquire a common dependency that a
// change to one site could ripple through.
function cached(ttlMs, fn) {
  let value;
  let expires = 0;
  let inflight = null;
  return async () => {
    if (Date.now() < expires) return value;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        value = await fn();
        expires = Date.now() + ttlMs;
        return value;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

/**
 * A real on-chain transaction hash, as opposed to a DRY_RUN placeholder.
 *
 * This is a safety filter, not cosmetics. In DRY_RUN the bot records airdrop
 * rows with status 'ok' and a fabricated `airdrop_ka9f2x` signature. Serving
 * those to the public site would publish invented payouts to real visitors,
 * each linking to a transaction that does not exist. The same test also drops
 * failed sends, whose signature is null.
 */
function isRealTxHash(signature) {
  return typeof signature === 'string' && /^0x[0-9a-fA-F]{64}$/.test(signature);
}

/** One airdrop row in the shape `src/api/rewards.js` parses. */
function toRewardRow(row) {
  return {
    wallet_address: row.recipient,
    amount: row.amount_ui ?? 0,
    timestamp: row.created_at,
    tx_hash: row.signature,
  };
}

/**
 * Pure: the headline numbers, in the shape the site reads.
 *
 * The site (D:\projects\tokenmeme16, src/api/stats.js) wants four fields and
 * THROWS unless every one of them is a finite number — a missing field blanks
 * the whole panel, not one tile. It accepts a few spellings each; the short
 * ones are served here, with the longer names kept beside them so an older
 * reader of this API keeps working:
 *
 *   marketCap      <- market_cap      (USD)
 *   holders        <- holders         (wallet count)
 *   bunRewarded    <- bun_rewarded    (BUN TOKENS paid out, not dollars)
 *   babybunBurned  <- babybun_burned  (BABYBUNDLECAT tokens sent to 0x…dEaD)
 *
 * Every value is a NUMBER, never null: before launch they are all honestly 0.
 */
function buildStats({ market = {}, reward = {}, totals = {}, holders = null }) {
  const burned = totals.total_tokens_burned ?? 0;
  const rewarded = reward.totalUi ?? 0;
  const marketCap = market.marketCap ?? 0;
  return {
    // What the site reads.
    market_cap: marketCap,
    holders: holders ?? 0,
    bun_rewarded: rewarded,
    babybun_burned: burned,

    // The same figures under this API's own names, plus what the burn cost.
    market_cap_usd: marketCap,
    total_bun_distributed: rewarded,
    total_bbc_burned: burned,
    burned_pct_of_supply: burnedPctOfSupply(burned, config.tokenTotalSupply) ?? 0,
    eth_spent_burning: totals.total_eth_spent_burn ?? 0,
    updated_at: new Date().toISOString(),
  };
}

const loadStats = cached(15000, async () => {
  const [market, reward, totals, holders] = await Promise.all([
    getMarketData().catch(() => ({ marketCap: null })),
    // getDistributedTotal, NOT getAirdropTotals: the latter counts simulated
    // DRY_RUN payouts too (they carry status 'ok'), which would inflate the
    // headline number the site shows visitors.
    repo.getDistributedTotal(config.rewardToken).catch(() => ({})),
    // Burn totals come from the CYCLES, which only record a burn that actually
    // landed on chain; a failed transfer leaves the tokens in the wallet and is
    // deliberately not counted as burned.
    repo.getStats().catch(() => ({})),
    getHolderCount().catch(() => null),
  ]);
  return buildStats({ market, reward, totals, holders });
});

// GET /api/stats — headline numbers for the site's stats panel.
router.get('/stats', async (req, res, next) => {
  try {
    res.json(await loadStats());
  } catch (err) {
    next(err);
  }
});

/** Clamp a caller-supplied ?limit= to something we are willing to serve. */
function parseLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return FEED_LIMIT;
  return Math.min(n, FEED_LIMIT_MAX);
}

// One cache per distinct limit. Without keying on it, the first caller's limit
// would be served to everyone for the whole TTL.
const rewardsCaches = new Map();
function rewardsLoader(limit) {
  if (!rewardsCaches.has(limit)) {
    rewardsCaches.set(
      limit,
      cached(5000, async () => {
        const { items } = await repo.getAirdrops(limit, 0, config.rewardToken);
        return {
          // The site asks the backend to own this clock so every viewer counts
          // down to the same moment rather than to whenever their own tab
          // loaded. Because we send it, the site ignores its fallback constant.
          next_distribution_at: new Date(
            nextRun(config.pollSchedule, Date.now()).nextAirdropAt
          ).toISOString(),
          rewards: items.filter((r) => r.status === 'ok' && isRealTxHash(r.signature)).map(toRewardRow),
        };
      })
    );
  }
  return rewardsCaches.get(limit);
}

// GET /api/rewards — the BUN payout ledger, newest first, plus the clock.
// ?limit= is optional; the site sends none and gets FEED_LIMIT.
router.get('/rewards', async (req, res, next) => {
  try {
    res.json(await rewardsLoader(parseLimit(req.query.limit))());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.buildStats = buildStats;
module.exports.isRealTxHash = isRealTxHash;
module.exports.toRewardRow = toRewardRow;
module.exports.parseLimit = parseLimit;
module.exports.FEED_LIMIT = FEED_LIMIT;
module.exports.FEED_LIMIT_MAX = FEED_LIMIT_MAX;
