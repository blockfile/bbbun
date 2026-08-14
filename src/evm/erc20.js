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
