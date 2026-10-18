"use strict";

const { ethers } = require("ethers");
const { ROUTER_ABI, ENGINE_ABI, POOL_ABI } = require("./abi");
const core = require("./core");

/** Gas price portably: works on JsonRpcProvider and Hardhat's provider wrapper. */
async function getGasPriceWei(provider) {
  try {
    if (typeof provider.getFeeData === "function") {
      const fd = await provider.getFeeData();
      return BigInt(fd.gasPrice ?? fd.maxFeePerGas ?? 0n);
    }
    if (typeof provider.getGasPrice === "function") {
      return BigInt(await provider.getGasPrice());
    }
    if (typeof provider.send === "function") {
      return BigInt(await provider.send("eth_gasPrice", []));
    }
  } catch {
    /* fall through: gas accounting degrades gracefully to 0 */
  }
  return 0n;
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
 */
async function scanOnce({ provider, signer, engineAddress, strategyAddress, config, send = false, log = console.log }) {
  const engine = new ethers.Contract(engineAddress, ENGINE_ABI, signer ?? provider);

  const defaultAmountIn = BigInt(config.defaultAmountIn ?? "0");
  const defaultSlippage = Number(config.defaultSlippageBps ?? 50);
  const defaultMinProfit = BigInt(config.defaultMinProfitWei ?? "0");
  const deadlineSecs = Number(config.deadlineSecs ?? 120);
  const wrappedNative = (config.wrappedNativeAsset ?? ethers.ZeroAddress).toLowerCase();

  const premiumBps = await fetchPremiumBps(engine, provider);
  const feeDataGasPrice = await getGasPriceWei(provider);
  const gasPriceWei = feeDataGasPrice;

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
      if (!evalr.profitable) {
        item.profitable = false;
        item.reasons = evalr.reasons;
        results.push(item);
        log(`  ${item.id}: skip — ${evalr.reasons[0]}`);
        continue;
      }

      // Authoritative check: simulate the whole flash loan against current state.
      await engine.requestFlashLoan.staticCall(
        opp.borrowAsset, amountIn, strategyAddress, evalr.minProfit, strategyParams
      );

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
      const tx = await engine.requestFlashLoan(
        opp.borrowAsset, amountIn, strategyAddress, evalr.minProfit, strategyParams
      );
      item.txHash = tx.hash;
      const receipt = await tx.wait();
      item.blockNumber = receipt.blockNumber;
      item.status = receipt.status === 1 ? "confirmed" : "reverted";
      results.push(item);
      log(`  ${item.id}: SENT ${tx.hash} (${item.status})`);
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

module.exports = { fetchPremiumBps, quoteLeg, quoteRoute, getGasPriceWei, scanOnce };