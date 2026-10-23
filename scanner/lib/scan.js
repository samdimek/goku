"use strict";

const { ethers } = require("ethers");
const { ROUTER_ABI, ENGINE_ABI, POOL_ABI } = require("./abi");
const { resolveTenderlyConfig, tenderlySimulate } = require("./tenderly");
const core = require("./core");

/**
 * Gas price for the profitability decision: max(what the chain reports,
 * the configured floor). The floor is the F1 fix — the decision must never
 * price gas below what the sender actually pays (a pinned gasPrice, or the
 * effective gas price of the transaction), or a net-negative trade passes
 * the gate. Set `gasPriceFloorWei` in config or GAS_PRICE_FLOOR_WEI in env.
 */
async function getGasPriceWei(provider, { floorWei = 0n } = {}) {
  let price = 0n;
  try {
    if (typeof provider.getFeeData === "function") {
      const fd = await provider.getFeeData();
      price = BigInt(fd.gasPrice ?? fd.maxFeePerGas ?? 0n);
    } else if (typeof provider.getGasPrice === "function") {
      price = BigInt(await provider.getGasPrice());
    } else if (typeof provider.send === "function") {
      price = BigInt(await provider.send("eth_gasPrice", []));
    }
  } catch {
    /* fall through: report 0, then let the floor decide */
  }
  return price > floorWei ? price : floorWei;
}

/** Parse a config/env wei amount strictly; a typo must never silently disable protection. */
function parseWei(value, name) {
  try {
    return BigInt(value);
  } catch {
    throw new Error(`${name} must be an integer wei string, got: ${JSON.stringify(value)}`);
  }
}

/** Query the pool's real premium (bps); fall back to Aave's 5 bps default. */
async function fetchPremiumBps(engine, provider, fallbackBps = 5) {
  try {
    const poolAddress = await engine.POOL();
    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
    return BigInt(await pool.FLASHLOAN_PREMIUM_TOTAL());
  } catch {
    return BigInt(fallbackBps);
  }
}

/**
 * Flash-loan premium for the configured engine type:
 *   "aave"    (default) -> read FLASHLOAN_PREMIUM_TOTAL from the pool
 *   "balancer"          -> 0 bps (Balancer V2's standing fee; override with
 *                          config.flashLoanFeeBps if governance ever sets one)
 * A wrong off-chain guess can only make the on-chain guard revert — the
 * engine prices the loan from the callback's feeAmounts, never from this.
 */
async function resolvePremiumBps(config, engine, provider) {
  const kind = String(config.flashLoanProvider ?? "aave").toLowerCase();
  if (kind === "aave") return fetchPremiumBps(engine, provider);
  if (kind === "balancer") {
    const override = config.flashLoanFeeBps;
    return override === undefined || override === null || override === ""
      ? 0n
      : BigInt(override);
  }
  throw new Error(
    `flashLoanProvider must be "aave" or "balancer", got: ${JSON.stringify(config.flashLoanProvider)}`
  );
}

/** Quote one leg through its router's getAmountsOut (view call). */
async function quoteLeg(provider, router, path, amountIn) {
  const contract = new ethers.Contract(router, ROUTER_ABI, provider);
  const amounts = await contract.getAmountsOut(amountIn, path);
  return amounts[amounts.length - 1];
}

/** Quote the full 2-leg cycle: returns { mid, outA, outB }. */
async function quoteRoute(provider, opp, amountIn) {
  const [leg0, leg1] = opp.legs;
  const outA = await quoteLeg(provider, leg0.router, leg0.path, amountIn);
  const outB = await quoteLeg(provider, leg1.router, leg1.path, outA);
  return { mid: outA, outA, outB };
}

/**
 * Run one scan cycle over all configured opportunities.
 *
 * Flow per opportunity:
 *   quote legs -> evaluate profit (incl. gas if asset wraps native)
 *   -> build route params -> estimate gas -> re-evaluate with gas cost
 *   -> engine.requestFlashLoan.staticCall (authoritative on-chain check)
 *   -> send (if send=true) or dry-run report.
 *
 * Never throws for a single bad opportunity: errors are reported per item.
 *
 * Before sending, three gates must all pass:
 *   1. worth-it gate (off-chain):  gross >= minProfit + gas at the price the
 *      sender will actually pay (max(feeData, gasPriceFloorWei))
 *   2. eth_call preflight:          engine.requestFlashLoan.staticCall with
 *      the exact send arguments (incl. the gas-inclusive on-chain minProfit)
 *   3. optional Tenderly dry-run:   same tx simulated off-chain again; if it
 *      reverts there, nothing is broadcast (configure `tenderly` block)
 * And sends can go through a private submission RPC (SUBMIT_RPC_URL /
 * config.submitRpcUrl -> resolve the signer in lib/submit), whose default
 * policy excludes reverting transactions, so a failed trade costs no gas.
 */
async function scanOnce({ provider, signer, engineAddress, strategyAddress, config, send = false, log = console.log, deps = {} }) {
  const engine = new ethers.Contract(engineAddress, ENGINE_ABI, signer ?? provider);

  const defaultAmountIn = BigInt(config.defaultAmountIn ?? "0");
  const defaultSlippage = Number(config.defaultSlippageBps ?? 50);
  const defaultMinProfit = BigInt(config.defaultMinProfitWei ?? "0");
  const deadlineSecs = Number(config.deadlineSecs ?? 120);
  const wrappedNative = (config.wrappedNativeAsset ?? ethers.ZeroAddress).toLowerCase();
  // F1 fix: never price gas below what the sender actually pays.
  // (An empty env var counts as unset — a bare `VAR=` in .env must not
  // silently disable the floor.)
  const envFloor = process.env.GAS_PRICE_FLOOR_WEI;
  const gasFloorWei = parseWei(
    (envFloor !== undefined && envFloor !== "" ? envFloor : config.gasPriceFloorWei) ?? "0",
    "gasPriceFloorWei"
  );
  // On-chain net guard: fold the gas budget into the minProfit the engine
  // enforces, so a trade that cannot cover its own gas reverts on-chain.
  const netProfitOnChain = config.netProfitOnChain !== false;

  const premiumBps = await resolvePremiumBps(config, engine, provider);
  const gasPriceWei = await getGasPriceWei(provider, { floorWei: gasFloorWei });

  // Tenderly gate runs only when configured (lazy: no extra RPC round-trip).
  const tenderlyCfg = resolveTenderlyConfig(config);
  let chainId = null;
  const getChainId = async () =>
    (chainId ??= (await provider.getNetwork()).chainId);

  const strategyOk = await engine.isStrategy(strategyAddress).catch(() => false);
  if (!strategyOk) log(`  ! strategy ${strategyAddress} is not registered on engine ${engineAddress}`);

  const results = [];

  for (const opp of config.opportunities ?? []) {
    const item = { id: opp.id ?? opp.legs?.[0]?.router, send, error: undefined };
    try {
      const cycle = core.validateCycle(opp);
      if (!cycle.ok) {
        item.error = cycle.errors.join("; ");
        item.profitable = false;
        item.reasons = cycle.errors;
        results.push(item);
        log(`  ${item.id}: invalid cycle -> ${item.error}`);
        continue;
      }

      const amountIn = BigInt(opp.amountIn ?? defaultAmountIn.toString());
      const slippageBps = Number(opp.slippageBps ?? defaultSlippage);
      const minProfitWei = BigInt(opp.minProfitWei ?? defaultMinProfit.toString());

      const { outA, outB } = await quoteRoute(provider, opp, amountIn);
      item.quoted = { outA: outA.toString(), outB: outB.toString(), amountIn: amountIn.toString() };

      // Phase 1: evaluate without gas to skip dead routes cheaply.
      const assetIsWrappedNative =
        String(opp.borrowAsset).toLowerCase() === wrappedNative;
      let evalr = core.evaluateOpportunity({
        amountIn,
        expectedOutA: outA,
        expectedOutB: outB,
        premiumBps,
        slippageBps,
        minProfitWei,
        gasCostWei: 0n,
      });
      if (!evalr.profitable) {
        item.profitable = false;
        item.reasons = evalr.reasons;
        item.eval = evalrSummary(evalr);
        results.push(item);
        log(`  ${item.id}: skip — ${evalr.reasons[0]}`);
        continue;
      }

      const strategyParams = core.buildParamsFromOpportunity(opp, evalr, deadlineSecs);

      // Phase 2: gas cost (only meaningful when we can compare wei to wei).
      let gasUnits = 0n;
      let gasCostWei = BigInt(opp.minGasCostWei ?? "0");
      try {
        gasUnits = await engine.requestFlashLoan.estimateGas(
          opp.borrowAsset, amountIn, strategyAddress, evalr.minProfit, strategyParams
        );
        if (assetIsWrappedNative) {
          // Correct on both L1 and Arbitrum: on Arbitrum One the node folds
          // the L1 data fee into eth_estimateGas (as extra L2 gas units),
          // so gasUnits * gasPrice is already the FULL fee — no separate
          // L1 line is needed (docs.arbitrum.io gas estimation).
          gasCostWei += gasUnits * BigInt(gasPriceWei.toString());
        }
      } catch (err) {
        item.error = `estimateGas failed: ${shortReason(err)}`;
        item.profitable = false;
        results.push(item);
        log(`  ${item.id}: skip — ${item.error}`);
        continue;
      }

      evalr = core.evaluateOpportunity({
        amountIn, expectedOutA: outA, expectedOutB: outB,
        premiumBps, slippageBps, minProfitWei, gasCostWei,
      });
      item.eval = evalrSummary(evalr);
      item.gasUnits = gasUnits.toString();
      item.gasPriceWei = gasPriceWei.toString();
      if (!evalr.profitable) {
        item.profitable = false;
        item.reasons = evalr.reasons;
        results.push(item);
        log(`  ${item.id}: skip — ${evalr.reasons[0]}`);
        continue;
      }

      // On-chain worth-it guard: the minProfit the ENGINE enforces includes
      // the gas budget, so if the trade can't cover its own gas the loan
      // reverts (Unprofitable) instead of landing net-negative.
      const onChainMinProfit =
        evalr.minProfit + (netProfitOnChain ? evalr.gasCostWei : 0n);
      item.onChainMinProfit = onChainMinProfit.toString();

      // Preflight gate 1 (eth_call): simulate the whole flash loan against
      // current state with the exact arguments we would send. Free, and a
      // revert here means "do not broadcast".
      try {
        await engine.requestFlashLoan.staticCall(
          opp.borrowAsset, amountIn, strategyAddress, onChainMinProfit, strategyParams
        );
        item.preflight = { ethCall: "ok" };
      } catch (err) {
        item.preflight = { ethCall: "revert", reason: shortReason(err) };
        item.error = `preflight eth_call reverted: ${shortReason(err)}`;
        item.profitable = false;
        results.push(item);
        log(`  ${item.id}: skip — ${item.error}`);
        continue;
      }

      item.profitable = true;
      if (!send) {
        item.dryRun = true;
        results.push(item);
        log(
          `  ${item.id}: OPPORTUNITY (dry-run) gross=${evalr.grossProfit} net=${evalr.netProfit} ` +
            `minOut[${evalr.minAmountOutA},${evalr.minAmountOutB}] gasUnits=${gasUnits} staticCall=OK`
        );
        continue;
      }

      if (!signer) throw new Error("send=true requires a signer");

      // Preflight gate 2 (optional, Tenderly): dry-run the exact transaction
      // off-chain once more. A revert here means "do not broadcast" — the
      // wallet never pays gas for a trade that would fail.
      if (tenderlyCfg.configured) {
        const from = await signer.getAddress();
        const data = engine.interface.encodeFunctionData("requestFlashLoan", [
          opp.borrowAsset, amountIn, strategyAddress, onChainMinProfit, strategyParams,
        ]);
        const sim = await tenderlySimulate({
          cfg: tenderlyCfg,
          tx: {
            networkId: await getChainId(),
            from,
            to: engineAddress,
            data,
            value: "0",
            gasLimit: (gasUnits * 12n) / 10n, // 20% headroom over the estimate
          },
          fetchImpl: deps.fetch,
        });
        item.tenderly = { ok: sim.ok, reason: sim.reason, gasUsed: sim.gasUsed };
        if (!sim.ok) {
          item.profitable = false;
          item.blockedBy = "tenderly";
          item.reasons = [`tenderly preflight: ${sim.reason}`];
          results.push(item);
          log(`  ${item.id}: skip — tenderly preflight: ${sim.reason}`);
          continue;
        }
      }

      const t0 = Date.now();
      const tx = await engine.requestFlashLoan(
        opp.borrowAsset, amountIn, strategyAddress, onChainMinProfit, strategyParams
      );
      item.txHash = tx.hash;
      const receipt = await tx.wait();
      item.blockNumber = receipt.blockNumber;
      item.status = receipt.status === 1 ? "confirmed" : "reverted";
      item.confirmMs = Date.now() - t0;
      // Actual cost, for analysis: what the network charged vs what we estimated.
      try {
        const gasUsed = BigInt(receipt.gasUsed ?? 0n);
        const effGasPrice = BigInt(receipt.gasPrice ?? gasPriceWei ?? 0n);
        item.gasUsed = gasUsed.toString();
        item.gasPriceUsed = effGasPrice.toString();
        item.gasCostWei = (gasUsed * effGasPrice).toString();
      } catch {
        /* gas accounting degrades gracefully */
      }
      results.push(item);
      log(
        `  ${item.id}: SENT ${tx.hash} (${item.status}) ` +
          `gasUsed=${item.gasUsed ?? "?"} confirmMs=${item.confirmMs}`
      );
    } catch (err) {
      item.error = shortReason(err);
      item.profitable = item.profitable ?? false;
      results.push(item);
      log(`  ${item.id}: error — ${item.error}`);
    }
  }

  return results;
}

function evalrSummary(e) {
  return {
    premium: e.premium.toString(),
    grossProfit: e.grossProfit.toString(),
    gasCostWei: e.gasCostWei.toString(),
    netProfit: e.netProfit.toString(),
    minProfit: e.minProfit.toString(),
    minAmountOutA: e.minAmountOutA.toString(),
    minAmountOutB: e.minAmountOutB.toString(),
  };
}

function shortReason(err) {
  const msg = err?.shortMessage ?? err?.reason ?? err?.message ?? String(err);
  return String(msg).split("\n")[0].slice(0, 300);
}

module.exports = { fetchPremiumBps, resolvePremiumBps, quoteLeg, quoteRoute, getGasPriceWei, parseWei, scanOnce };