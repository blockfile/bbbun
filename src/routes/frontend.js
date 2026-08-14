'use strict';

// Endpoints for the babyrobbie.com site (the `tokenmeme6` frontend).
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
const repo = require('../db/repository');
const { getMarketData } = require('../services/marketdata');
const { nextRun } = require('../services/countdown');

const router = express.Router();

// How many payouts the feed returns. The site renders a scrolling ledger, so
// this is a display window, not a full history — /api/airdrops paginates.
const FEED_LIMIT = 100;

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

const loadStats = cached(15000, async () => {
  const [market, reward] = await Promise.all([
    getMarketData().catch(() => ({ marketCap: null })),
    // getDistributedTotal, NOT getAirdropTotals: the latter counts simulated
    // DRY_RUN payouts too (they carry status 'ok'), which would inflate the
    // headline number the site shows visitors.
    repo.getDistributedTotal(config.rewardToken).catch(() => ({})),
  ]);

  return {
    // Null until the token is listed on DexScreener. The site coerces
    // non-finite to 0, so send a number and keep the contract boring.
    market_cap_usd: market.marketCap ?? 0,
    total_robbie_distributed: reward.totalUi ?? 0,
    updated_at: new Date().toISOString(),
  };
});

// GET /api/stats — headline numbers for the site's stats panel.
router.get('/stats', async (req, res, next) => {
  try {
    res.json(await loadStats());
  } catch (err) {
    next(err);
  }
});

const loadRewards = cached(5000, async () => {
  const { items } = await repo.getAirdrops(FEED_LIMIT, 0, config.rewardToken);

  return {
    // The site asks the backend to own this clock so every viewer counts down
    // to the same moment rather than to whenever their own tab loaded. Because
    // we send it, the site ignores its own fallback cycle constant.
    next_distribution_at: new Date(nextRun(config.pollSchedule, Date.now()).nextAirdropAt).toISOString(),
    rewards: items.filter((r) => r.status === 'ok' && isRealTxHash(r.signature)).map(toRewardRow),
  };
});

// GET /api/rewards — the ROBBIE payout ledger, newest first, plus the clock.
router.get('/rewards', async (req, res, next) => {
  try {
    res.json(await loadRewards());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.isRealTxHash = isRealTxHash;
module.exports.toRewardRow = toRewardRow;
