"use strict";

const { ethers } = require("ethers");
const { FULL_ENGINE_ABI } = require("./abi");

const DEFAULT_CHUNK = 5000; // log-range per eth_getLogs request

/**
 * Fetch engine events in block chunks (public RPCs cap log ranges).
 * Reverted trades emit nothing — a request that fails on-chain leaves no
 * events, which is correct: it never moved funds.
 */
async function fetchEvents({
  provider,
  engineAddress,
  fromBlock = 0,
  toBlock = "latest",
  chunkSize = DEFAULT_CHUNK,
}) {
  const engine = new ethers.Contract(engineAddress, FULL_ENGINE_ABI, provider);
  const end = toBlock === "latest" ? await provider.getBlockNumber() : Number(toBlock);
  const start = Math.max(0, Number(fromBlock));

  const out = { requested: [], executed: [], withdrawn: [] };
  for (let from = start; from <= end; from += chunkSize) {
    const to = Math.min(from + chunkSize - 1, end);
    const [requested, executed, withdrawn] = await Promise.all([
      engine.queryFilter(engine.filters.FlashLoanRequested(), from, to),
      engine.queryFilter(engine.filters.FlashLoanExecuted(), from, to),
      engine.queryFilter(engine.filters.Withdrawn(), from, to),
    ]);
    out.requested.push(...requested);
    out.executed.push(...executed);
    out.withdrawn.push(...withdrawn);
  }
  return { ...out, fromBlock: start, toBlock: end };
}

const emptyBucket = () => ({
  trades: 0n,
  borrowed: 0n,
  premium: 0n,
  grossProfit: 0n,
  withdrawn: 0n,
});

const bump = (map, canonicalKey, field, value) => {
  if (!map.has(canonicalKey)) map.set(canonicalKey, emptyBucket());
  const bucket = map.get(canonicalKey);
  bucket[field] += value;
};

/**
 * Aggregate raw events into the P&L view:
 *   per asset: borrowed, premium paid, gross profit, withdrawn, retained
 *   per strategy: trades, premium, gross profit
 * Keys are checksummed addresses; grouping is case-insensitive.
 */
function aggregate(events) {
  const byAssetLower = new Map();
  const byStrategyLower = new Map();
  const keyOf = new Map(); // lowercase -> checksummed for stable display

  for (const ev of events.executed) {
    const { asset, amount, premium, profit, strategy } = ev.args;
    bump(byAssetLower, asset.toLowerCase(), "trades", 1n);
    bump(byAssetLower, asset.toLowerCase(), "borrowed", amount);
    bump(byAssetLower, asset.toLowerCase(), "premium", premium);
    bump(byAssetLower, asset.toLowerCase(), "grossProfit", profit);
    keyOf.set(asset.toLowerCase(), ethers.getAddress(asset));

    bump(byStrategyLower, strategy.toLowerCase(), "trades", 1n);
    bump(byStrategyLower, strategy.toLowerCase(), "premium", premium);
    bump(byStrategyLower, strategy.toLowerCase(), "grossProfit", profit);
    keyOf.set(strategy.toLowerCase(), ethers.getAddress(strategy));
  }

  for (const ev of events.withdrawn) {
    const { token, amount } = ev.args;
    bump(byAssetLower, token.toLowerCase(), "withdrawn", amount);
    keyOf.set(token.toLowerCase(), ethers.getAddress(token));
  }

  const finalize = (lowerMap) => {
    const out = {};
    for (const [lower, bucket] of lowerMap) {
      out[keyOf.get(lower) ?? lower] = {
        trades: bucket.trades,
        borrowed: bucket.borrowed,
        premium: bucket.premium,
        grossProfit: bucket.grossProfit,
        withdrawn: bucket.withdrawn,
        // Net profit still sitting in the engine for this asset.
        retained: bucket.grossProfit - bucket.withdrawn,
      };
    }
    return out;
  };

  return {
    fromBlock: events.fromBlock,
    toBlock: events.toBlock,
    attempts: BigInt(events.requested.length),
    executedTrades: BigInt(events.executed.length),
    withdrawals: BigInt(events.withdrawn.length),
    byAsset: finalize(byAssetLower),
    byStrategy: finalize(byStrategyLower),
  };
}

/** Convenience: fetch + aggregate in one call. */
async function fetchPnl(opts) {
  return aggregate(await fetchEvents(opts));
}

function formatUnitsSafe(value, decimals) {
  try {
    return ethers.formatUnits(value, decimals);
  } catch {
    return value.toString();
  }
}

/**
 * Human-readable report. Amounts are token-native; decimals default to 18 and
 * can be overridden per asset: { "0xToken…": 6 }.
 */
function formatPnl(pnl, decimalsByAsset = {}) {
  const lines = [
    `P&L ledger  blocks ${pnl.fromBlock}..${pnl.toBlock}  ` +
      `trades=${pnl.executedTrades} withdrawals=${pnl.withdrawals}`,
  ];
  const entries = Object.entries(pnl.byAsset);
  if (entries.length === 0) lines.push("  (no completed trades in range)");
  for (const [asset, b] of entries) {
    const d = decimalsByAsset[asset] ?? decimalsByAsset[asset.toLowerCase()] ?? 18;
    lines.push(
      `  asset ${asset}: trades=${b.trades} borrowed=${formatUnitsSafe(b.borrowed, d)} ` +
        `premium=${formatUnitsSafe(b.premium, d)} profit=${formatUnitsSafe(b.grossProfit, d)} ` +
        `withdrawn=${formatUnitsSafe(b.withdrawn, d)} retained=${formatUnitsSafe(b.retained, d)}`
    );
  }
  for (const [strategy, b] of Object.entries(pnl.byStrategy)) {
    lines.push(
      `  strategy ${strategy}: trades=${b.trades} profit=${b.grossProfit.toString()} wei`
    );
  }
  return lines.join("\n");
}

module.exports = { DEFAULT_CHUNK, fetchEvents, aggregate, fetchPnl, formatPnl };