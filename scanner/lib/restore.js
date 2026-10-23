"use strict";

/**
 * Gap-restoration solver for the campaign loop.
 *
 * An arbitrage trade converges the two venues it trades between: after the
 * swap, both pools price the mid token at roughly the same rate and the
 * opportunity is gone. This module computes the swap that moves ONE pool
 * back to its target price (constant-product math, pure functions — no RPC),
 * so run.js can re-create the deliberate gap and fire the next trade.
 *
 * Pool mechanics (V2): the pool GROWS its reserve of the token you spend
 * (amountIn) and SHRINKS the reserve of the token it pays you out.
 *   reserveIn'  = reserveIn + amountIn
 *   reserveOut' = reserveOut − amountOut(amountIn)
 * so spending the ASSET side lowers the mid-per-asset price and spending the
 * MID side raises it.
 *
 * Price convention: `targetMidPerAsset` = how many MID tokens one unit of
 * the wrapped-native asset (WETH) buys on that venue (e.g. 1000).
 * Pool price  = reserveMid / reserveAsset.
 *
 * Naming is venue-generic: "asset" = the borrowed/wrapped-native side,
 * "mid" = the intermediate ERC-20.
 */

const BPS = 10000n;

/** V2 amountOut with an LP fee (feeBps, 30 = 0.3%), BigInt-exact. */
function amountOutFor(amountIn, reserveIn, reserveOut, feeBps = 30) {
  const amount = BigInt(amountIn);
  if (amount <= 0n) return 0n;
  const inWithFee = (amount * (BPS - BigInt(feeBps))) / BPS;
  return (inWithFee * BigInt(reserveOut)) / (BigInt(reserveIn) + inWithFee);
}

/**
 * Solve for the input amount whose execution moves the pool to the target
 * ratio `targetNum/targetDen`, where the ratio is reserveOut'/reserveIn'
 * AFTER the swap. reserveIn is the pool's reserve of the token we SPEND
 * (it grows), reserveOut the token we RECEIVE (it shrinks), so the ratio
 * decreases monotonically from rOut/rIn (x=0) toward 0 — plain bisection on
 * wei finds the minimal input reaching it.
 *
 * Returns:
 *   null                             — current ratio already at/below target
 *   { amountIn, amountOut, reachable:true }   — minimal input hitting target
 *   { amountIn, amountOut, reachable:false }  — target needs more than
 *                                      maxInBps of reserveIn; capped at that
 *                                      budget (best effort, caller decides).
 */
function solveSwapForTargetRatio({
  reserveIn,
  reserveOut,
  targetNum,
  targetDen,
  feeBps = 30,
  maxInBps = 5000n,
}) {
  const rIn = BigInt(reserveIn);
  const rOut = BigInt(reserveOut);
  const num = BigInt(targetNum);
  const den = BigInt(targetDen);
  const maxIn = (rIn * BigInt(maxInBps)) / BPS;

  // f(x) = (rOut − out(x))*den − num*(rIn + x): positive until the target
  // is reached, strictly decreasing in x.
  const f = (x) => {
    const out = amountOutFor(x, rIn, rOut, feeBps);
    return (rOut - out) * den - num * (rIn + x);
  };

  if (f(0n) <= 0n) return null; // already at (or past) the target
  if (maxIn <= 0n) return null;
  if (f(maxIn) > 0n) {
    return { amountIn: maxIn, amountOut: amountOutFor(maxIn, rIn, rOut, feeBps), reachable: false };
  }

  let lo = 0n;
  let hi = maxIn;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (f(mid) > 0n) lo = mid;
    else hi = mid;
  }
  return { amountIn: hi, amountOut: amountOutFor(hi, rIn, rOut, feeBps), reachable: true };
}

/**
 * Plan the restore swap for one venue.
 *
 *   reserveAsset / reserveMid  — current V2 reserves (BigInt wei)
 *   targetMidPerAsset          — venue's target price (mid per asset)
 *   toleranceBps               — skip when already within this drift of target
 *   maxInBps                   — budget: never spend more than this share of
 *                                the SPENT side's pool reserve (default 50%)
 *
 * Returns null (nothing to do) or:
 *   {
 *     direction: "mid->asset" | "asset->mid",   // raise price / lower price
 *     amountIn, amountOut,                      // swap to execute (BigInt wei)
 *     reachable,                                // target met within budget?
 *     priceBefore, priceAfter,                  // mid per asset (float, logs)
 *     driftBps, targetMidPerAsset
 *   }
 */
function planRestore({
  reserveAsset,
  reserveMid,
  targetMidPerAsset,
  feeBps = 30,
  toleranceBps = 50n,
  maxInBps = 5000n,
}) {
  const rA = BigInt(reserveAsset);
  const rM = BigInt(reserveMid);
  const T = BigInt(targetMidPerAsset);
  if (rA <= 0n || rM <= 0n || T <= 0n) return null;

  const priceBefore = Number(rM) / Number(rA);
  const targetMidReserve = T * rA; // mid reserve the pool should hold at target
  const diff = rM > targetMidReserve ? rM - targetMidReserve : targetMidReserve - rM;
  const driftBps = (diff * BPS) / targetMidReserve;
  if (driftBps < BigInt(toleranceBps)) return null; // close enough — no swap

  let sol;
  let direction;
  let rM2;
  let rA2;

  if (rM > targetMidReserve) {
    // price too high (mid too plentiful): BUY mid with asset (asset->mid) —
    // the pool's asset reserve grows and its mid reserve shrinks, so the
    // price rMid/rAsset FALLS to the target T (mid/asset = T).
    sol = solveSwapForTargetRatio({
      reserveIn: rA,
      reserveOut: rM,
      targetNum: T,
      targetDen: 1n,
      feeBps,
      maxInBps,
    });
    direction = "asset->mid";
    if (!sol) return null;
    rA2 = rA + sol.amountIn;
    rM2 = rM - sol.amountOut;
  } else {
    // price too low: SELL mid for asset (mid->asset) — the pool's mid
    // reserve grows and its asset reserve shrinks, so the price rMid/rAsset
    // RISES to the target T (equivalently asset/mid = 1/T).
    sol = solveSwapForTargetRatio({
      reserveIn: rM,
      reserveOut: rA,
      targetNum: 1n,
      targetDen: T,
      feeBps,
      maxInBps,
    });
    direction = "mid->asset";
    if (!sol) return null;
    rM2 = rM + sol.amountIn;
    rA2 = rA - sol.amountOut;
  }

  return {
    direction,
    amountIn: sol.amountIn,
    amountOut: sol.amountOut,
    reachable: sol.reachable,
    priceBefore,
    priceAfter: Number(rM2) / Number(rA2),
    driftBps: Number(driftBps),
    targetMidPerAsset: Number(T),
  };
}

module.exports = { BPS, amountOutFor, solveSwapForTargetRatio, planRestore };
