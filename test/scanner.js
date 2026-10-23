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

    // Receipt facts recorded for post-run analysis (actual, not estimated).
    expect(results[0].blockNumber).to.be.a("number");
    expect(Number(results[0].gasUsed)).to.be.greaterThan(21000);
    expect(BigInt(results[0].gasCostWei)).to.equal(
      BigInt(results[0].gasUsed) * BigInt(results[0].gasPriceUsed)
    );
    expect(results[0].confirmMs).to.be.a("number");

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

  // --- profit-safety: never broadcast a trade that would lose money -----

  it("F1 regression: prices gas at max(feeData, gasPriceFloorWei) and refuses net-negative trades", async function () {
    const { config, engineAddress, strategyAddress, provider, signer, assetAddr } =
      await loadFixture(marketFixture);

    // 1,000,000 gwei floor: gasUnits (~400k) x floor = ~400 ETH, far above
    // the 11.5 ETH gross profit of this mock trade -> the gate must refuse,
    // and nothing may be broadcast. (Per-test config copy: loadFixture
    // returns one shared object across tests.)
    const cfg = { ...config, gasPriceFloorWei: (10n ** 15n).toString() };

    const results = await scanOnce({
      provider, signer, engineAddress, strategyAddress, config: cfg, send: true, log: () => {},
    });

    expect(results[0].profitable).to.equal(false);
    expect(results[0].txHash).to.equal(undefined);
    expect(results[0].reasons.join(" ")).to.match(/grossProfit/);
    // the decision priced gas at the floor, not at whatever feeData claimed
    expect(BigInt(results[0].gasPriceWei)).to.equal(10n ** 15n);

    const engine = await ethers.getContractAt("FlashLoan", engineAddress);
    expect(await engine.getBalance(assetAddr)).to.equal(0); // nothing executed
  });

  it("net-profit guard: the on-chain minProfit includes the gas budget", async function () {
    const { config, engineAddress, strategyAddress, provider, signer } =
      await loadFixture(marketFixture);

    // 1 gwei: keeps the trade profitable, but gas > 0 for sure
    const cfg = { ...config, gasPriceFloorWei: "1000000000" };
    const results = await scanOnce({
      provider, signer, engineAddress, strategyAddress, config: cfg, send: true, log: () => {},
    });

    const r = results[0];
    expect(r.profitable).to.equal(true);
    expect(r.status).to.equal("confirmed");
    expect(BigInt(r.eval.gasCostWei)).to.be.greaterThan(0n);
    // minProfit floor + gas budget: the ENGINE would revert a trade that
    // cannot cover its own gas, even if the off-chain gate were bypassed.
    expect(BigInt(r.onChainMinProfit)).to.equal(
      BigInt(r.eval.minProfit) + BigInt(r.eval.gasCostWei)
    );
  });

  it("net-profit guard can be disabled (on-chain minProfit stays at the floor)", async function () {
    const { config, engineAddress, strategyAddress, provider, signer } =
      await loadFixture(marketFixture);

    const cfg = { ...config, gasPriceFloorWei: "1000000000", netProfitOnChain: false };
    const results = await scanOnce({
      provider, signer, engineAddress, strategyAddress, config: cfg, send: true, log: () => {},
    });

    expect(results[0].profitable).to.equal(true);
    expect(BigInt(results[0].eval.gasCostWei)).to.be.greaterThan(0n); // gas was priced...
    expect(BigInt(results[0].onChainMinProfit)).to.equal(
      BigInt(results[0].eval.minProfit)
    ); // ...but not enforced on-chain
  });

  it("Tenderly preflight: a simulated revert blocks the send (fail-closed)", async function () {
    const { config, engineAddress, strategyAddress, provider, signer, assetAddr } =
      await loadFixture(marketFixture);

    const cfg = {
      ...config,
      tenderly: { accessToken: "t", accountSlug: "acc", projectSlug: "proj" },
    };
    let calls = 0;
    const fetchStub = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          simulation: { status: false, error: "execution reverted: Unprofitable" },
        }),
      };
    };

    const results = await scanOnce({
      provider, signer, engineAddress, strategyAddress, config: cfg, send: true, log: () => {},
      deps: { fetch: fetchStub },
    });

    expect(calls).to.equal(1); // the gate ran
    expect(results[0].profitable).to.equal(false);
    expect(results[0].blockedBy).to.equal("tenderly");
    expect(results[0].txHash).to.equal(undefined);
    expect(results[0].tenderly.ok).to.equal(false);
    expect(results[0].tenderly.reason).to.match(/Unprofitable/);

    const engine = await ethers.getContractAt("FlashLoan", engineAddress);
    expect(await engine.getBalance(assetAddr)).to.equal(0); // nothing executed
  });

  it("Tenderly preflight: a passing simulation lets the send proceed", async function () {
    const { config, engineAddress, strategyAddress, provider, signer, assetAddr } =
      await loadFixture(marketFixture);

    const cfg = {
      ...config,
      tenderly: { accessToken: "t", accountSlug: "acc", projectSlug: "proj" },
    };
    let req = null;
    const fetchStub = async (url, init) => {
      req = { url, init };
      return {
        ok: true,
        status: 200,
        json: async () => ({ simulation: { status: true, gas_used: 350000 } }),
      };
    };

    const results = await scanOnce({
      provider, signer, engineAddress, strategyAddress, config: cfg, send: true, log: () => {},
      deps: { fetch: fetchStub },
    });

    expect(results[0].status).to.equal("confirmed");
    expect(results[0].tenderly.ok).to.equal(true);
    expect(results[0].tenderly.gasUsed).to.equal("350000");

    // the request was the real dry-run call: right endpoint, auth header,
    // never persisted, calldata = requestFlashLoan(engine, strategy, ...)
    expect(req.url).to.equal(
      "https://api.tenderly.co/api/v1/account/acc/project/proj/simulate"
    );
    const body = JSON.parse(req.init.body);
    expect(body.save).to.equal(false);
    expect(body.save_if_fails).to.equal(false);
    expect(body.from).to.equal(await signer.getAddress());
    expect(body.to).to.equal(engineAddress);
    const selector = ethers
      .id("requestFlashLoan(address,uint256,address,uint256,bytes)")
      .slice(0, 10);
    expect(body.input.slice(0, 10)).to.equal(selector);

    const engine = await ethers.getContractAt("FlashLoan", engineAddress);
    expect(await engine.getBalance(assetAddr)).to.equal(E("11.5"));
  });

  it("Tenderly preflight: strict blocks on API errors, non-strict degrades to the eth_call gate", async function () {
    const { config, engineAddress, strategyAddress, provider, signer } =
      await loadFixture(marketFixture);

    const strictCfg = {
      ...config,
      tenderly: { accessToken: "t", accountSlug: "acc", projectSlug: "proj" },
      // strict defaults to true
    };
    const httpErr = async () => ({ ok: false, status: 500, json: async () => ({}) });

    const blocked = await scanOnce({
      provider, signer, engineAddress, strategyAddress, config: strictCfg, send: true, log: () => {},
      deps: { fetch: httpErr },
    });
    expect(blocked[0].profitable).to.equal(false);
    expect(blocked[0].txHash).to.equal(undefined);
    expect(blocked[0].tenderly.reason).to.equal("http-500");

    const looseCfg = {
      ...config,
      tenderly: { accessToken: "t", accountSlug: "acc", projectSlug: "proj", strict: false },
    };
    const degraded = await scanOnce({
      provider, signer, engineAddress, strategyAddress, config: looseCfg, send: true, log: () => {},
      deps: { fetch: httpErr },
    });
    expect(degraded[0].status).to.equal("confirmed"); // eth_call gate already ran
    expect(degraded[0].tenderly.ok).to.equal(true);
  });

  it("no Tenderly config: the gate is skipped and fetch is never called", async function () {
    const { config, engineAddress, strategyAddress, provider, signer } =
      await loadFixture(marketFixture);

    const fetchStub = async () => {
      throw new Error("must not be called");
    };
    const results = await scanOnce({
      provider, signer, engineAddress, strategyAddress, config, send: true, log: () => {},
      deps: { fetch: fetchStub },
    });

    expect(results[0].status).to.equal("confirmed");
    expect(results[0].tenderly).to.equal(undefined);
  });
});

describe("scanner safety helpers", function () {
  it("getGasPriceWei: the floor dominates when the chain price is lower (F1)", async function () {
    const { getGasPriceWei } = require("../scanner/lib/scan");
    const floor = 10n ** 15n; // 1000 gwei, far above any local feeData
    expect(await getGasPriceWei(ethers.provider, { floorWei: floor })).to.equal(floor);
    // no floor -> plain feeData (pre-F1 behavior preserved)
    const plain = await getGasPriceWei(ethers.provider);
    expect(typeof plain).to.equal("bigint");
    expect(plain).to.be.at.least(0n);
  });

  it("getGasPriceWei: a provider that cannot report falls back to the floor, not to 0", async function () {
    const { getGasPriceWei } = require("../scanner/lib/scan");
    const floor = 123456789n;
    expect(await getGasPriceWei({}, { floorWei: floor })).to.equal(floor);
    expect(await getGasPriceWei({})).to.equal(0n);
  });

  it("parseWei rejects malformed wei values loudly (a typo must not disable protection)", function () {
    const { parseWei } = require("../scanner/lib/scan");
    expect(() => parseWei("abc", "gasPriceFloorWei")).to.throw(/gasPriceFloorWei/);
    expect(parseWei("1000", "x")).to.equal(1000n);
  });

  it("resolveSendSigner: public by default; private wallet on a submit RPC when keyed", function () {
    const { resolveSendSigner } = require("../scanner/lib/submit");
    const sentinel = { address: "0x0000000000000000000000000000000000000001" };

    const pub = resolveSendSigner({ signer: sentinel, submitRpcUrl: "", privateKey: "" });
    expect(pub.signer).to.equal(sentinel);
    expect(pub.mode).to.equal("public");

    // submit URL without a key: keep the signer and report the downgrade
    const down = resolveSendSigner({
      signer: sentinel,
      submitRpcUrl: "https://rpc.example",
      privateKey: "",
    });
    expect(down.signer).to.equal(sentinel);
    expect(down.note).to.equal("no-key");

    const pk = ethers.Wallet.createRandom().privateKey;
    const submitUrl = "https://rpc-sepolia.flashbots.net/";
    const priv = resolveSendSigner({
      signer: sentinel,
      submitRpcUrl: submitUrl,
      privateKey: pk,
      log: () => {},
    });
    expect(priv.mode).to.equal("private");
    expect(priv.signer).to.not.equal(sentinel);
    expect(priv.signer.address).to.equal(new ethers.Wallet(pk).address);
    expect(priv.signer.provider._getConnection().url).to.equal(submitUrl);
  });
});

describe("scanner end-to-end (Balancer engine, 0-bps premium, auto-forward)", function () {
  async function balancerFixture() {
    const [deployer, , profitWallet] = await ethers.getSigners();

    const vault = await (await ethers.getContractFactory("MockBalancerVault")).deploy();

    const Token = await ethers.getContractFactory("MockERC20");
    const asset = await Token.deploy("Mock WETH", "mWETH", 18);
    const mid = await Token.deploy("Mock MID", "mMID", 18);

    const engine = await (
      await ethers.getContractFactory("BalancerFlashLoan")
    ).deploy(await vault.getAddress(), profitWallet.address);
    const routeStrategy = await (
      await ethers.getContractFactory("DexRouteArbStrategy")
    ).deploy(await engine.getAddress());
    await engine.registerStrategy(await routeStrategy.getAddress(), true);

    const Router = await ethers.getContractFactory("MockRouter");
    const routerA = await Router.deploy();
    const routerB = await Router.deploy();
    await routeStrategy.setTrustedRouter(await routerA.getAddress(), true);
    await routeStrategy.setTrustedRouter(await routerB.getAddress(), true);

    await asset.mint(await vault.getAddress(), E(1000000)); // lendable liquidity
    await mid.mint(await routerA.getAddress(), E(1000000));
    await asset.mint(await routerB.getAddress(), E(1000000));
    await routerB.setBonusBps(120); // the 1.2% opportunity

    const config = {
      deadlineSecs: 300,
      defaultSlippageBps: 50,
      defaultMinProfitWei: "0",
      wrappedNativeAsset: await asset.getAddress(),
      flashLoanProvider: "balancer",
      opportunities: [
        {
          id: "balancer-mWETH-mMID-A-vs-B",
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

    return {
      deployer,
      profitWallet,
      vault,
      asset,
      provider: ethers.provider,
      config,
      engineAddress: await engine.getAddress(),
      strategyAddress: await routeStrategy.getAddress(),
      signer: deployer,
    };
  }

  it("prices the Balancer premium at 0 bps (fee override and unknown provider covered)", async function () {
    const { config, engineAddress, provider } = await loadFixture(balancerFixture);
    const engine = await ethers.getContractAt("BalancerFlashLoan", engineAddress);
    const { resolvePremiumBps } = require("../scanner/lib/scan");

    expect(await resolvePremiumBps(config, engine, provider)).to.equal(0n);
    // governance-fee override knob
    expect(await resolvePremiumBps({ ...config, flashLoanFeeBps: "7" }, engine, provider)).to.equal(7n);
    // unknown provider fails loudly instead of silently mispricing
    await expect(resolvePremiumBps({ ...config, flashLoanProvider: "dydx" }, engine, provider)).to.be
      .rejected;
    // aave is the default when unset
    expect(await resolvePremiumBps({}, engine, provider)).to.equal(5n); // mock-pool fallback
  });

  it("send mode: confirms the trade and books the exact profit into the profit wallet", async function () {
    const { config, engineAddress, strategyAddress, provider, signer, profitWallet, vault } =
      await loadFixture(balancerFixture);
    const assetAddr = config.opportunities[0].borrowAsset;
    const asset = await ethers.getContractAt("MockERC20", assetAddr);
    const vaultBefore = await asset.balanceOf(await vault.getAddress());

    const results = await scanOnce({
      provider, signer, engineAddress, strategyAddress, config, send: true, log: () => {},
    });

    expect(results[0].error).to.equal(undefined);
    expect(results[0].profitable).to.equal(true);
    expect(results[0].status).to.equal("confirmed");
    // 0-bps premium: out 1012 - in 1000 = 12, all forwarded to the wallet.
    expect(BigInt(results[0].eval.premium)).to.equal(0n);

    const engine = await ethers.getContractAt("BalancerFlashLoan", engineAddress);
    expect(await engine.getBalance(assetAddr)).to.equal(0); // auto-forwarded, engine retains nothing
    expect(await asset.balanceOf(profitWallet.address)).to.equal(E(12));
    expect(await asset.balanceOf(await vault.getAddress())).to.equal(vaultBefore); // repaid exactly
  });

  it("dry-run: simulates via staticCall and sends nothing", async function () {
    const { config, engineAddress, strategyAddress, provider, signer, profitWallet } =
      await loadFixture(balancerFixture);
    const assetAddr = config.opportunities[0].borrowAsset;

    const results = await scanOnce({
      provider, signer, engineAddress, strategyAddress, config, send: false, log: () => {},
    });

    expect(results[0].profitable).to.equal(true);
    expect(results[0].dryRun).to.equal(true);
    expect(results[0].txHash).to.equal(undefined);
    const asset = await ethers.getContractAt("MockERC20", assetAddr);
    expect(await asset.balanceOf(profitWallet.address)).to.equal(0); // nothing moved
  });

  it("skips unprofitable cycles without sending (parity with the Aave path)", async function () {
    const { config, engineAddress, strategyAddress, provider, signer, profitWallet } =
      await loadFixture(balancerFixture);
    const routerB = await ethers.getContractAt("MockRouter", config.opportunities[0].legs[1].router);
    await routerB.setBonusBps(0); // opportunity disappears

    const results = await scanOnce({
      provider, signer, engineAddress, strategyAddress, config, send: true, log: () => {},
    });

    expect(results[0].profitable).to.equal(false);
    expect(results[0].txHash).to.equal(undefined);
    expect(results[0].reasons.join(" ")).to.match(/grossProfit/);
    const asset = await ethers.getContractAt("MockERC20", config.opportunities[0].borrowAsset);
    expect(await asset.balanceOf(profitWallet.address)).to.equal(0);
  });
});

describe("restore solver (pure gap restoration)", function () {
  const { amountOutFor, solveSwapForTargetRatio, planRestore } = require("../scanner/lib/restore");

  it("amountOutFor prices a V2 swap with the LP fee", function () {
    // 1000 in, balanced 1M/1M pool, 30 bps fee -> out ~996.006
    const out = amountOutFor(E(1000), E(1000000), E(1000000), 30);
    expect(out).to.be.greaterThan(E("995.9"));
    expect(out).to.be.lessThan(E("996.1"));
    expect(amountOutFor(0n, E(1), E(1), 30)).to.equal(0n);
  });

  it("plans a mid->asset swap (SLL mid into the pool) to RAISE a converged pool to its target", function () {
    // target 1000 mid per asset; pool converged at ~959.2 mid per asset.
    // Selling mid grows the pool's mid reserve -> price rMid/rAsset rises.
    const reserveAsset = E("0.1");
    const reserveMid = E("95.92");
    const plan = planRestore({
      reserveAsset,
      reserveMid,
      targetMidPerAsset: 1000,
      feeBps: 30,
      toleranceBps: 50n,
    });
    expect(plan, "plan").to.not.equal(null);
    expect(plan.direction).to.equal("mid->asset");
    expect(plan.reachable).to.equal(true);
    expect(plan.amountIn).to.be.greaterThan(0n);
    // executing the planned swap must land the pool at ~1000 mid/asset
    const out = amountOutFor(plan.amountIn, reserveMid, reserveAsset, 30);
    const priceAfter = Number(reserveMid + plan.amountIn) / Number(reserveAsset - out);
    expect(priceAfter).to.be.closeTo(1000, 0.5); // within 0.05%
    expect(plan.priceAfter).to.be.closeTo(priceAfter, 0.000001);
  });

  it("plans an asset->mid swap (BUY mid from the pool) to LOWER a pool priced ABOVE its target", function () {
    // target 920, converged at ~959.2 -> price too high -> buy mid with asset;
    // the pool's asset reserve grows -> price rMid/rAsset falls.
    const reserveAsset = E("0.1");
    const reserveMid = E("95.92");
    const plan = planRestore({
      reserveAsset,
      reserveMid,
      targetMidPerAsset: 920,
      feeBps: 30,
      toleranceBps: 50n,
    });
    expect(plan, "plan").to.not.equal(null);
    expect(plan.direction).to.equal("asset->mid");
    const out = amountOutFor(plan.amountIn, reserveAsset, reserveMid, 30);
    const priceAfter = Number(reserveMid - out) / Number(reserveAsset + plan.amountIn);
    expect(priceAfter).to.be.closeTo(920, 0.5);
  });

  it("skips a venue whose price is already within tolerance", function () {
    expect(
      planRestore({
        reserveAsset: E("0.1"),
        reserveMid: E("100"),
        targetMidPerAsset: 1000,
        toleranceBps: 50n,
      })
    ).to.equal(null);
  });

  it("caps the swap and flags unreachable when the target exceeds the budget", function () {
    // price 100 -> target 10000 requires selling far more mid than 50% of
    // the pool's mid reserve (the natural scale for a mid->asset push).
    const plan = planRestore({
      reserveAsset: E("1"),
      reserveMid: E("100"),
      targetMidPerAsset: 10000,
      feeBps: 30,
      toleranceBps: 50n,
      maxInBps: 5000n,
    });
    expect(plan, "plan").to.not.equal(null);
    expect(plan.direction).to.equal("mid->asset");
    expect(plan.reachable).to.equal(false);
    expect(plan.amountIn).to.equal(E("50")); // exactly the 50% budget
  });

  it("solveSwapForTargetRatio returns null when the pool already meets the target", function () {
    // ratio reserveOut'/reserveIn' only DECREASES while spending reserveIn;
    // at 0.5 it is already below the 1.0 target -> nothing to solve.
    expect(
      solveSwapForTargetRatio({
        reserveIn: E("2000"),
        reserveOut: E("1000"),
        targetNum: 1000n,
        targetDen: 1000n,
        feeBps: 30,
      })
    ).to.equal(null);
  });
});