const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const PREMIUM_BPS = 5n; // matches MockPool.premiumBps

// The strategy decodes with abi.decode(params, (RouteParams)), i.e. a single
// dynamic tuple: encode one tuple-typed value, not a bare field sequence.
const encodeRoute = (r) =>
  ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(address,address[],address,address[],uint256,uint256,uint256)"],
    [[r.routerA, r.pathA, r.routerB, r.pathB, r.minAmountOutA, r.minAmountOutB, r.deadline]]
  );

const encodeCalldata = (target, data) =>
  ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes"], [target, data]);

async function baseFixture() {
  const [deployer, keeper, stranger] = await ethers.getSigners();

  const MockPool = await ethers.getContractFactory("MockPool");
  const pool = await MockPool.deploy();

  const Provider = await ethers.getContractFactory("MockPoolAddressesProvider");
  const provider = await Provider.deploy(await pool.getAddress());

  const Token = await ethers.getContractFactory("MockERC20");
  const asset = await Token.deploy("Mock USD", "mUSD", 18);
  const tokenB = await Token.deploy("Mock Token B", "mB", 18);

  const Engine = await ethers.getContractFactory("FlashLoan");
  const engine = await Engine.deploy(await provider.getAddress());

  const MockStrategy = await ethers.getContractFactory("MockStrategy");
  const mockStrategy = await MockStrategy.deploy(await engine.getAddress());
  await engine.registerStrategy(await mockStrategy.getAddress(), true);

  const RouteStrategy = await ethers.getContractFactory("DexRouteArbStrategy");
  const routeStrategy = await RouteStrategy.deploy(await engine.getAddress());
  await engine.registerStrategy(await routeStrategy.getAddress(), true);

  const CalldataStrategy = await ethers.getContractFactory("CalldataArbStrategy");
  const calldataStrategy = await CalldataStrategy.deploy(await engine.getAddress());
  await engine.registerStrategy(await calldataStrategy.getAddress(), true);

  const Router = await ethers.getContractFactory("MockRouter");
  const routerA = await Router.deploy();
  const routerB = await Router.deploy();

  // Liquidity: the pool must be able to lend and collect the premium.
  await asset.mint(await pool.getAddress(), E(1000000));
  // MockStrategy is prefunded so it can "return" principal + simulated profit.
  await asset.mint(await mockStrategy.getAddress(), E(10000));

  return {
    deployer,
    keeper,
    stranger,
    pool,
    provider,
    asset,
    tokenB,
    engine,
    mockStrategy,
    routeStrategy,
    calldataStrategy,
    routerA,
    routerB,
  };
}

describe("FlashLoan engine", function () {
  describe("Loan lifecycle", function () {
    it("borrows, runs the strategy, repays and keeps the profit", async function () {
      const { engine, asset, pool, mockStrategy } = await loadFixture(baseFixture);
      const amount = E(1000);
      const profit = E(10); // simulated arb profit from the strategy
      const minProfit = E(5);
      await mockStrategy.setSimulateProfit(profit);

      const poolBefore = await asset.balanceOf(await pool.getAddress());
      const premium = (amount * PREMIUM_BPS) / 10000n;

      await expect(
        engine.requestFlashLoan(
          await asset.getAddress(),
          amount,
          await mockStrategy.getAddress(),
          minProfit,
          "0x"
        )
      )
        .to.emit(engine, "FlashLoanRequested")
        .and.to.emit(engine, "FlashLoanExecuted");

      // profit - premium remains in the engine
      expect(await engine.getBalance(await asset.getAddress())).to.equal(profit - premium);
      // pool collected principal back + premium
      expect(await asset.balanceOf(await pool.getAddress())).to.equal(poolBefore + premium);
      // repayment pulled the full approved amount
      expect(await asset.allowance(await engine.getAddress(), await pool.getAddress())).to.equal(0);
    });

    it("reverts atomically when the trade is unprofitable", async function () {
      const { engine, asset, mockStrategy } = await loadFixture(baseFixture);
      await mockStrategy.setSimulateProfit(0); // no profit to cover the premium

      await expect(
        engine.requestFlashLoan(
          await asset.getAddress(),
          E(1000),
          await mockStrategy.getAddress(),
          0,
          "0x"
        )
      ).to.be.revertedWithCustomError(engine, "Unprofitable");
    });

    it("reverts when profit is positive but below minProfit", async function () {
      const { engine, asset, mockStrategy } = await loadFixture(baseFixture);
      await mockStrategy.setSimulateProfit(E(1)); // covers premium (0.5) but not minProfit (2)

      await expect(
        engine.requestFlashLoan(
          await asset.getAddress(),
          E(1000),
          await mockStrategy.getAddress(),
          E(2),
          "0x"
        )
      ).to.be.revertedWithCustomError(engine, "Unprofitable");
    });
  });

  describe("Access control", function () {
    it("rejects executeOperation from anyone but the pool", async function () {
      const { engine, asset, stranger } = await loadFixture(baseFixture);
      await expect(
        engine
          .connect(stranger)
          .executeOperation(await asset.getAddress(), 1, 1, stranger.address, "0x")
      ).to.be.revertedWithCustomError(engine, "NotPool");
    });

    it("rejects callbacks that this contract did not initiate", async function () {
      const { engine, asset, pool } = await loadFixture(baseFixture);
      const params = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [ethers.Wallet.createRandom().address, 0, "0x"]
      );
      // pool forwards the call, so msg.sender == POOL but initiator != engine
      await expect(
        pool.invokeExecute(
          await engine.getAddress(),
          await asset.getAddress(),
          1,
          1,
          ethers.Wallet.createRandom().address,
          params
        )
      ).to.be.revertedWithCustomError(engine, "BadInitiator");
    });

    it("rejects callbacks outside an active loan", async function () {
      const { engine, asset, pool } = await loadFixture(baseFixture);
      const params = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [ethers.Wallet.createRandom().address, 0, "0x"]
      );
      await expect(
        pool.invokeExecute(
          await engine.getAddress(),
          await asset.getAddress(),
          1,
          1,
          await engine.getAddress(), // initiator is correct...
          params
        )
      ).to.be.revertedWithCustomError(engine, "NotInFlashLoan"); // ...but no loan is running
    });

    it("only owner/keeper can request loans; strangers cannot", async function () {
      const { engine, asset, mockStrategy, stranger } = await loadFixture(baseFixture);
      await expect(
        engine
          .connect(stranger)
          .requestFlashLoan(await asset.getAddress(), E(1), await mockStrategy.getAddress(), 0, "0x")
      ).to.be.revertedWithCustomError(engine, "NotAuthorized");
    });

    it("an allowlisted keeper may trigger loans", async function () {
      const { engine, asset, mockStrategy, keeper } = await loadFixture(baseFixture);
      await engine.setKeeper(keeper.address);
      await mockStrategy.setSimulateProfit(E(10));
      await expect(
        engine
          .connect(keeper)
          .requestFlashLoan(await asset.getAddress(), E(10), await mockStrategy.getAddress(), 0, "0x")
      ).to.emit(engine, "FlashLoanExecuted");
    });

    it("only the owner can withdraw", async function () {
      const { engine, asset, mockStrategy, stranger } = await loadFixture(baseFixture);
      await mockStrategy.setSimulateProfit(E(10));
      await engine.requestFlashLoan(
        await asset.getAddress(),
        E(10),
        await mockStrategy.getAddress(),
        0,
        "0x"
      );
      const engineAddress = await engine.getAddress();
      const ownerAddress = await engine.owner();
      const engineBalance = await engine.getBalance(await asset.getAddress());
      expect(engineBalance).to.be.greaterThan(0);

      await expect(
        engine.connect(stranger).withdraw(await asset.getAddress())
      ).to.be.revertedWithCustomError(engine, "NotOwner");

      await expect(engine.withdraw(await asset.getAddress())).to.changeTokenBalances(
        asset,
        [engineAddress, ownerAddress],
        [-engineBalance, engineBalance]
      );
    });

    it("only the owner manages registry, pause, keeper and floor", async function () {
      const { engine, asset, mockStrategy, stranger } = await loadFixture(baseFixture);
      await expect(engine.connect(stranger).registerStrategy(await asset.getAddress(), true)).to.be
        .revertedWithCustomError(engine, "NotOwner");
      await expect(engine.connect(stranger).setPaused(true)).to.be.revertedWithCustomError(
        engine,
        "NotOwner"
      );
      await expect(engine.connect(stranger).setKeeper(stranger.address)).to.be.revertedWithCustomError(
        engine,
        "NotOwner"
      );
      await expect(engine.setMinProfitFloor(E(1))).to.not.be.reverted;

      // floor is enforced on requests
      await expect(
        engine.requestFlashLoan(await asset.getAddress(), E(10), await mockStrategy.getAddress(), 0, "0x")
      ).to.be.revertedWithCustomError(engine, "ProfitBelowFloor");
    });

    it("only registered strategies can receive the loan", async function () {
      const { engine, asset } = await loadFixture(baseFixture);
      const MockStrategy = await ethers.getContractFactory("MockStrategy");
      const unregistered = await MockStrategy.deploy(await engine.getAddress());
      await expect(
        engine.requestFlashLoan(await asset.getAddress(), E(10), await unregistered.getAddress(), 0, "0x")
      ).to.be.revertedWithCustomError(engine, "UnregisteredStrategy");
    });

    it("rejects zero asset and zero amount", async function () {
      const { engine, asset, mockStrategy } = await loadFixture(baseFixture);
      await expect(
        engine.requestFlashLoan(ethers.ZeroAddress, E(1), await mockStrategy.getAddress(), 0, "0x")
      ).to.be.revertedWithCustomError(engine, "ZeroAddress");
      await expect(
        engine.requestFlashLoan(await asset.getAddress(), 0, await mockStrategy.getAddress(), 0, "0x")
      ).to.be.revertedWithCustomError(engine, "ZeroAmount");
    });

    it("pauses and unpauses loans", async function () {
      const { engine, asset, mockStrategy } = await loadFixture(baseFixture);
      await engine.setPaused(true);
      await expect(
        engine.requestFlashLoan(await asset.getAddress(), E(1), await mockStrategy.getAddress(), 0, "0x")
      ).to.be.revertedWithCustomError(engine, "ContractPaused");
      await engine.setPaused(false);
      await mockStrategy.setSimulateProfit(E(10));
      await expect(
        engine.requestFlashLoan(await asset.getAddress(), E(1), await mockStrategy.getAddress(), 0, "0x")
      ).to.not.be.reverted;
    });

    it("transfers ownership", async function () {
      const { engine, stranger } = await loadFixture(baseFixture);
      await expect(engine.transferOwnership(stranger.address)).to.emit(
        engine,
        "OwnershipTransferred"
      );
      expect(await engine.owner()).to.equal(stranger.address);
      // previous owner loses rights
      await expect(engine.setPaused(true)).to.be.revertedWithCustomError(engine, "NotOwner");
      await expect(engine.connect(stranger).setPaused(true)).to.not.be.reverted;
    });

    it("rejects registration of the zero address", async function () {
      const { engine } = await loadFixture(baseFixture);
      await expect(engine.registerStrategy(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(
        engine,
        "ZeroAddress"
      );
    });
  });
});

describe("DexRouteArbStrategy", function () {
  async function routeFixture() {
    const base = await baseFixture();
    const { routeStrategy, routerA, routerB, asset, tokenB } = base;

    await routeStrategy.setTrustedRouter(await routerA.getAddress(), true);
    await routeStrategy.setTrustedRouter(await routerB.getAddress(), true);

    // Seed venue liquidity: A holds tokenB, B holds asset.
    await tokenB.mint(await routerA.getAddress(), E(100000));
    await asset.mint(await routerB.getAddress(), E(100000));

    const route = {
      routerA: await routerA.getAddress(),
      pathA: [await asset.getAddress(), await tokenB.getAddress()],
      routerB: await routerB.getAddress(),
      pathB: [await tokenB.getAddress(), await asset.getAddress()],
      minAmountOutA: 0,
      minAmountOutB: 0,
      deadline: 10 ** 12,
    };
    return { ...base, route };
  }

  it("executes a two-leg cross-DEX cycle and keeps the profit", async function () {
    const { engine, asset, route, routeStrategy, routerB } = await loadFixture(routeFixture);
    // Router B pays a 2% bonus on the way back -> covers 0.05% premium + profit
    await routerB.setBonusBps(200);

    const amount = E(1000);
    const premium = (amount * PREMIUM_BPS) / 10000n;
    const expectedOut = amount + (amount * 200n) / 10000n; // 1020

    await expect(
      engine.requestFlashLoan(
        await asset.getAddress(),
        amount,
        await routeStrategy.getAddress(),
        0,
        encodeRoute(route)
      )
    ).to.emit(engine, "FlashLoanExecuted");

    // profit = 1020 - 1000 - 0.5 premium
    expect(await engine.getBalance(await asset.getAddress())).to.equal(
      expectedOut - amount - premium
    );
  });

  it("reverts the whole loan when the route is unprofitable", async function () {
    const { engine, asset, route, routeStrategy, routerB } = await loadFixture(routeFixture);
    await routerB.setBonusBps(10); // 0.1% < premium 0.05% + gas…: below minProfit of 1
    await expect(
      engine.requestFlashLoan(
        await asset.getAddress(),
        E(1000),
        await routeStrategy.getAddress(),
        E(1),
        encodeRoute(route)
      )
    ).to.be.revertedWithCustomError(engine, "Unprofitable");
  });

  it("rejects untrusted routers", async function () {
    const { engine, asset, route, routeStrategy, stranger } = await loadFixture(routeFixture);
    const badRoute = { ...route, routerB: stranger.address };
    await expect(
      engine.requestFlashLoan(
        await asset.getAddress(),
        E(10),
        await routeStrategy.getAddress(),
        0,
        encodeRoute(badRoute)
      )
    ).to.be.revertedWithCustomError(routeStrategy, "UntrustedRouter");
  });

  it("rejects routes that do not start/end in the borrowed asset", async function () {
    const { engine, asset, tokenB, route, routeStrategy } = await loadFixture(routeFixture);
    const wrongStart = {
      ...route,
      pathA: [await tokenB.getAddress(), await asset.getAddress()],
    };
    await expect(
      engine.requestFlashLoan(
        await asset.getAddress(),
        E(10),
        await routeStrategy.getAddress(),
        0,
        encodeRoute(wrongStart)
      )
    ).to.be.revertedWithCustomError(routeStrategy, "BadPathStart");

    const wrongEnd = {
      ...route,
      pathB: [await asset.getAddress(), await tokenB.getAddress()],
    };
    await expect(
      engine.requestFlashLoan(
        await asset.getAddress(),
        E(10),
        await routeStrategy.getAddress(),
        0,
        encodeRoute(wrongEnd)
      )
    ).to.be.revertedWithCustomError(routeStrategy, "BadPathEnd");
  });

  it("rejects cycles whose legs do not connect (mid mismatch)", async function () {
    const { engine, asset, route, routeStrategy, tokenB } = await loadFixture(routeFixture);
    const Token = await ethers.getContractFactory("MockERC20");
    const tokenC = await Token.deploy("Mock Token C", "mC", 18);
    const broken = {
      ...route,
      pathA: [await asset.getAddress(), await tokenC.getAddress()],
      pathB: [await tokenB.getAddress(), await asset.getAddress()],
    };
    await expect(
      engine.requestFlashLoan(
        await asset.getAddress(),
        E(10),
        await routeStrategy.getAddress(),
        0,
        encodeRoute(broken)
      )
    ).to.be.revertedWithCustomError(routeStrategy, "MidMismatch");
  });

  it("only the engine can move its funds", async function () {
    const { routeStrategy, stranger, asset } = await loadFixture(routeFixture);
    await expect(
      routeStrategy.connect(stranger).execute(await asset.getAddress(), 1, "0x")
    ).to.be.revertedWithCustomError(routeStrategy, "NotEngine");
  });
});

describe("CalldataArbStrategy", function () {
  async function calldataFixture() {
    const base = await baseFixture();
    const { calldataStrategy, routerB, asset } = base;
    await calldataStrategy.setTrustedTarget(await routerB.getAddress(), true);
    await asset.mint(await routerB.getAddress(), E(100000));
    await routerB.setBonusBps(200); // 2% bonus when swapping back to asset
    return base;
  }

  it("executes allowlisted target calldata and keeps the profit", async function () {
    const { engine, asset, routerB, calldataStrategy } = await loadFixture(calldataFixture);
    const amount = E(1000);
    const premium = (amount * PREMIUM_BPS) / 10000n;
    const to = await calldataStrategy.getAddress();

    const data = routerB.interface.encodeFunctionData("swapExactTokensForTokens", [
      amount,
      0,
      [await asset.getAddress(), await asset.getAddress()], // in/out same asset: pure bonus leg
      to,
      10 ** 12,
    ]);
    const params = encodeCalldata(await routerB.getAddress(), data);

    await expect(
      engine.requestFlashLoan(
        await asset.getAddress(),
        amount,
        await calldataStrategy.getAddress(),
        0,
        params
      )
    ).to.emit(engine, "FlashLoanExecuted");

    const expectedOut = amount + (amount * 200n) / 10000n;
    expect(await engine.getBalance(await asset.getAddress())).to.equal(
      expectedOut - amount - premium
    );
  });

  it("rejects untrusted targets", async function () {
    const { engine, asset, routerA, calldataStrategy } = await loadFixture(calldataFixture);
    const data = routerA.interface.encodeFunctionData("swapExactTokensForTokens", [
      1,
      0,
      [await asset.getAddress(), await asset.getAddress()],
      ethers.ZeroAddress,
      10 ** 12,
    ]);
    const params = encodeCalldata(await routerA.getAddress(), data);
    await expect(
      engine.requestFlashLoan(
        await asset.getAddress(),
        E(10),
        await calldataStrategy.getAddress(),
        0,
        params
      )
    ).to.be.revertedWithCustomError(calldataStrategy, "UntrustedTarget");
  });

  it("only the engine can call execute", async function () {
    const { calldataStrategy, stranger, asset } = await loadFixture(calldataFixture);
    await expect(
      calldataStrategy.connect(stranger).execute(await asset.getAddress(), 1, "0x")
    ).to.be.revertedWithCustomError(calldataStrategy, "NotEngine");
  });
});