const hre = require("hardhat");

// Balancer V2 Vault — same canonical address on mainnet, Sepolia AND
// Arbitrum One (verified against github.com/balancer/balancer-deployments,
// task 20210418-vault + addresses/arbitrum.json; re-verified on-chain on
// Arbitrum: getCode ok, holding ~103.7 WETH of flash-loan liquidity).
// Override with BALANCER_VAULT for forks/tests/other networks.
const VAULT = {
  arbitrum: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", // Arbitrum One
  sepolia: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
  mainnet: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
};

// Profit wallet (instruction 5): taken BEFORE any execution, passed to the
// constructor, and the engine reverts at deploy time without it. Every
// trade's surplus is auto-forwarded here inside the same transaction.
// Override with PROFIT_RECIPIENT in .env (e.g. before rotating wallets).
const DEFAULT_PROFIT_RECIPIENT = "0xEfB4e57F8DD5d6b89C3f20aCc5Ad42Ff75b38910";

function resolveProfitRecipient() {
  const raw = (process.env.PROFIT_RECIPIENT || DEFAULT_PROFIT_RECIPIENT).trim();
  // ethers.getAddress both validates the hex and normalizes the checksum;
  // a typo'd address fails the deploy instead of silently misrouting profit.
  return hre.ethers.getAddress(raw);
}

async function resolveVault(deployer) {
  if (process.env.BALANCER_VAULT) return hre.ethers.getAddress(process.env.BALANCER_VAULT.trim());

  const preset = VAULT[hre.network.name];
  if (preset) {
    // Sanity: the configured network must actually have the Vault deployed.
    const code = await hre.ethers.provider.getCode(preset);
    if (!code || code === "0x") {
      throw new Error(
        `Balancer Vault ${preset} has no code on ${hre.network.name} — ` +
          `set BALANCER_VAULT to the right address for this network.`
      );
    }
    return preset;
  }

  // Local hardhat network: stand in with the mock Vault so the deploy flow
  // is runnable offline. It must be prefunded with the borrowed asset
  // before any loan can succeed (tests and demoLocal handle that).
  const MockVault = await hre.ethers.getContractFactory("MockBalancerVault");
  const mock = await MockVault.deploy();
  await mock.waitForDeployment();
  const address = await mock.getAddress();
  console.log("MockBalancerVault deployed (local network):", address);
  return address;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Network:  ", hre.network.name);
  console.log("Deployer: ", deployer.address);

  const vaultAddress = await resolveVault(deployer);
  const profitRecipient = resolveProfitRecipient();

  console.log("Vault:             ", vaultAddress);
  console.log("PROFIT WALLET      ", profitRecipient);

  const BalancerFlashLoan = await hre.ethers.getContractFactory("BalancerFlashLoan");
  const engine = await BalancerFlashLoan.deploy(vaultAddress, profitRecipient);
  await engine.waitForDeployment();
  const engineAddress = await engine.getAddress();
  console.log("BalancerFlashLoan deployed:", engineAddress);

  // Strategy modules bound to this engine (the Aave engine's modules are
  // separate contracts bound to that engine — strategies check msg.sender).
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

  console.log("DexRouteArbStrategy:", routeAddress);
  console.log("CalldataArbStrategy:", calldataAddress);
  console.log("");
  console.log("==========================================================");
  console.log(" Profit wallet (auto-forward target):", profitRecipient);
  console.log(" Every trade's surplus is sent here");
  console.log(" inside the transaction — no withdraw() needed.");
  console.log("==========================================================");
  console.log("");
  console.log("Next steps (owner only):");
  console.log("  routeStrategy.setTrustedRouter(<dex router>, true)   // per venue");
  console.log("  calldataStrategy.setTrustedTarget(<agg executor>, true)");
  console.log("  engine.setKeeper(<bot EOA>, ...)                    // optional");
  console.log("  engine.setMinProfitFloor(<wei floor>, ...)          // optional");
  console.log("  engine.setProfitRecipient(<new wallet>, ...)        // optional");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
