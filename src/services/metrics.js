'use strict';

// "Unclaimed" here means everything a cycle could collect: the escrow balance
// plus fees still pending on the curve or hook.

const { getClaimableEth } = require('../jobs/scheduler');

async function getUnclaimedEth() {
  return { eth: await getClaimableEth(), at: Date.now() };
}

module.exports = { getUnclaimedEth };
