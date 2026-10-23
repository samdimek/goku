const hre = require("hardhat");

// Aave V3 PoolAddressesProvider per network.
// Override with POOL_ADDRESSES_PROVIDER for forks/tests/new markets.
// Sources: https://aave.com/docs + github.com/aave-dao/aave-address-book
// All addresses below verified on-chain against the live network RPC
// (getCode + getPool() + FLASHLOAN_PREMIUM_TOTAL) before being pinned.
const ADDRESSES_PROVIDER = {
  arbitrum: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb", // Aave V3 Arbitrum One (Pool 0x794a61358D6845594F94dc1DB02A252b5b4814aD, premium 5 bps, WETH TVL ~97.6k)
  sepolia: "0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A", // Aave V3 Sepolia market
  mainnet: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e", // Aave V3 Ethereum mainnet
};

async function resolveAddressesProvider(deployer) {
  if (process.env.POOL_ADDRESSES_PROVIDER) {
    return process.env.POOL_ADDRESSES_PROVIDER;
  }
  const preset = ADDRESSES_PROVIDER[hre.network.name];
  if (preset) return preset;

  // Local hardhat network: stand in for Aave with a mock provider so the
  // deploy flow is runnable offline.
  const MockProvider = await hre.ethers.getContractFactory("MockPoolAddressesProvider");
  const mock = await MockProvider.deploy(deployer.address);
  await mock.waitForDeployment();
  const address = await mock.getAddress();
  console.log("MockPoolAddressesProvider deployed (local network):", address);
  return address;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Network: ", hre.network.name);
  console.log("Deployer:", deployer.address);

  const providerAddress = await resolveAddressesProvider(deployer);

  const FlashLoan = await hre.ethers.getContractFactory("FlashLoan");
  const engine = await FlashLoan.deploy(providerAddress);
  await engine.waitForDeployment();
  const engineAddress = await engine.getAddress();
  console.log("FlashLoan engine deployed:   ", engineAddress);

  // Strategy modules: the engine only accepts funds routed through these.
  const RouteStrategy = await hre.ethers.getContractFactory("DexRouteArbStrategy");
  const routeStrategy = await RouteStrategy.deploy(engineAddress);
  await routeStrategy.waitForDeployment();
  const routeAddress = await routeStrategy.getAddress();

  const CalldataStrategy = await hre.ethers.getContractFactory("CalldataArbStrategy");
  const calldataStrategy = await CalldataStrategy.deploy(engineAddress);
  await calldataStrategy.waitForDeployment();
  const calldataAddress = await calldataStrategy.getAddress();

  await (await engine.registerStrategy(routeAddress, true)).wait();
  await (await engine.registerStrategy(calldataAddress, true)).wait();

  console.log("DexRouteArbStrategy:         ", routeAddress);
  console.log("CalldataArbStrategy:         ", calldataAddress);
  console.log("");
  console.log("Next steps (owner only):");
  console.log("  routeStrategy.setTrustedRouter(<dex router>, true)   // per venue");
  console.log("  calldataStrategy.setTrustedTarget(<agg executor>, true)");
  console.log("  engine.setKeeper(<bot EOA>, true)                    // optional");
  console.log("  engine.setMinProfitFloor(<wei floor>, ...)           // optional");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});