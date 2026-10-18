const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { baseFixture } = require("./FlashLoan");
const core = require("../scanner/lib/core");
const { scanOnce, fetchPremiumBps, quoteRoute } = require("../scanner/lib/scan");

const E = (n) => ethers.parseEther(String(n));

describe("scanner/core (pure logic)", function () {
  const asset = "0x000000000000000000000000000000000000000A";
  const midT = "0x000000000000000000000000000000000000000B";
  const other = "0x000000000000000000000000000000000000000C";

  const goodOpp = {
    borrowAsset: asset,
    legs: [
      { router: "0x0000000000000000000000000000000000000101", path: [asset, midT] },
      { router: "0x0000000000000000000000000000000000000102", path: [midT, asset] },
    ],
  };

  it("accepts a closed 2-leg cycle", function () {
    const v = core.validateCycle(goodOpp);
    expect(v.ok, v.errors.join("; ")).to.equal(true);
  });

  it("rejects an open cycle (leg output != next leg input)", function () {
    const v = core.validateCycle({
      borrowAsset: asset,
      legs: [
        { router: "0x0000000000000000000000000000000000000101", path: [asset, midT] },
        { router: "0x0000000000000000000000000000000000000102", path: [other, asset] },
      ],
    });
    expect(v.ok).to.equal(false);
    expect(v.errors.join(" ")).to.match(/not closed/);
  });

  it("rejects a cycle that does not start/end in the borrowed asset", function () {
    const v = core.validateCycle({
      borrowAsset: asset,
      legs: [
        { router: "0x0000000000000000000000000000000000000101", path: [midT, asset] },
        { router: "0x0000000000000000000000000000000000000102", path: [asset, midT] },
      ],
    });
    expect(v.ok).to.equal(false);
  });

  it("rejects anything that is not exactly 2 legs", function () {
    expect(core.validateCycle({ borrowAsset: asset, legs: [] }).ok).to.equal(false);
    expect(
      core.validateCycle({
        borrowAsset: asset,
        legs: [
          { router: goodOpp.legs[0].router, path: [asset, midT] },
          { router: goodOpp.legs[1].router, path: [midT, other] },
          { router: goodOpp.legs[0].router, path: [other, asset] },
        ],
      }).ok
    ).to.equal(false);
  });

  it("applies slippage as a floor division", function () {
    // 1000 out with 50 bps tolerance -> minAmountOut 995
    expect(core.applySlippage(E(1000), 50)).to.equal(E(995));
    expect(core.applySlippage(E(1000), 0)).to.equal(E(1000));
    expect(() => core.applySlippage(E(1000), 10000)).to.throw();
  });

  it("prices the Aave premium in bps", function () {
    expect(core.computePremium(E(1000), 5)).to.equal(E("0.5"));
    expect(core.computePremium(E(1000), 9)).to.equal(E("0.9"));
  });

  it("flags profitable cycles and computes minAmountOut pins", function () {
    const r = core.evaluateOpportunity({
      amountIn: E(1000),
      expectedOutA: E(1000),
      expectedOutB: E(1020),
      premiumBps: 5n,
      slippageBps: 50,
      minProfitWei: E(1),
    });
    expect(r.profitable).to.equal(true);
    expect(r.premium).to.equal(E("0.5"));
    expect(r.grossProfit).to.equal(E("19.5"));
    expect(r.minAmountOutA).to.equal(E(995));
    expect(r.minAmountOutB).to.equal(E("1014.9"));
  });

  it("flags unprofitable cycles with reasons", function () {
    const r = core.evaluateOpportunity({
      amountIn: E(1000),
      expectedOutA: E(1000),
      expectedOutB: E(1000), // parity only: premium not covered
      premiumBps: 5n,
      slippageBps: 50,
      minProfitWei: 0,
    });
    expect(r.profitable).to.equal(false);
    expect(r.reasons.length).to.be.greaterThan(0);
  });

  it("subtracts gas from the decision when the asset wraps native ETH", function () {
    const base = {
      amountIn: E(1000),
      expectedOutA: E(1000),
      expectedOutB: E(1001),
      premiumBps: 5n,
      slippageBps: 50,
      minProfitWei: 0,
    };
    // gross = 0.5 ether; with no gas -> profitable, with 1 ether gas -> not
    expect(core.evaluateOpportunity({ ...base, gasCostWei: 0n }).profitable).to.equal(true);
    expect(core.evaluateOpportunity({ ...base, gasCostWei: E(1) }).profitable).to.equal(false);
  });

  it("encodes route params exactly as DexRouteArbStrategy decodes them", function () {
    const encoded = core.buildRouteParams({
      routerA: goodOpp.legs[0].router,
      pathA: goodOpp.legs[0].path,
      routerB: goodOpp.legs[1].router,
      pathB: goodOpp.legs[1].path,
      minAmountOutA: "995",
      minAmountOutB: "1014",
      deadline: 1234567890,
    });
    const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode(
      [core.ROUTE_TUPLE_TYPE],
      encoded
    );
    expect(decoded[0]).to.equal(ethers.getAddress(goodOpp.legs[0].router));
    expect(decoded[1][0]).to.equal(ethers.getAddress(asset));
    expect(decoded[3][1]).to.equal(ethers.getAddress(asset));
    expect(decoded[4]).to.equal(995n);
    expect(decoded[5]).to.equal(1014n);
    expect(decoded[6]).to.equal(1234567890n);
  });
});

describe("scanner end-to-end (local mock market)", function () {
  async function marketFixture() {
    const base = await baseFixture();
    const { asset, tokenB, engine, routeStrategy, routerA, routerB, pool } = base;

    await routeStrategy.setTrustedRouter(await routerA.getAddress(), true);
    await routeStrategy.setTrustedRouter(await routerB.getAddress(), true);

    await tokenB.mint(await routerA.getAddress(), E(1000000));
    await asset.mint(await routerB.getAddress(), E(1000000));
    await routerB.setBonusBps(120); // venue B pays 1.2% more -> the opportunity

    const config = {
      deadlineSecs: 300,
      defaultSlippageBps: 50,
      defaultMinProfitWei: "0",
      wrappedNativeAsset: await asset.getAddress(),
      opportunities: [
        {
          id: "local-asset-mid-A-vs-B",
          borrowAsset: await asset.getAddress(),
          amountIn: E(1000).toString(),
          minProfitWei: "0",
          slippageBps: 50,
          legs: [
            { router: await routerA.getAddress(), path: [await asset.getAddress(), await tokenB.getAddress()] },
            { router: await routerB.getAddress(), path: [await tokenB.getAddress(), await asset.getAddress()] },
          ],
        },
      ],
    };

    return {
      ...base,
      // NOTE: overrides base's `provider`, which is the MockPoolAddressesProvider
      // *contract*; the scanner needs an RPC provider to quote against.
      provider: ethers.provider,
      config,
      engineAddress: await engine.getAddress(),
      strategyAddress: await routeStrategy.getAddress(),
      assetAddr: await asset.getAddress(),
      signer: base.deployer,
      pool,
    };
  }

  // Reused by test/ops.js (ledger + alert tests run against this market).
  module.exports = { marketFixture };

  it("reads the pool premium from FLASHLOAN_PREMIUM_TOTAL", async function () {
    const { engine, provider } = await loadFixture(marketFixture);
    const bps = await fetchPremiumBps(engine, provider);
    expect(bps).to.equal(5n);
  });

  it("quotes a profitable cycle through router getAmountsOut", async function () {
    const { config, provider } = await loadFixture(marketFixture);
    const opp = config.opportunities[0];
    const { outA, outB } = await quoteRoute(provider, opp, E(1000));
    expect(outA).to.equal(E(1000)); // venue A at parity
    expect(outB).to.equal(E(1012)); // venue B +1.2%
  });

  it("dry-run: simulates via staticCall, sends nothing", async function () {
    const { config, engineAddress, strategyAddress, provider, signer, assetAddr } =
      await loadFixture(marketFixture);

    const results = await scanOnce({
      provider, signer, engineAddress, strategyAddress, config, send: false, log: () => {},
    });

    expect(results).to.have.lengthOf(1);
    expect(results[0].error).to.equal(undefined);
    expect(results[0].profitable).to.equal(true);
    expect(results[0].dryRun).to.equal(true);
    expect(results[0].txHash).to.equal(undefined);

    const engine = await ethers.getContractAt("FlashLoan", engineAddress);
    expect(await engine.getBalance(assetAddr)).to.equal(0);
  });

  it("send mode: quotes, confirms and books the exact profit", async function () {
    const { config, engineAddress, strategyAddress, provider, signer, assetAddr } =
      await loadFixture(marketFixture);

    const results = await scanOnce({
      provider, signer, engineAddress, strategyAddress, config, send: true, log: () => {},
    });

    expect(results[0].profitable).to.equal(true);
    expect(results[0].status).to.equal("confirmed");
    expect(results[0].txHash).to.be.a("string");

    // out 1012 - principal 1000 - premium 0.5 => 11.5
    const engine = await ethers.getContractAt("FlashLoan", engineAddress);
    expect(await engine.getBalance(assetAddr)).to.equal(E("11.5"));
  });

  it("skips unprofitable cycles without sending", async function () {
    const { config, engineAddress, strategyAddress, provider, signer, routerB } =
      await loadFixture(marketFixture);

    await routerB.setBonusBps(0); // opportunity disappears: parity everywhere

    const results = await scanOnce({
      provider, signer, engineAddress, strategyAddress, config, send: true, log: () => {},
    });

    expect(results[0].profitable).to.equal(false);
    expect(results[0].txHash).to.equal(undefined);
    expect(results[0].reasons.join(" ")).to.match(/grossProfit/);
  });

  it("reports invalid cycles instead of throwing", async function () {
    const { config, engineAddress, strategyAddress, provider, signer } =
      await loadFixture(marketFixture);

    const bad = JSON.parse(JSON.stringify(config));
    bad.opportunities[0].legs[1].path[1] = await ethers.Wallet.createRandom().getAddress();

    const results = await scanOnce({
      provider, signer, engineAddress, strategyAddress, config: bad, send: false, log: () => {},
    });
    expect(results[0].error).to.match(/must end in borrowAsset|not closed/);
    expect(results[0].profitable).to.equal(false);
  });
});