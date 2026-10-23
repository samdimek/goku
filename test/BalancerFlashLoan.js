const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const PREMIUM_BPS = 5n; // same fee the mock vault can charge via setFeeBps

const encodeRoute = (r) =>
  ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(address,address[],address,address[],uint256,uint256,uint256)"],
    [[r.routerA, r.pathA, r.routerB, r.pathB, r.minAmountOutA, r.minAmountOutB, r.deadline]]
  );

async function baseFixture() {
  const [deployer, keeper, stranger, profitWallet] = await ethers.getSigners();

  const MockVault = await ethers.getContractFactory("MockBalancerVault");
  const vault = await MockVault.deploy();

  const Token = await ethers.getContractFactory("MockERC20");
  const asset = await Token.deploy("Mock USD", "mUSD", 18);
  const tokenB = await Token.deploy("Mock Token B", "mB", 18);

  const Engine = await ethers.getContractFactory("BalancerFlashLoan");
  const engine = await Engine.deploy(await vault.getAddress(), profitWallet.address);

  const MockStrategy = await ethers.getContractFactory("MockStrategy");
  const mockStrategy = await MockStrategy.deploy(await engine.getAddress());
  await engine.registerStrategy(await mockStrategy.getAddress(), true);

  const RouteStrategy = await ethers.getContractFactory("DexRouteArbStrategy");
  const routeStrategy = await RouteStrategy.deploy(await engine.getAddress());
  await engine.registerStrategy(await routeStrategy.getAddress(), true);

  const Router = await ethers.getContractFactory("MockRouter");
  const routerA = await Router.deploy();
  const routerB = await Router.deploy();

  // Liquidity: the vault must be able to lend.
  await asset.mint(await vault.getAddress(), E(1000000));
  // MockStrategy is prefunded so it can "return" principal + simulated profit.
  await asset.mint(await mockStrategy.getAddress(), E(10000));

  return {
    deployer,
    keeper,
    stranger,
    profitWallet,
    vault,
    asset,
    tokenB,
    engine,
    mockStrategy,
    routeStrategy,
    routerA,
    routerB,
  };
}

describe("BalancerFlashLoan engine", function () {
  describe("Loan lifecycle", function () {
    it("borrows, runs the strategy, repays the Vault and forwards the entire profit to the profit wallet", async function () {
      const { engine, asset, vault, mockStrategy, profitWallet } = await loadFixture(baseFixture);
      const amount = E(1000);
      const simulateProfit = E(10);
      const minProfit = E(5);
      await mockStrategy.setSimulateProfit(simulateProfit);

      const vaultBefore = await asset.balanceOf(await vault.getAddress());
      const walletBefore = await asset.balanceOf(profitWallet.address);

      const tx = engine.requestFlashLoan(
        await asset.getAddress(),
        amount,
        await mockStrategy.getAddress(),
        minProfit,
        "0x"
      );
      await expect(tx).to.emit(engine, "FlashLoanRequested");
      await expect(tx)
        .to.emit(engine, "FlashLoanExecuted")
        .withArgs(await asset.getAddress(), amount, 0, simulateProfit, await mockStrategy.getAddress());
      await expect(tx)
        .to.emit(engine, "ProfitSwept")
        .withArgs(await asset.getAddress(), profitWallet.address, simulateProfit);
      // Also Withdrawn so the P&L ledger nets `retained` correctly unchanged.
      await expect(tx)
        .to.emit(engine, "Withdrawn")
        .withArgs(await asset.getAddress(), profitWallet.address, simulateProfit);

      // Profit wallet got the whole surplus; the engine retains nothing.
      expect(await asset.balanceOf(profitWallet.address)).to.equal(walletBefore + simulateProfit);
      expect(await engine.getBalance(await asset.getAddress())).to.equal(0);
      // Vault was repaid principal + 0 fee (Balancer's standing fee setting).
      expect(await asset.balanceOf(await vault.getAddress())).to.equal(vaultBefore);
    });

    it("honors a nonzero fee from feeAmounts: profit is net of the fee, the Vault keeps it", async function () {
      const { engine, asset, vault, mockStrategy, profitWallet } = await loadFixture(baseFixture);
      await vault.setFeeBps(PREMIUM_BPS); // 0.05% -> 0.5 on 1000
      await mockStrategy.setSimulateProfit(E(10));

      const amount = E(1000);
      const fee = (amount * PREMIUM_BPS) / 10000n; // 0.5
      const vaultBefore = await asset.balanceOf(await vault.getAddress());

      const tx = engine.requestFlashLoan(
        await asset.getAddress(),
        amount,
        await mockStrategy.getAddress(),
        E(1), // minProfit below net profit (10 - 0.5)
        "0x"
      );
      await expect(tx)
        .to.emit(engine, "FlashLoanExecuted")
        .withArgs(await asset.getAddress(), amount, fee, E(10) - fee, await mockStrategy.getAddress());

      // Wallet: simulateProfit - fee. Vault: +fee. Engine: 0.
      expect(await asset.balanceOf(profitWallet.address)).to.equal(E(10) - fee);
      expect(await asset.balanceOf(await vault.getAddress())).to.equal(vaultBefore + fee);
      expect(await engine.getBalance(await asset.getAddress())).to.equal(0);
    });

    it("zero-profit, zero-fee loan completes and forwards nothing (off-chain gate refuses to send these)", async function () {
      const { engine, asset, mockStrategy, profitWallet } = await loadFixture(baseFixture);
      await mockStrategy.setSimulateProfit(0);

      await expect(
        engine.requestFlashLoan(
          await asset.getAddress(),
          E(1000),
          await mockStrategy.getAddress(),
          0,
          "0x"
        )
      ).to.emit(engine, "FlashLoanExecuted");
      expect(await asset.balanceOf(profitWallet.address)).to.equal(0);
      expect(await engine.getBalance(await asset.getAddress())).to.equal(0);
    });

    it("reverts atomically when the trade cannot cover the fee", async function () {
      const { engine, asset, vault, mockStrategy } = await loadFixture(baseFixture);
      await vault.setFeeBps(PREMIUM_BPS);
      await mockStrategy.setSimulateProfit(0); // returns principal only

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
      await mockStrategy.setSimulateProfit(E(1));

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

  describe("Callback guards", function () {
    it("rejects receiveFlashLoan from anyone but the Vault", async function () {
      const { engine, asset, stranger } = await loadFixture(baseFixture);
      await expect(
        engine
          .connect(stranger)
          .receiveFlashLoan([await asset.getAddress()], [1], [1], "0x")
      ).to.be.revertedWithCustomError(engine, "NotVault");
    });

    it("rejects callbacks when no loan of ours is in flight", async function () {
      const { engine, asset, vault } = await loadFixture(baseFixture);
      // The mock Vault IS msg.sender, but the engine never started a loan.
      await expect(
        vault.invokeReceive(engine, [await asset.getAddress()], [1], [0], "0x")
      ).to.be.revertedWithCustomError(engine, "NotInFlashLoan");
    });

    it("rejects multi-token loan shapes (single-asset engine)", async function () {
      const { engine, asset, tokenB, vault } = await loadFixture(baseFixture);
      await expect(
        vault.invokeReceive(
          engine,
          [await asset.getAddress(), await tokenB.getAddress()],
          [1, 1],
          [0, 0],
          "0x"
        )
      ).to.be.revertedWithCustomError(engine, "BadLoanShape");
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

    it("only the owner manages registry, pause, keeper, floor and profit recipient", async function () {
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
      await expect(engine.connect(stranger).setMinProfitFloor(1)).to.be.revertedWithCustomError(
        engine,
        "NotOwner"
      );
      await expect(engine.connect(stranger).setProfitRecipient(stranger.address)).to.be
        .revertedWithCustomError(engine, "NotOwner");
      await engine.setMinProfitFloor(E(1));
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

  describe("Profit recipient wiring", function () {
    it("constructor requires a vault and a profit wallet", async function () {
      const { vault, profitWallet } = await loadFixture(baseFixture);
      const Engine = await ethers.getContractFactory("BalancerFlashLoan");
      await expect(Engine.deploy(ethers.ZeroAddress, profitWallet.address)).to.be.revertedWithCustomError(
        Engine,
        "ZeroAddress"
      );
      await expect(Engine.deploy(await vault.getAddress(), ethers.ZeroAddress)).to.be.revertedWithCustomError(
        Engine,
        "ZeroAddress"
      );
      // A vault address with no code (typo'd address) fails at deploy time.
      await expect(
        Engine.deploy(await profitWallet.getAddress(), profitWallet.address)
      ).to.be.revertedWithCustomError(Engine, "NotContract");
    });

    it("setProfitRecipient redirects future profit and rejects zero", async function () {
      const { engine, asset, mockStrategy, stranger } = await loadFixture(baseFixture);
      await mockStrategy.setSimulateProfit(E(10));

      // First trade: default recipient (profitWallet) — asserted in lifecycle.
      await engine.setProfitRecipient(stranger.address);
      await expect(engine.setProfitRecipient(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        engine,
        "ZeroAddress"
      );

      await engine.requestFlashLoan(
        await asset.getAddress(),
        E(100),
        await mockStrategy.getAddress(),
        0,
        "0x"
      );
      expect(await asset.balanceOf(stranger.address)).to.equal(E(10));
      expect(await engine.getBalance(await asset.getAddress())).to.equal(0);
    });

    it("withdraw rescues stray balances to the profit wallet (owner only)", async function () {
      const { engine, asset, mockStrategy, stranger, profitWallet } = await loadFixture(baseFixture);
      // Simulate a stray balance (e.g. a direct transfer) with zero profit path.
      await asset.mint(await engine.getAddress(), E(3));

      await expect(engine.connect(stranger).withdraw(await asset.getAddress())).to.be.revertedWithCustomError(
        engine,
        "NotOwner"
      );
      await expect(engine.withdraw(await asset.getAddress()))
        .to.emit(engine, "Withdrawn")
        .withArgs(await asset.getAddress(), profitWallet.address, E(3));
      expect(await asset.balanceOf(profitWallet.address)).to.equal(E(3));
      expect(await engine.getBalance(await asset.getAddress())).to.equal(0);
      // A second withdraw is a no-op sweep of zero.
      await expect(engine.withdraw(await asset.getAddress())).to.not.be.reverted;
      void mockStrategy;
    });
  });
});

describe("DexRouteArbStrategy on the Balancer engine", function () {
  async function routeFixture() {
    const base = await baseFixture();
    const { routeStrategy, routerA, routerB, asset, tokenB } = base;

    await routeStrategy.setTrustedRouter(await routerA.getAddress(), true);
    await routeStrategy.setTrustedRouter(await routerB.getAddress(), true);

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

  it("executes a two-leg cross-DEX cycle and forwards the profit in the same tx", async function () {
    const { engine, asset, route, routeStrategy, routerB, profitWallet } = await loadFixture(routeFixture);
    await routerB.setBonusBps(200); // 2% round trip, zero Balancer fee

    const amount = E(1000);
    const expectedOut = amount + (amount * 200n) / 10000n; // 1020

    await expect(
      engine.requestFlashLoan(
        await asset.getAddress(),
        amount,
        await routeStrategy.getAddress(),
        0,
        encodeRoute(route)
      )
    )
      .to.emit(engine, "FlashLoanExecuted")
      .withArgs(await asset.getAddress(), amount, 0, expectedOut - amount, await routeStrategy.getAddress());

    // The whole surplus landed in the profit wallet, engine kept nothing.
    expect(await asset.balanceOf(profitWallet.address)).to.equal(expectedOut - amount);
    expect(await engine.getBalance(await asset.getAddress())).to.equal(0);
  });

  it("reverts the whole loan when the route is unprofitable", async function () {
    const { engine, asset, route, routeStrategy } = await loadFixture(routeFixture);
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
});
