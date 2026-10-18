"use strict";

/** V2-compatible router surface (also implemented by MockRouter locally). */
const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
];

/** The flash-loan engine the scanner drives. */
const ENGINE_ABI = [
  "function requestFlashLoan(address asset, uint256 amount, address strategy, uint256 minProfit, bytes strategyParams)",
  "function getBalance(address tokenAddress) view returns (uint256)",
  "function POOL() view returns (address)",
  "function isStrategy(address strategy) view returns (bool)",
  "function minProfitFloor() view returns (uint256)",
];

/** Aave V3 Pool: flash-loan premium is a governance-set figure in basis points. */
const POOL_ABI = [
  "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)",
];

/**
 * Ledger events — exact mirrors of the engine's Solidity events, needed so
 * `queryFilter` can decode logs (plain calls never touch them).
 */
const ENGINE_EVENTS = [
  "event FlashLoanRequested(address indexed asset, uint256 amount, address indexed strategy, uint256 minProfit)",
  "event FlashLoanExecuted(address indexed asset, uint256 amount, uint256 premium, uint256 profit, address indexed strategy)",
  "event Withdrawn(address indexed token, address indexed to, uint256 amount)",
];

/** Engine ABI = callable surface + events (for logs and calls alike). */
const FULL_ENGINE_ABI = [...ENGINE_ABI, ...ENGINE_EVENTS];

module.exports = { ROUTER_ABI, ENGINE_ABI, ENGINE_EVENTS, FULL_ENGINE_ABI, POOL_ABI };