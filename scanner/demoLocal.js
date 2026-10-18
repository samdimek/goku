"use strict";

/**
 * Offline end-to-end demo of the scanner against the local Hardhat network:
 *   mock Aave pool + venue A/B with a deliberate 1.2% price gap
 *   -> scanner quotes the cycle, prices premium from FLASHLOAN_PREMIUM_TOTAL,
 *      estimates gas, static-simulates the loan, then sends it.
 *
 * Run:  npx hardhat run scanner/demoLocal.js           (quotes + executes)
 *       DRY_RUN=true npx hardhat run scanner/demoLocal.js   (quote/simulate only)
 */
const hre = require("hardhat");
const { scanOnce } = require("./lib/scan");

async function main() {
  const E = (n) => hre.ethers.parseEther(String(n));
  const [deployer] = await hre.ethers.getSigners();

  // --- mock market ---------------------------------------------------------
  const pool = await (await hre.ethers.getContractFactory("MockPool")).deploy();
  const addrProvider = await (
    await hre.ethers.getContractFactory("MockPoolAddressesProvider")
  ).deploy(await pool.getAddress());

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const asset = await Token.deploy("Mock WETH", "mWETH", 18); // borrowed asset == wrapped native (gas-aware)
  const mid = await Token.deploy("Mock MID", "mMID", 18);

  const engine = await (
    await hre.ethers.getContractFactory("FlashLoan")
  ).deploy(await addrProvider.getAddress());
  const routeStrategy = await (
    await hre.ethers.getContractFactory("DexRouteArbStrategy")
  ).deploy(await engine.getAddress());
  await (await engine.registerStrategy(await routeStrategy.getAddress(), true)).wait();

  const Router = await hre.ethers.getContractFactory("MockRouter");
  const routerA = await Router.deploy();
  const routerB = await Router.deploy();
  await (await routeStrategy.setTrustedRouter(await routerA.getAddress(), true)).wait();
  await (await routeStrategy.setTrustedRouter(await routerB.getAddress(), true)).wait();

  // Liquidity on both venues + loan liquidity in the pool.
  await (await asset.mint(await pool.getAddress(), E(1000000))).wait();
  await (await mid.mint(await routerA.getAddress(), E(1000000))).wait();
  await (await asset.mint(await routerB.getAddress(), E(1000000))).wait();
  // The "opportunity": venue B pays 1.2% more of the asset than parity.
  await (await routerB.setBonusBps(120)).wait();

  // --- scanner config (what scanner/config.json would hold) ---------------
  const config = {
    deadlineSecs: 300,
    defaultSlippageBps: 50,
    defaultMinProfitWei: "0",
    wrappedNativeAsset: await asset.getAddress(),
    opportunities: [
      {
        id: "local-mWETH-mMID-A-vs-B",
        borrowAsset: await asset.getAddress(),
        amountIn: E(1000).toString(),
        minProfitWei: "0",
        slippageBps: 50,
        legs: [
          { router: await routerA.getAddress(), path: [await asset.getAddress(), await mid.getAddress()] },
          { router: await routerB.getAddress(), path: [await mid.getAddress(), await asset.getAddress()] },
        ],
      },
    ],
  };

  const engineAddress = await engine.getAddress();
  const strategyAddress = await routeStrategy.getAddress();
  const send = process.env.DRY_RUN !== "true";

  console.log("local market: engine      =", engineAddress);
  console.log("local market: strategy    =", strategyAddress);
  console.log("local market: venueA      =", await routerA.getAddress());
  console.log("local market: venueB      =", await routerB.getAddress(), "(+1.2% price gap)");
  console.log("mode:", send ? "SEND" : "dry-run", "\n");

  const results = await scanOnce({
    provider: hre.ethers.provider,
    signer: deployer,
    engineAddress,
    strategyAddress,
    config,
    send,
    log: console.log,
  });

  console.log("\nresults:", JSON.stringify(results, null, 2));

  if (send) {
    const profit = await engine.getBalance(await asset.getAddress());
    console.log("\nengine realized profit:", hre.ethers.formatEther(profit), "mWETH");
    if (profit <= 0n) throw new Error("demo made no profit — scanner flow is broken");
    const { expect } = require("chai");
    const expected = E(1000) * 120n / 10000n - (E(1000) * 5n) / 10000n; // 12 - 0.5
    expect(profit).to.equal(expected);
    console.log("verified: expected profit", hre.ethers.formatEther(expected), "mWETH ✓");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});