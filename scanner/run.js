"use strict";

/**
 * End-to-end orchestrator: deploys the bot, builds a market, runs the
 * scanner against it (dry-run first, then SEND), and records every step to
 * an append-only JSONL log plus CSV/markdown artifacts under results/.
 *
 * Local (default hardhat network): mock Aave pool + two mock venues with a
 * deliberate price gap — fully offline rehearsal of the same flow.
 *
 * Sepolia: REAL Aave V3 pool (WETH reserve, flashLoanEnabled), REAL
 * Uniswap V2 and SushiSwap routers. The market is created by seeding
 * MYTOKEN/WETH pools on both venues at deliberately different prices, so
 * every swap goes through production DEX code with real fees and slippage.
 * The only testnet-specific pieces are the mintable MYTOKEN and the pool
 * seeding (funded by wrapping the signer's Sepolia ETH).
 *
 * Run:
 *   npx hardhat run scanner/run.js                       (local rehearsal)
 *   npx hardhat run scanner/run.js --network sepolia     (live testnet run)
 *
 * Env knobs:
 *   DRY_CYCLES=2     dry-run scan cycles (quote + staticCall, no tx)
 *   SEND_CYCLES=1    send cycles (real transactions)
 *   POOL_WETH_ETH=0.1   WETH seeded per venue on Sepolia
 *   TRADE_WETH_ETH=0.002   flash-loan notional per trade (Sepolia)
 *   GAS_RESERVE_ETH=0.05   ETH the signer must keep for gas
 *   RUN_ID=<id>      override the run identifier
 *
 * Profit-safety knobs (see RESULTS.md F1):
 *   GAS_PRICE_FLOOR_WEI   min gas price the gate may assume; default on
 *                         Sepolia is 2 gwei — what a tx actually paid in
 *                         run 8 — so net-negative micro-arbs are skipped.
 *                         GAS_PRICE_FLOOR_WEI=0 restores the old behavior
 *                         (only do that to demonstrate a live send).
 *   SUBMIT_RPC_URL        private submission RPC for sends, e.g.
 *                         https://rpc-sepolia.flashbots.net/ (Flashbots
 *                         Protect: hides the tx from the mempool and does
 *                         not include reverting txs -> no gas on failure).
 *   TENDERLY_ACCESS_TOKEN / TENDERLY_ACCOUNT_SLUG / TENDERLY_PROJECT_SLUG
 *                         enable the fail-closed Tenderly preflight before
 *                         every broadcast (see scanner/lib/tenderly.js).
 *
 * Campaign mode (volume runs; every relaxation is recorded in the run log):
 *   RESTORE_GAP=true      re-create the deliberate price gap on every venue
 *                         before EACH send cycle (pure constant-product
 *                         solver in scanner/lib/restore.js) so N trades can
 *                         fire instead of one. Mock/local markets are
 *                         static: the restore is recorded as a skip.
 *   NET_PROFIT_ON_CHAIN=false   keep the on-chain minProfit at the gross
 *                         floor (no gas budget folded in). The scanner's
 *                         off-chain gates, the eth_call preflight and the
 *                         per-leg slippage pins all stay ON.
 *   ABORT_BELOW_ETH=0.2   stop sending when the signer's ETH balance drops
 *                         below this reserve (recorded as a `stop` entry).
 *
 * Resume after an interrupted live run (skip re-deploying what exists):
 *   MID_TOKEN=<addr> ENGINE_ADDRESS=<addr> ROUTE_STRATEGY_ADDRESS=<addr>
 */
const hre = require("hardhat");
const { ethers } = hre;
const { scanOnce } = require("./lib/scan");
const { createRun, writeArtifacts, readEntries } = require("./lib/results");
const { fetchPnl } = require("./lib/ledger");
const { resolveSendSigner } = require("./lib/submit");
const { planRestore } = require("./lib/restore");

// Verified live on Sepolia (2026-10-18): pool holds ~0.02 WETH / ~20k USDC,
// both reserves flashLoanEnabled=true, premium 5 bps, gas ~0.000000019 gwei.
const SEPOLIA = {
  aaveProvider: "0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A",
  weth: "0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c",
  uniRouter: "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3",
  uniFactory: "0xF62c03E08ada871A0bEb309762E260a7a6a880E6",
  sushiRouter: "0xeabce3e74ef41fb40024a21cc2ee2f5ddc615791",
  sushiFactory: "0x734583f62bb6ace3c9ba9bd5a53143ca2ce8c55a",
};

const V2_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)",
];
const V2_FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address pair)",
  "function createPair(address tokenA, address tokenB) returns (address pair)",
];
const WETH9_ABI = [
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];
const POOL_READ_ABI = [
  "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)",
];
const PAIR_RESERVES_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
];

// Seeded venues: MYTOKEN priced at myPerWeth per WETH on each real DEX.
// The 1000 vs 920 rate is the deliberate ~8.7% price gap the arb trades.
const VENUES = [
  { name: "uniswapV2", router: "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3", factory: "0xF62c03E08ada871A0bEb309762E260a7a6a880E6", myPerWeth: 1000n, feeBps: 30 },
  { name: "sushiswap", router: "0xeabce3e74ef41fb40024a21cc2ee2f5ddc615791", factory: "0x734583f62bb6ace3c9ba9bd5a53143ca2ce8c55a", myPerWeth: 920n, feeBps: 30 },
];

const E = (n) => ethers.parseEther(String(n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Observed on public Sepolia RPCs: eth_sendRawTransaction sometimes returns
// "replacement transaction underpriced" (or times out) AFTER the tx has
// actually been accepted — the follow-up retry then collides on the nonce.
// These are the error shapes where "did it land?" is worth checking.
const AMBIGUOUS_SEND =
  /underpriced|already known|known transaction|nonce too low|not found|timeout|failed to fetch|network error/i;

/**
 * Send a transaction and wait, resilient to RPCs that error after accepting.
 * On an ambiguous error: wait for propagation, then ask `effect` whether the
 * transaction actually did its job on-chain; if so, continue as success.
 * Otherwise retry (nonce is re-fetched fresh on every attempt).
 */
async function sendWait(label, fn, effect, { attempts = 3, waitMs = 12000, log = () => {}, onHurdle = null } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const tx = await fn();
      return await tx.wait();
    } catch (err) {
      const msg = String(err?.shortMessage ?? err?.message ?? err).split("\n")[0];
      if (!AMBIGUOUS_SEND.test(msg) || attempt === attempts) {
        onHurdle?.({
          label,
          error: msg.slice(0, 200),
          resolution: AMBIGUOUS_SEND.test(msg) ? "exhausted-retries-throws" : "send-failed-throws",
          attempt,
        });
        throw err;
      }
      log(
        `  [${label}] rpc error '${msg.slice(0, 90)}' — verifying on-chain state ` +
          `(attempt ${attempt}/${attempts})`
      );
      onHurdle?.({
        label,
        error: msg.slice(0, 200),
        resolution: "ambiguous-rpc-error-verifying-onchain",
        attempt,
      });
      await sleep(waitMs);
      if (effect && (await effect())) {
        log(`  [${label}] tx actually landed — continuing`);
        onHurdle?.({
          label,
          error: msg.slice(0, 200),
          resolution: "verified-onchain-tx-landed",
          attempt,
        });
        return null;
      }
    }
  }
  throw new Error(`${label}: exhausted ${attempts} send attempts`);
}

/** Offline mock market — same shape as demoLocal.js, deterministic profit. */
async function deployMockMarket(deployer) {
  const pool = await (await ethers.getContractFactory("MockPool")).deploy();
  const addrProvider = await (
    await ethers.getContractFactory("MockPoolAddressesProvider")
  ).deploy(await pool.getAddress());
  const Token = await ethers.getContractFactory("MockERC20");
  const asset = await Token.deploy("Mock WETH", "mWETH", 18);
  const mid = await Token.deploy("Mock MID", "mMID", 18);
  const engine = await (
    await ethers.getContractFactory("FlashLoan")
  ).deploy(await addrProvider.getAddress());
  const strategy = await (
    await ethers.getContractFactory("DexRouteArbStrategy")
  ).deploy(await engine.getAddress());
  await (await engine.registerStrategy(await strategy.getAddress(), true)).wait();
  const Router = await ethers.getContractFactory("MockRouter");
  const routerA = await Router.deploy();
  const routerB = await Router.deploy();
  await (await strategy.setTrustedRouter(await routerA.getAddress(), true)).wait();
  await (await strategy.setTrustedRouter(await routerB.getAddress(), true)).wait();

  await (await asset.mint(await pool.getAddress(), E(1000000))).wait();
  await (await mid.mint(await routerA.getAddress(), E(1000000))).wait();
  await (await asset.mint(await routerB.getAddress(), E(1000000))).wait();
  await (await routerB.setBonusBps(120)).wait(); // the deliberate 1.2% gap

  const assetAddr = await asset.getAddress();
  const venueA = { name: "mockA", router: await routerA.getAddress() };
  const venueB = { name: "mockB(+1.2%)", router: await routerB.getAddress() };
  return {
    engineAddress: await engine.getAddress(),
    strategyAddress: await strategy.getAddress(),
    asset: assetAddr,
    mid: await mid.getAddress(),
    venueA,
    venueB,
    amountIn: E(1000),
    poolAddressProvider: await addrProvider.getAddress(),
    restorable: false, // static mock market: the gap cannot converge
  };
}

/**
 * Live Sepolia market: wrap ETH, deploy the engine against the REAL Aave
 * pool, seed MYTOKEN/WETH pools on both real DEXes at different prices.
 */
async function deploySepoliaMarket(deployer, log, onHurdle = null) {
  const poolWeth = E(process.env.POOL_WETH_ETH ?? "0.1");
  const tradeWeth = E(process.env.TRADE_WETH_ETH ?? "0.002");
  const wrapAmount = poolWeth * 2n + tradeWeth;
  const gasReserve = E(process.env.GAS_RESERVE_ETH ?? "0.05"); // keep ETH for gas on top of the wrap

  // Idempotent: an interrupted run may already hold WETH — only the
  // shortfall has to be wrapped, so only the shortfall must be in ETH.
  const weth = new ethers.Contract(SEPOLIA.weth, WETH9_ABI, deployer);
  const heldWeth = await weth.balanceOf(deployer.address);
  const shortfall = heldWeth >= wrapAmount ? 0n : wrapAmount - heldWeth;

  const ethBal = await deployer.provider.getBalance(deployer.address);
  if (ethBal < shortfall + gasReserve) {
    throw new Error(
      `signer ${deployer.address} needs >= ` +
        `${ethers.formatEther(shortfall + gasReserve)} Sepolia ETH to run the test ` +
        `(have ${ethers.formatEther(ethBal)}): wrap shortfall=` +
        `${ethers.formatEther(shortfall)} (holding ${ethers.formatEther(heldWeth)} WETH) ` +
        `+ gas reserve=${ethers.formatEther(gasReserve)}`
    );
  }

  // All sends below go through sendWait: public Sepolia RPCs may error
  // AFTER accepting a tx, and each step verifies its on-chain effect.
  const sw = (label, fn, effect) => sendWait(label, fn, effect, { log, onHurdle });

  /** Deploy with a nonce-predicted address so an ambiguous error can be
   *  resolved by checking code at that address. */
  const deployContract = async (label, factoryName, args = []) => {
    const factory = await ethers.getContractFactory(factoryName);
    let predicted = null;
    await sw(
      label,
      async () => {
        const nonce = await ethers.provider.getTransactionCount(deployer.address, "pending");
        predicted = ethers.getCreateAddress({ from: deployer.address, nonce });
        const contract = await factory.deploy(...args);
        // ethers v6 deploy() resolves to a Contract; sendWait needs the tx.
        return contract.deploymentTransaction();
      },
      async () => (await ethers.provider.getCode(predicted)) !== "0x"
    );
    return ethers.getContractAt(factoryName, predicted);
  };

  // 1. Wrap ETH -> WETH (the Aave Sepolia WETH is a WETH9: deposit() works).
  if (shortfall === 0n) {
    log(`already holding ${ethers.formatEther(heldWeth)} WETH — skipping wrap`);
  } else {
    log(`wrapping ${ethers.formatEther(shortfall)} ETH -> WETH at ${SEPOLIA.weth}`);
    await sw(
      "wrap-eth",
      () => weth.deposit({ value: shortfall }),
      async () => (await weth.balanceOf(deployer.address)) >= wrapAmount
    );
  }

  // 2. Mid token: resume support — reuse from MID_TOKEN when the env var
  //    points at a contract from an interrupted run.
  const mytoken = process.env.MID_TOKEN
    ? await ethers.getContractAt("MockERC20", process.env.MID_TOKEN)
    : await deployContract("deploy-mid-token", "MockERC20", ["Goku Test Token", "GTT", 18]);
  const myAddr = await mytoken.getAddress();
  if ((await ethers.provider.getCode(myAddr)) === "0x") {
    throw new Error(`MID_TOKEN ${myAddr} has no code on this network`);
  }

  // Top up the GTT the two venues will be seeded with (open mint — test token).
  const gttNeeded = poolWeth * VENUES.reduce((acc, v) => acc + v.myPerWeth, 0n);
  const gttHeld = await mytoken.balanceOf(deployer.address);
  if (gttHeld < gttNeeded) {
    const gttShort = gttNeeded - gttHeld;
    await sw(
      "mint-mid-token",
      () => mytoken.mint(deployer.address, gttShort),
      async () => (await mytoken.balanceOf(deployer.address)) >= gttNeeded
    );
  } else {
    log(`already holding ${ethers.formatEther(gttHeld)} GTT — skipping mint`);
  }

  // 3. Engine + strategy against the REAL Aave pool via its real provider.
  //    Resume support: ENGINE_ADDRESS / ROUTE_STRATEGY_ADDRESS reuse a prior
  //    deployment instead of paying to deploy again.
  const providerAddr = process.env.POOL_ADDRESSES_PROVIDER || SEPOLIA.aaveProvider;
  let engine;
  if (process.env.ENGINE_ADDRESS) {
    engine = await ethers.getContractAt("FlashLoan", process.env.ENGINE_ADDRESS);
    log(`reusing engine ${process.env.ENGINE_ADDRESS}`);
  } else {
    engine = await deployContract("deploy-engine", "FlashLoan", [providerAddr]);
  }
  const engineAddress = await engine.getAddress();
  if ((await ethers.provider.getCode(engineAddress)) === "0x") {
    throw new Error(`engine ${engineAddress} has no code on this network`);
  }
  let strategy;
  if (process.env.ROUTE_STRATEGY_ADDRESS) {
    strategy = await ethers.getContractAt("DexRouteArbStrategy", process.env.ROUTE_STRATEGY_ADDRESS);
    log(`reusing strategy ${process.env.ROUTE_STRATEGY_ADDRESS}`);
  } else {
    strategy = await deployContract("deploy-strategy", "DexRouteArbStrategy", [engineAddress]);
  }
  const strategyAddress = await strategy.getAddress();
  if ((await ethers.provider.getCode(strategyAddress)) === "0x") {
    throw new Error(`strategy ${strategyAddress} has no code on this network`);
  }
  // Idempotent, and skipped when the resumed deployment already did them.
  if (!(await engine.isStrategy(strategyAddress))) {
    await sw(
      "register-strategy",
      () => engine.registerStrategy(strategyAddress, true),
      () => engine.isStrategy(strategyAddress)
    );
  }
  for (const r of [SEPOLIA.uniRouter, SEPOLIA.sushiRouter]) {
    if (!(await strategy.trustedRouter(r))) {
      await sw(`trust-router-${r}`, () => strategy.setTrustedRouter(r, true));
    }
  }

  // 4. Seed both venues with MYTOKEN/WETH pools at different prices:
  //    venue A prices MYTOKEN at 1000/WETH, venue B at 920/WETH -> ~8.7% gap.
  const venues = VENUES.map((v) => ({ ...v }));
  const deadline = Math.floor(Date.now() / 1000) + 600;
  for (const v of venues) {
    const factory = new ethers.Contract(v.factory, V2_FACTORY_ABI, deployer);
    let pair = await factory.getPair(myAddr, SEPOLIA.weth);
    if (pair === ethers.ZeroAddress) {
      log(`${v.name}: creating MYTOKEN/WETH pair on factory ${v.factory}`);
      await sw(
        `${v.name}-create-pair`,
        () => factory.createPair(myAddr, SEPOLIA.weth),
        async () => (await factory.getPair(myAddr, SEPOLIA.weth)) !== ethers.ZeroAddress
      );
      pair = await factory.getPair(myAddr, SEPOLIA.weth);
    }
    const myAmount = poolWeth * v.myPerWeth; // poolWeth tokens per WETH, in token wei
    const router = new ethers.Contract(v.router, V2_ROUTER_ABI, deployer);
    const seeded = async () => {
      const pairC = new ethers.Contract(pair, PAIR_RESERVES_ABI, deployer.provider);
      const [r0, r1] = await pairC.getReserves();
      return r0 > 0n && r1 > 0n;
    };
    // Resume: a pool that already holds liquidity must not be double-seeded
    // (a second addLiquidity would revert on allowance/balance anyway).
    if (await seeded()) {
      log(`${v.name}: pool already seeded — skipping addLiquidity (resume)`);
      v.pair = pair;
      continue;
    }
    log(`${v.name}: seeding ${ethers.formatEther(poolWeth)} WETH + ${ethers.formatEther(myAmount)} GTT`);
    // approve() overwrites the allowance — idempotent, bare retries are safe.
    await sw(`${v.name}-approve-gtt`, () => mytoken.approve(v.router, myAmount));
    await sw(`${v.name}-approve-weth`, () => weth.approve(v.router, poolWeth));
    await sw(
      `${v.name}-add-liquidity`,
      () =>
        router.addLiquidity(
          myAddr, SEPOLIA.weth, myAmount, poolWeth, myAmount, poolWeth, deployer.address, deadline
        ),
      seeded
    );
    v.pair = pair;
  }

  // 5. Read-only sanity facts worth keeping in the run log.
  const aavePool = new ethers.Contract(await engine.POOL(), POOL_READ_ABI, deployer.provider);
  const premiumBps = Number(await aavePool.FLASHLOAN_PREMIUM_TOTAL());
  const poolWethBalance = await weth.balanceOf(await engine.POOL());

  return {
    engineAddress,
    strategyAddress,
    asset: SEPOLIA.weth, // borrowed asset == wrapped native -> gas netting is live
    mid: myAddr,
    venueA: { name: venues[0].name, router: venues[0].router, pair: venues[0].pair },
    venueB: { name: venues[1].name, router: venues[1].router, pair: venues[1].pair },
    amountIn: tradeWeth,
    poolAddressProvider: providerAddr,
    restorable: true,
    venues: venues.map((v) => ({
      name: v.name,
      router: v.router,
      pair: v.pair,
      myPerWeth: v.myPerWeth,
      feeBps: v.feeBps,
    })),
    extraFacts: {
      aavePool: await engine.POOL(),
      aavePremiumBps: premiumBps,
      aavePoolWethLiquidity: ethers.formatEther(poolWethBalance),
      poolSeededWeth: ethers.formatEther(poolWeth),
      mytoken: myAddr,
      signer: deployer.address,
      signerEthBefore: ethers.formatEther(ethBal),
    },
  };
}

const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];
const ERC20_RW_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
  "function deposit() payable",
];
const MAX_UINT256 = (1n << 256n) - 1n;

/** Read a V2 pair's reserves keyed by which side is MID vs the WETH asset. */
async function readPairReserves(provider, pairAddr, midAddr, assetAddr) {
  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const [t0, t1, reserves] = await Promise.all([
    pair.token0(),
    pair.token1(),
    pair.getReserves(),
  ]);
  const midIs0 = t0.toLowerCase() === midAddr.toLowerCase();
  const assetIs0 = t0.toLowerCase() === assetAddr.toLowerCase();
  if (midIs0 === assetIs0) {
    throw new Error(`pair ${pairAddr} is not a mid/asset pair (token0=${t0})`);
  }
  const t1Expected = midIs0 ? assetAddr : midAddr;
  if (t1.toLowerCase() !== t1Expected.toLowerCase()) {
    throw new Error(`pair ${pairAddr} token1 ${t1} != expected ${t1Expected}`);
  }
  return {
    reserveMid: midIs0 ? reserves[0] : reserves[1],
    reserveAsset: midIs0 ? reserves[1] : reserves[0],
  };
}

/** Wallet + engine balances for the holdings record (never throws). */
async function snapshotHoldings({ provider, signer, engineAddress, asset, mid, phase }) {
  const out = { phase };
  try {
    const erc20 = ["function balanceOf(address) view returns (uint256)"];
    out.block = await provider.getBlockNumber();
    out.ethWei = (await provider.getBalance(signer.address)).toString();
    out.assetWei = (
      await new ethers.Contract(asset, erc20, provider).balanceOf(signer.address)
    ).toString();
    out.midWei = (
      await new ethers.Contract(mid, erc20, provider).balanceOf(signer.address)
    ).toString();
    out.engineProfitWei = (
      await new ethers.Contract(
        engineAddress,
        ["function getBalance(address) view returns (uint256)"],
        provider
      ).getBalance(asset)
    ).toString();
  } catch (err) {
    out.error = String(err?.shortMessage ?? err?.message ?? err).split("\n")[0].slice(0, 200);
  }
  return out;
}

/**
 * Restore the deliberate price gap on every venue (campaign mode): after an
 * arb trade converged the pools, swap each venue back to its target price
 * using the pure solver in lib/restore.js. Every restore swap (or skip
 * reason) is recorded as a `restore` entry; operational problems become
 * `hurdle` entries and never abort the campaign.
 */
async function restoreGap({ deployer, market, log, record, onHurdle }) {
  if (!market.restorable) {
    record("restore", {
      action: "skip",
      reason: "static mock market — the gap cannot converge; nothing to restore",
    });
    return;
  }
  const provider = deployer.provider;
  const deadline = Math.floor(Date.now() / 1000) + 300;
  const slippageBps = 200n; // solver ran on the same reserves; 2% covers drift
  const assetRc = new ethers.Contract(market.asset, ERC20_RW_ABI, deployer);
  const midToken = new ethers.Contract(market.mid, ERC20_RW_ABI, deployer);

  for (const v of market.venues ?? []) {
    try {
      const before = await readPairReserves(provider, v.pair, market.mid, market.asset);
      const plan = planRestore({
        reserveAsset: before.reserveAsset,
        reserveMid: before.reserveMid,
        targetMidPerAsset: v.myPerWeth,
        feeBps: v.feeBps ?? 30,
        toleranceBps: 50n,
      });
      if (!plan) {
        record("restore", {
          venue: v.name,
          action: "skip",
          targetMidPerAsset: Number(v.myPerWeth),
          price: Number(before.reserveMid) / Number(before.reserveAsset),
          reason: "gap within tolerance",
        });
        log(`  restore ${v.name}: gap within tolerance — nothing to do`);
        continue;
      }
      if (!plan.reachable) {
        record("restore", { venue: v.name, action: "capped", ...plan });
        log(`  restore ${v.name}: target unreachable within budget — capped best-effort`);
      }

      // Funding: the spent side must be in the wallet (wrap ETH / mint mid).
      const spendToken = plan.direction === "asset->mid" ? market.asset : market.mid;
      const spendRc = spendToken === market.asset ? assetRc : midToken;
      const held = await spendRc.balanceOf(deployer.address);
      if (held < plan.amountIn) {
        const need = plan.amountIn - held;
        if (plan.direction === "asset->mid") {
          const gasReserve = E(process.env.GAS_RESERVE_ETH ?? "0.05");
          const wrap = need + E("0.001"); // small buffer for later cycles
          const ethBal = await provider.getBalance(deployer.address);
          if (ethBal < wrap + gasReserve) {
            throw new Error(
              `insufficient ETH to wrap for restore (have ${ethers.formatEther(ethBal)}, ` +
                `need ${ethers.formatEther(wrap + gasReserve)})`
            );
          }
          log(`  restore ${v.name}: wrapping ${ethers.formatEther(wrap)} ETH -> asset`);
          await sendWait(
            `restore-wrap-${v.name}`,
            () => assetRc.deposit({ value: wrap }),
            async () => (await assetRc.balanceOf(deployer.address)) >= held + wrap,
            { log, onHurdle }
          );
        } else {
          const minted = need * 2n; // buffer for later cycles
          log(`  restore ${v.name}: minting ${ethers.formatEther(minted)} mid (open test mint)`);
          await sendWait(
            `restore-mint-${v.name}`,
            () => midToken.mint(deployer.address, minted),
            async () => (await midToken.balanceOf(deployer.address)) >= plan.amountIn,
            { log, onHurdle }
          );
        }
      }

      // Approve once per venue+token (max), then the allowance never runs out.
      const allowance = await spendRc.allowance(deployer.address, v.router);
      if (allowance < plan.amountIn) {
        await sendWait(
          `restore-approve-${v.name}`,
          () => spendRc.approve(v.router, MAX_UINT256),
          async () => (await spendRc.allowance(deployer.address, v.router)) >= plan.amountIn,
          { log, onHurdle }
        );
      }

      const router = new ethers.Contract(v.router, V2_ROUTER_ABI, deployer);
      const minOut = (plan.amountOut * (10000n - slippageBps)) / 10000n;
      const path =
        plan.direction === "asset->mid" ? [market.asset, market.mid] : [market.mid, market.asset];
      const reservesChanged = async () => {
        const now = await readPairReserves(provider, v.pair, market.mid, market.asset);
        return now.reserveMid !== before.reserveMid || now.reserveAsset !== before.reserveAsset;
      };
      const receipt = await sendWait(
        `restore-swap-${v.name}`,
        () =>
          router.swapExactTokensForTokens(plan.amountIn, minOut, path, deployer.address, deadline),
        reservesChanged,
        { log, onHurdle }
      );
      const after = await readPairReserves(provider, v.pair, market.mid, market.asset);
      const priceAfter = Number(after.reserveMid) / Number(after.reserveAsset);
      record("restore", {
        venue: v.name,
        action: "swap",
        direction: plan.direction,
        targetMidPerAsset: plan.targetMidPerAsset,
        priceBefore: plan.priceBefore,
        priceAfter,
        amountInWei: plan.amountIn,
        expectedOutWei: plan.amountOut,
        reachable: plan.reachable,
        gasUsedWei: receipt ? receipt.gasUsed?.toString() ?? null : null,
        gasCostWei:
          receipt && receipt.gasPrice != null && receipt.gasUsed != null
            ? (receipt.gasUsed * receipt.gasPrice).toString()
            : null,
        txHash: receipt?.hash ?? "landed-verified-by-effect",
      });
      log(
        `  restore ${v.name}: ${plan.direction} ${ethers.formatEther(plan.amountIn)} — ` +
          `price ${plan.priceBefore.toFixed(1)} -> ${priceAfter.toFixed(1)} ` +
          `(target ${plan.targetMidPerAsset})`
      );
    } catch (err) {
      const msg = String(err?.shortMessage ?? err?.message ?? err).split("\n")[0].slice(0, 200);
      record("restore", { venue: v.name, action: "failed", error: msg });
      onHurdle?.({ stage: `restore-${v.name}`, error: msg, resolution: "restore-failed-continuing" });
      log(`  restore ${v.name}: FAILED — ${msg} (continuing; the next cycle may refuse)`);
    }
  }
}

async function main() {
  const network = hre.network.name;
  const isSepolia = network === "sepolia";
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "no signer available — set PRIVATE_KEY in goku/.env for live networks"
    );
  }

  const runId =
    process.env.RUN_ID ||
    `${network}-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "")}`;
  const run = createRun({ runId, network });
  const log = (...a) => {
    console.log(...a);
  };

  const dryCycles = Number(process.env.DRY_CYCLES ?? 2);
  const sendCycles = Number(process.env.SEND_CYCLES ?? (isSepolia ? 1 : 1));
  const restoreEnabled = process.env.RESTORE_GAP === "true";
  const abortBelowWei = ethers.parseEther(process.env.ABORT_BELOW_ETH ?? "0.2");
  const mode = isSepolia ? "SEPOLIA (real Aave pool + real DEX routers)" : "local mock market";

  log(`run ${runId} -> ${run.file}`);
  log(`mode: ${mode}`);
  log(`signer: ${deployer.address}`);
  log(`cycles: ${dryCycles} dry-run, ${sendCycles} send\n`);

  run.record("run", { dryCycles, sendCycles, signer: deployer.address, mode, restoreEnabled });

  // Every operational obstacle — RPC retries, ambiguous sends, failed
  // restores, aborted cycles — is recorded and surfaced, never swallowed.
  const onHurdle = (h) => {
    run.record("hurdle", h);
    log(
      `  ! hurdle [${h.stage ?? h.label ?? "?"}] ${String(h.error ?? "").slice(0, 120)} -> ${h.resolution}`
    );
  };

  // --- market -------------------------------------------------------------
  log("== setup ==");
  const market = isSepolia
    ? await deploySepoliaMarket(deployer, log, onHurdle)
    : await deployMockMarket(deployer);

  const deployBlock = await ethers.provider.getBlockNumber();
  const setupFacts = {
    engine: market.engineAddress,
    strategy: market.strategyAddress,
    asset: market.asset,
    mid: market.mid,
    venueA: market.venueA,
    venueB: market.venueB,
    amountInWei: market.amountIn.toString(),
    deployBlock,
    ...(market.extraFacts ?? {}),
  };
  run.record("setup", { facts: setupFacts });
  log("engine   :", market.engineAddress);
  log("strategy :", market.strategyAddress);
  log("asset    :", market.asset, " mid:", market.mid);
  log("venueA   :", market.venueA);
  log("venueB   :", market.venueB, "\n");

  run.record(
    "holdings",
    await snapshotHoldings({
      provider: ethers.provider,
      signer: deployer,
      engineAddress: market.engineAddress,
      asset: market.asset,
      mid: market.mid,
      phase: "baseline",
    })
  );

  // Private submission: sends (only) can go through a mempool-hiding RPC
  // whose default policy excludes reverting transactions.
  const submission = resolveSendSigner({
    signer: deployer,
    submitRpcUrl: process.env.SUBMIT_RPC_URL || "",
    privateKey: process.env.PRIVATE_KEY || "",
    log,
  });
  run.record("submission", { mode: submission.mode, endpoint: submission.endpoint ?? null });
  log(`submission: ${submission.mode}${submission.endpoint ? ` via ${submission.endpoint}` : ""}\n`);

  // --- scanner config (in-memory; snapshotted into the run dir) -----------
  const config = {
    deadlineSecs: 300,
    defaultSlippageBps: 100,
    defaultMinProfitWei: "0",
    wrappedNativeAsset: market.asset,
    // F1 fix: price gas at max(feeData, floor). Sepolia's default floor is
    // 2 gwei — the price the live trade in run 8 actually paid — so the
    // gate can never approve a money-losing cycle (RESULTS.md F1/F4).
    gasPriceFloorWei: process.env.GAS_PRICE_FLOOR_WEI || (isSepolia ? "2000000000" : "0"),
    // Campaign knob (see header): NET_PROFIT_ON_CHAIN=false keeps the
    // on-chain minProfit at the gross floor — a deliberate, recorded
    // relaxation for volume runs.
    netProfitOnChain: process.env.NET_PROFIT_ON_CHAIN !== "false",
    submitRpcUrl: process.env.SUBMIT_RPC_URL || "",
    opportunities: [
      {
        id: `${network}-${market.venueA.name}-vs-${market.venueB.name}`,
        borrowAsset: market.asset,
        amountIn: market.amountIn.toString(),
        minProfitWei: "0",
        slippageBps: 100,
        legs: [
          { router: market.venueA.router, path: [market.asset, market.mid] },
          { router: market.venueB.router, path: [market.mid, market.asset] },
        ],
      },
    ],
  };
  require("fs").writeFileSync(
    run.configFile,
    JSON.stringify({ ...config, engineAddress: market.engineAddress, routeStrategyAddress: market.strategyAddress }, null, 2)
  );

  // --- scan cycles --------------------------------------------------------
  const scanArgs = {
    provider: ethers.provider,
    signer: submission.signer,
    engineAddress: market.engineAddress,
    strategyAddress: market.strategyAddress,
    config,
  };

  const snapshot = (phase) =>
    snapshotHoldings({
      provider: ethers.provider,
      signer: deployer,
      engineAddress: market.engineAddress,
      asset: market.asset,
      mid: market.mid,
      phase,
    });

  for (let i = 1; i <= dryCycles; i++) {
    log(`== dry-run cycle ${i}/${dryCycles} ==`);
    const t0 = Date.now();
    try {
      const items = await scanOnce({ ...scanArgs, send: false });
      run.record("cycle", { cycleIndex: i, mode: "dry", durationMs: Date.now() - t0, items });
    } catch (err) {
      const msg = String(err?.shortMessage ?? err?.message ?? err).split("\n")[0].slice(0, 300);
      onHurdle({ stage: `dry-cycle-${i}`, error: msg, resolution: "cycle-aborted-continuing" });
    }
  }

  let confirmedSends = 0;
  let stopReason = null;

  for (let i = 1; i <= sendCycles; i++) {
    // Balance guard: never spend the signer past the reserved floor.
    try {
      const ethNow = await ethers.provider.getBalance(deployer.address);
      if (ethNow < abortBelowWei) {
        stopReason = `eth-below-abort-threshold (${ethers.formatEther(ethNow)} < ${ethers.formatEther(abortBelowWei)} ETH)`;
        run.record("stop", { reason: stopReason, cycle: i, ethWei: ethNow.toString() });
        log(`== stop: ${stopReason} ==`);
        break;
      }
    } catch (err) {
      onHurdle({
        stage: `balance-check-${i}`,
        error: String(err?.message ?? err).split("\n")[0].slice(0, 200),
        resolution: "balance-check-failed-continuing",
      });
    }

    run.record("holdings", await snapshot(`pre-send-${i}`));

    // Campaign mode: re-create the price gap before EVERY send cycle so the
    // scanner finds the opportunity again instead of refusing a converged
    // market (F2: that refusal is the correct behavior otherwise).
    if (restoreEnabled) {
      log(`== gap restore (before send cycle ${i}/${sendCycles}) ==`);
      try {
        await restoreGap({ deployer, market, log, record: run.record, onHurdle });
      } catch (err) {
        onHurdle({
          stage: `restore-${i}`,
          error: String(err?.shortMessage ?? err?.message ?? err).split("\n")[0].slice(0, 200),
          resolution: "restore-failed-continuing",
        });
      }
    }

    log(`== send cycle ${i}/${sendCycles} ==`);
    const t0 = Date.now();
    try {
      const items = await scanOnce({ ...scanArgs, send: true });
      run.record("cycle", { cycleIndex: i, mode: "send", durationMs: Date.now() - t0, items });
      if (items.some((it) => it.txHash && it.status === "confirmed")) confirmedSends += 1;
    } catch (err) {
      const msg = String(err?.shortMessage ?? err?.message ?? err).split("\n")[0].slice(0, 300);
      run.record("cycle", {
        cycleIndex: i,
        mode: "send",
        durationMs: Date.now() - t0,
        items: [],
        aborted: true,
        error: msg,
      });
      onHurdle({ stage: `send-cycle-${i}`, error: msg, resolution: "cycle-aborted-continuing" });
    }

    run.record("holdings", await snapshot(`post-send-${i}`));
  }

  if (!stopReason) {
    stopReason = "campaign-complete";
    run.record("stop", { reason: stopReason, sendCycles, confirmedCycles: confirmedSends });
  }
  run.record("holdings", await snapshot("final"));

  // --- ledger + report ----------------------------------------------------
  // Public RPCs can serve eth_getLogs from a node whose head lags our own
  // txs (observed: "requested N, head N-1"). Retry, then degrade gracefully —
  // the report must never be lost to a transient log-fetch failure.
  log("\n== ledger ==");
  const ledgerFromBlock = Number(process.env.LEDGER_FROM_BLOCK || deployBlock);
  let pnl = null;
  let ledgerErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      pnl = await fetchPnl({
        provider: ethers.provider,
        engineAddress: market.engineAddress,
        fromBlock: ledgerFromBlock,
      });
      break;
    } catch (err) {
      ledgerErr = String(err?.shortMessage ?? err?.message ?? err).split("\n")[0];
      log(`ledger attempt ${attempt}/4 failed: ${ledgerErr}`);
      onHurdle({
        stage: `ledger-attempt-${attempt}`,
        error: ledgerErr,
        resolution: attempt < 4 ? "retrying-in-10s" : "ledger-unavailable-continuing",
      });
      if (attempt < 4) {
        log("  waiting 10s for the RPC head to catch up...");
        await new Promise((r) => setTimeout(r, 10000));
      }
    }
  }
  if (pnl) {
    run.record("ledger", { pnl, fromBlock: ledgerFromBlock });
  } else {
    run.record("ledger-error", { error: ledgerErr, fromBlock: ledgerFromBlock });
    log(`ledger unavailable after 4 attempts: ${ledgerErr}`);
    log("continuing — the report is generated from the recorded cycles");
  }

  const engine = new ethers.Contract(
    market.engineAddress,
    ["function getBalance(address) view returns (uint256)"],
    ethers.provider
  );
  let realized = null;
  try {
    realized = await engine.getBalance(market.asset);
    run.record("realized", { asset: market.asset, engineBalanceWei: realized.toString() });
  } catch (err) {
    run.record("realized", { error: String(err?.message ?? err).split("\n")[0].slice(0, 200) });
  }

  const entries = readEntries(run.file);
  const { summary, csvFile, mdFile } = writeArtifacts(run, entries);

  log(`opportunities evaluated : ${summary.opportunitiesEvaluated}`);
  log(`profitable              : ${summary.profitable}`);
  log(`tx sent                 : ${summary.sent} (confirmed ${summary.confirmed}, reverted ${summary.reverted})`);
  log(`errors                  : ${summary.errors}`);
  log(`hurdles recorded        : ${summary.hurdles.length}`);
  log(
    `gap restores            : ${summary.restores.swaps} swap(s), ${summary.restores.skips} skip(s), ` +
      `${summary.restores.capped} capped, ${summary.restores.failed} failed`
  );
  log(`realized profit         : ${summary.grossProfitWei} wei (confirmed trades)`);
  log(`potential profit        : ${summary.potentialProfitWei} wei (dry-run / unconfirmed)`);
  log(`gas spent (actual)      : ${summary.gasSpentWei} wei`);
  log(`avg confirmation        : ${summary.avgConfirmMs ?? "n/a"} ms`);
  log(
    `engine realized balance : ${realized === null ? "n/a (read failed)" : ethers.formatEther(realized)} ` +
      `(${market.asset})`
  );
  log(
    `eth spent (start - end) : ${summary.ethSpentWei === null ? "n/a" : ethers.formatEther(summary.ethSpentWei)} ETH`
  );
  log(`true net (gross - gas)  : ${summary.netAfterAllGasWei} wei (${ethers.formatEther(summary.netAfterAllGasWei)} asset)`);
  log(`stop reason             : ${stopReason}`);
  log("");
  log(`jsonl : ${run.file}`);
  log(`csv   : ${csvFile}`);
  log(`report: ${mdFile}`);

  if (summary.errors > 0 && summary.confirmed === 0 && sendCycles > 0) {
    throw new Error(
      `no trade confirmed and ${summary.errors} errors recorded — see ${run.file} for causes`
    );
  }
}

main().catch((err) => {
  console.error(err?.shortMessage ?? err?.message ?? err);
  process.exitCode = 1;
});
