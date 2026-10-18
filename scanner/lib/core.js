"use strict";

const { ethers } = require("ethers");

/**
 * Must match `abi.decode(params, (RouteParams))` in DexRouteArbStrategy:
 * a SINGLE dynamic tuple (offset-prefixed), not a bare field sequence.
 */
const ROUTE_TUPLE_TYPE =
  "tuple(address,address[],address,address[],uint256,uint256,uint256)";

const BPS = 10000n;

/**
 * A 2-leg closed arbitrage cycle:
 *   leg 0: borrowAsset -> ... -> mid
 *   leg 1: mid          -> ... -> borrowAsset
 * Rejects open cycles, wrong start/end assets, and wrong leg counts.
 */
function validateCycle(opp) {
  const errors = [];
  const legs = opp.legs || [];
  if (legs.length !== 2) {
    errors.push("opportunity must have exactly 2 legs");
    return { ok: false, errors };
  }
  const asset = String(opp.borrowAsset).toLowerCase();
  const [a, b] = legs;
  if (!a.path || a.path.length < 2) errors.push("leg 0 path needs >= 2 tokens");
  if (!b.path || b.path.length < 2) errors.push("leg 1 path needs >= 2 tokens");
  if (errors.length) return { ok: false, errors };

  if (String(a.path[0]).toLowerCase() !== asset) errors.push("leg 0 must start in borrowAsset");
  if (String(b.path[b.path.length - 1]).toLowerCase() !== asset)
    errors.push("leg 1 must end in borrowAsset");
  if (String(a.path[a.path.length - 1]).toLowerCase() !== String(b.path[0]).toLowerCase())
    errors.push("cycle is not closed: leg 0 output != leg 1 input");
  if (!a.router || !b.router) errors.push("each leg needs a router address");
  return { ok: errors.length === 0, errors };
}

/** Floor-divide a quote by (1 - slippageBps), for minAmountOut pins. */
function applySlippage(amountOut, slippageBps) {
  if (slippageBps < 0 || slippageBps >= 10000) throw new Error("slippageBps out of range");
  return (amountIn_ => amountIn_)((amountOut * (BPS - BigInt(slippageBps))) / BPS);
}

/** Aave flash-loan fee in wei: amount * premiumBps / 10000. */
function computePremium(amountIn, premiumBps) {
  return (BigInt(amountIn) * BigInt(premiumBps)) / BPS;
}

/**
 * Decide whether a quoted cycle is worth firing.
 *
 * on-chain guard (engine):  out >= amountIn + premium + minProfit
 * off-chain extra (scanner): net of gas when the borrowed asset wraps native ETH
 *
 * @returns evaluation with quote-derived quantities and a `profitable` flag.
 */
function evaluateOpportunity({
  amountIn,
  expectedOutA,
  expectedOutB,
  premiumBps,
  slippageBps,
  minProfitWei = 0n,
  gasCostWei = 0n,
}) {
  amountIn = BigInt(amountIn);
  expectedOutA = BigInt(expectedOutA);
  expectedOutB = BigInt(expectedOutB);
  minProfitWei = BigInt(minProfitWei);
  gasCostWei = BigInt(gasCostWei);

  const premium = computePremium(amountIn, premiumBps);
  const grossProfit = expectedOutB - amountIn - premium;
  const netProfit = grossProfit - gasCostWei;
  const minAmountOutA = applySlippage(expectedOutA, slippageBps);
  const minAmountOutB = applySlippage(expectedOutB, slippageBps);

  // Required surplus over amount+premium: configured floor plus gas budget.
  const required = minProfitWei + gasCostWei;
  const profitable = grossProfit >= required;

  const reasons = [];
  if (!profitable) {
    reasons.push(
      `grossProfit ${grossProfit} < required ${required} ` +
        `(expectedOut ${expectedOutB} - in ${amountIn} - premium ${premium}` +
        (gasCostWei > 0n ? ` - gas ${gasCostWei}` : "") +
        `)`
    );
    if (grossProfit < 0n) reasons.push("route loses money even before gas");
  }

  return {
    premium,
    grossProfit,
    gasCostWei,
    netProfit,
    minAmountOutA,
    minAmountOutB,
    minProfit: minProfitWei,
    required,
    profitable,
    reasons,
  };
}

/**
 * Encode `strategyParams` exactly as DexRouteArbStrategy decodes them.
 * (Same shape as abi.encode(routeStruct) in Solidity.)
 */
function buildRouteParams({
  routerA,
  pathA,
  routerB,
  pathB,
  minAmountOutA,
  minAmountOutB,
  deadline,
}) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    [ROUTE_TUPLE_TYPE],
    [
      [
        ethers.getAddress(routerA),
        pathA.map((p) => ethers.getAddress(p)),
        ethers.getAddress(routerB),
        pathB.map((p) => ethers.getAddress(p)),
        BigInt(minAmountOutA),
        BigInt(minAmountOutB),
        BigInt(deadline),
      ],
    ]
  );
}

/** Build strategyParams straight from a configured opportunity + evaluation. */
function buildParamsFromOpportunity(opp, evalr, deadlineSecs = 120) {
  const [leg0, leg1] = opp.legs;
  return buildRouteParams({
    routerA: leg0.router,
    pathA: leg0.path,
    routerB: leg1.router,
    pathB: leg1.path,
    minAmountOutA: evalr.minAmountOutA,
    minAmountOutB: evalr.minAmountOutB,
    deadline: Math.floor(Date.now() / 1000) + deadlineSecs,
  });
}

module.exports = {
  BPS,
  ROUTE_TUPLE_TYPE,
  validateCycle,
  applySlippage,
  computePremium,
  evaluateOpportunity,
  buildRouteParams,
  buildParamsFromOpportunity,
};