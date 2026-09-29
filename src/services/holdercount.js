'use strict';

// How many wallets hold BABYBUNDLECAT, for the site's "Holders" tile.
//
// From the explorer, not the chain: a count needs every holder, and the bot
// already pays a full holder snapshot once per cycle — doing it again on every
// page load would be absurd. Blockscout keeps the number ready.
//
// Never throws and never guesses: an unlisted token or an unreachable explorer
// gives null, and the caller decides what to show. The last good value is kept
// briefly so one bad response does not blank a tile that was fine a second ago.

const config = require('../config');
const { fetchJson } = require('./fetchJson');

const TTL_MS = 60_000;
let cache = { value: null, at: 0 };

/**
 * @returns {Promise<number|null>} holders, or null when it cannot be known
 */
async function getHolderCount({ token = config.tokenAddress, now = Date.now, fetchImpl } = {}) {
  if (!token) return null;
  if (cache.value !== null && now() - cache.at < TTL_MS) return cache.value;

  try {
    const url = `${config.explorerApi}/api/v2/tokens/${token}`;
    const data = await fetchJson(url, { headers: { accept: 'application/json' }, ...(fetchImpl ? { fetchFn: fetchImpl } : {}) });
    // Blockscout names it holders_count; older deployments answer "holders".
    const raw = data?.holders_count ?? data?.holders;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return cache.value; // keep the last good one
    cache = { value: n, at: now() };
    return n;
  } catch (_err) {
    return cache.value; // stale beats blank; null until the first success
  }
}

/** Test helper: forget the cached count. */
function _resetHolderCount() {
  cache = { value: null, at: 0 };
}

module.exports = { getHolderCount, _resetHolderCount };
