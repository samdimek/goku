"use strict";

const fs = require("fs");
const path = require("path");

const isBad = (a) => !a || /^0x0{40}$/i.test(a) === true;

function loadConfig() {
  const configPath = process.env.SCANNER_CONFIG || path.join(__dirname, "..", "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Missing scanner config: ${configPath}\n` +
        `Copy scanner/config.example.json to scanner/config.json and fill in ` +
        `engine/strategy addresses, routers and opportunities (or set SCANNER_CONFIG).`
    );
  }
  return { config: JSON.parse(fs.readFileSync(configPath, "utf8")), configPath };
}

/** Env vars win over config so deployments don't edit files. */
function resolveAddresses(config, { requireStrategy = false } = {}) {
  const engineAddress = process.env.ENGINE_ADDRESS || config.engineAddress;
  const strategyAddress = process.env.ROUTE_STRATEGY_ADDRESS || config.routeStrategyAddress;

  if (isBad(engineAddress)) throw new Error("Set engineAddress in config or ENGINE_ADDRESS");
  if (requireStrategy && isBad(strategyAddress))
    throw new Error("Set routeStrategyAddress in config or ROUTE_STRATEGY_ADDRESS");

  return { engineAddress, strategyAddress: isBad(strategyAddress) ? undefined : strategyAddress };
}

module.exports = { isBad, loadConfig, resolveAddresses };