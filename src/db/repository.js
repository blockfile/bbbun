'use strict';

const { getDb } = require('./index');
const bus = require('../events');

const NO_ID = { projection: { _id: 0 } };

/** Atomic numeric auto-increment, mirroring simple rowids. */
async function nextId(name) {
  const db = getDb();
  const doc = await db.collection('counters').findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  // mongodb v6 returns the document directly; older shapes nest it under .value
  return (doc && doc.seq) ?? (doc && doc.value && doc.value.seq);
}

async function createCycle({ dryRun }) {
  const db = getDb();
  const id = await nextId('cycles');
  await db.collection('cycles').insertOne({
    id,
    status: 'running',
    started_at: new Date().toISOString(),
    finished_at: null,
    phase: null,
    eth_claimed: null,
    eth_spent_buy: null,
    tokens_bought: null,
    sweep_skipped: 0,
    sweep_reason: null,
    dry_run: dryRun ? 1 : 0,
    note: null,
    error: null,
  });
  return id;
}

/** Set only the provided fields; finished_at defaults to now. */
async function finishCycle(id, fields) {
  const db = getDb();
  const allowed = [
    'status', 'mode', 'phase', 'eth_claimed', 'eth_spent_buy',
    'tokens_bought', 'eth_spent_burn', 'tokens_burned',
    'eligible_holders', 'total_holders',
    'sweep_skipped', 'sweep_reason',
    'note', 'error',
  ];
  const $set = { finished_at: fields.finished_at ?? new Date().toISOString() };
  for (const key of allowed) {
    if (fields[key] !== undefined) $set[key] = fields[key];
  }
  await db.collection('cycles').updateOne({ id }, { $set });
  bus.emit('cycle', { id, status: $set.status, mode: $set.mode ?? null }); // push to SSE clients
}

async function addStep({ cycleId, name, status, signature, detail }) {
  const db = getDb();
  const id = await nextId('steps');
  const doc = {
    id,
    cycle_id: cycleId,
    name,
    status,
    signature: signature ?? null,
    detail: detail ?? null,
    created_at: new Date().toISOString(),
  };
  await db.collection('steps').insertOne(doc);
  bus.emit('step', doc); // push to SSE clients
}

async function getCycleWithSteps(id) {
  const db = getDb();
  const cycle = await db.collection('cycles').findOne({ id }, NO_ID);
  if (!cycle) return null;
  const steps = await db
    .collection('steps')
    .find({ cycle_id: id }, NO_ID)
    .sort({ id: 1 })
    .toArray();
  return { ...cycle, steps };
}

async function getCycles(limit, offset) {
  const db = getDb();
  const total = await db.collection('cycles').countDocuments();
  const items = await db
    .collection('cycles')
    .find({}, NO_ID)
    .sort({ id: -1 })
    .skip(offset)
    .limit(limit)
    .toArray();
  return { total, items };
}

async function getLastCycle() {
  const db = getDb();
  const last = await db.collection('cycles').find({}, NO_ID).sort({ id: -1 }).limit(1).toArray();
  return last.length ? getCycleWithSteps(last[0].id) : null;
}

async function getAllSteps(limit, offset) {
  const db = getDb();
  return db
    .collection('steps')
    .find({}, NO_ID)
    .sort({ id: -1 })
    .skip(offset)
    .limit(limit)
    .toArray();
}

/**
 * The holder index: every balance, and the block they were correct at.
 *
 * Written together and never apart. The index is a fold over an append-only
 * log, so it is not idempotent — re-applying a block doubles it — and the ONLY
 * thing keeping it honest is lastBlock advancing past exactly what was applied.
 */
async function getHolderIndex(token) {
  const db = getDb();
  return db.collection('holderindex').findOne({ _id: String(token).toLowerCase() }, { projection: { _id: 0 } });
}

async function setHolderIndex(token, { lastBlock, balances }) {
  const db = getDb();
  await db.collection('holderindex').updateOne(
    { _id: String(token).toLowerCase() },
    { $set: { lastBlock, balances, at: new Date().toISOString() } },
    { upsert: true }
  );
}

async function getStats() {
  const db = getDb();
  const [row] = await db
    .collection('cycles')
    .aggregate([
      {
        $group: {
          _id: null,
          cycles: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'complete'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          skipped: { $sum: { $cond: [{ $eq: ['$status', 'skipped'] }, 1, 0] } },
          total_eth_spent_buy: { $sum: { $ifNull: ['$eth_spent_buy', 0] } },
          total_tokens_bought: { $sum: { $ifNull: ['$tokens_bought', 0] } },
          total_eth_spent_burn: { $sum: { $ifNull: ['$eth_spent_burn', 0] } },
          total_tokens_burned: { $sum: { $ifNull: ['$tokens_burned', 0] } },
        },
      },
    ])
    .toArray();

  // Sum claimed ETH from the claim STEPS, not the cycles: a step is recorded the
  // moment a claim succeeds, while cycles.eth_claimed is only set at finish — a
  // cycle that claims and then fails would silently drop its claim from the total.
  const [claimRow] = await db
    .collection('steps')
    .aggregate([
      { $match: { name: 'claim', status: 'ok' } },
      { $group: { _id: null, eth: { $sum: { $ifNull: ['$detail.ethClaimed', 0] } } } },
    ])
    .toArray();

  return {
    ...(row || {
      cycles: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      total_eth_spent_buy: 0,
      total_tokens_bought: 0,
      total_eth_spent_burn: 0,
      total_tokens_burned: 0,
    }),
    total_eth_claimed: claimRow ? claimRow.eth : 0,
  };
}

async function addAirdrop({ cycleId, rewardToken, recipient, amountRaw, amountUi, signature, status }) {
  const db = getDb();
  const id = await nextId('airdrops');
  const doc = {
    id,
    cycle_id: cycleId,
    reward_token: rewardToken,
    recipient,
    amount_raw: String(amountRaw),
    amount_ui: amountUi ?? null,
    signature: signature ?? null,
    status: status ?? 'ok',
    created_at: new Date().toISOString(),
  };
  await db.collection('airdrops').insertOne(doc);
  bus.emit('airdrop', doc); // push to SSE clients
  return id;
}

async function getAirdrops(limit, offset, rewardToken = null) {
  const db = getDb();
  const filter = rewardToken ? { reward_token: rewardToken } : {};
  const total = await db.collection('airdrops').countDocuments(filter);
  const items = await db
    .collection('airdrops')
    .find(filter, NO_ID)
    .sort({ id: -1 })
    .skip(offset)
    .limit(limit)
    .toArray();
  return { total, items };
}

// Aggregate successful airdrop sends PER reward token: send count, total UI
// amount distributed, and distinct recipient wallets. Keyed by reward_token.
async function getAirdropTotals() {
  const db = getDb();
  const rows = await db
    .collection('airdrops')
    .aggregate([
      { $match: { status: 'ok' } },
      {
        $group: {
          _id: '$reward_token',
          sends: { $sum: 1 },
          totalUi: { $sum: { $ifNull: ['$amount_ui', 0] } },
          recipients: { $addToSet: '$recipient' },
        },
      },
      { $project: { _id: 1, sends: 1, totalUi: 1, holders: { $size: '$recipients' } } },
    ])
    .toArray();
  const byToken = {};
  for (const r of rows) byToken[r._id] = { sends: r.sends, totalUi: r.totalUi, holders: r.holders };
  return byToken;
}

// A real on-chain transaction hash. DRY_RUN records airdrops with status 'ok'
// and a fabricated `airdrop_ka9f2x` signature, so status alone cannot tell a
// simulated payout from a real one.
const REAL_TX_HASH = '^0x[0-9a-fA-F]{64}$';

/**
 * Totals for ONE reward token, counting only payouts that actually landed on
 * chain. Separate from getAirdropTotals because that one deliberately includes
 * simulated sends — the operator dashboard wants to see them while testing in
 * DRY_RUN. Anything public-facing must not: counting a simulated payout as
 * distributed supply inflates the headline number the site shows to visitors.
 * @returns {Promise<{totalUi:number, sends:number, holders:number}>}
 */
async function getDistributedTotal(rewardToken) {
  const db = getDb();
  const [row] = await db
    .collection('airdrops')
    .aggregate([
      { $match: { reward_token: rewardToken, status: 'ok', signature: { $regex: REAL_TX_HASH } } },
      {
        $group: {
          _id: null,
          sends: { $sum: 1 },
          totalUi: { $sum: { $ifNull: ['$amount_ui', 0] } },
          recipients: { $addToSet: '$recipient' },
        },
      },
      { $project: { _id: 0, sends: 1, totalUi: 1, holders: { $size: '$recipients' } } },
    ])
    .toArray();
  return row || { totalUi: 0, sends: 0, holders: 0 };
}

module.exports = {
  createCycle,
  finishCycle,
  addStep,
  getCycleWithSteps,
  getCycles,
  getLastCycle,
  getAllSteps,
  getStats,
  addAirdrop,
  getAirdrops,
  getAirdropTotals,
  getDistributedTotal,
  getHolderIndex,
  setHolderIndex,
};
