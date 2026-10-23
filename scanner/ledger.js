"use strict";

/**
 * P&L ledger CLI: aggregates FlashLoanRequested / FlashLoanExecuted / Withdrawn
 * events for an engine into a per-asset / per-strategy report.
 *
 * Run:  npm run ledger:arbitrum   (or npx hardhat run scanner/ledger.js --network <net>)
 * Env:  ENGINE_ADDRESS (overrides config), LEDGER_FROM_BLOCK / LEDGER_TO_BLOCK optional,
 *       decimals via scanner config `ledger.decimalsByAsset`.
 */
const hre = require("hardhat");
const { loadConfig, resolveAddresses } = require("./lib/config");
const { fetchPnl, formatPnl } = require("./lib/ledger");

async function main() {
  const { config, configPath } = loadConfig();
  const { engineAddress } = resolveAddresses(config, { requireStrategy: false });

  const ledgerCfg = config.ledger ?? {};
  const fromBlock =
    process.env.LEDGER_FROM_BLOCK !== undefined
      ? Number(process.env.LEDGER_FROM_BLOCK)
      : Number(ledgerCfg.fromBlock ?? 0);
  const toBlock =
    process.env.LEDGER_TO_BLOCK !== undefined ? Number(process.env.LEDGER_TO_BLOCK) : "latest";

  console.log(`ledger  network = ${hre.network.name}`);
  console.log(`ledger  engine  = ${engineAddress}`);
  console.log(`ledger  blocks  = ${fromBlock}..${toBlock} (config: ${configPath})`);

  const pnl = await fetchPnl({
    provider: hre.ethers.provider,
    engineAddress,
    fromBlock,
    toBlock,
    chunkSize: Number(ledgerCfg.chunk ?? 5000),
  });

  console.log("\n" + formatPnl(pnl, ledgerCfg.decimalsByAsset ?? {}));
}

main().catch((err) => {
  console.error(err?.shortMessage ?? err?.message ?? err);
  process.exitCode = 1;
});