"use strict";

const hre = require("hardhat");
const { scanOnce } = require("./lib/scan");
const { loadConfig, resolveAddresses } = require("./lib/config");
const { buildCycleAlert, notify } = require("./lib/alert");

function pickSigner(readSigner, config) {
  // send=false stays provider-only; send=true uses the local account, or a
  // dedicated wallet on the private submission RPC when configured
  // (e.g. SUBMIT_RPC_URL=https://protect.flashbots.net to dodge sandwich bots).
  const submitUrl = process.env.SUBMIT_RPC_URL || config.submitRpcUrl;
  if (process.env.SEND === "true" && submitUrl && process.env.PRIVATE_KEY) {
    return new hre.ethers.Wallet(
      process.env.PRIVATE_KEY,
      new hre.ethers.JsonRpcProvider(submitUrl)
    );
  }
  return readSigner;
}

async function main() {
  const { config, configPath } = loadConfig();
  const { engineAddress, strategyAddress } = resolveAddresses(config, { requireStrategy: true });

  const send = process.env.SEND === "true";
  const provider = hre.ethers.provider;
  const readSigner = (await hre.ethers.getSigners())[0];
  const signer = pickSigner(readSigner, config);

  console.log(`scanner  network  = ${hre.network.name}`);
  console.log(`scanner  engine   = ${engineAddress}`);
  console.log(`scanner  strategy = ${strategyAddress}`);
  console.log(
    `scanner  mode     = ${send ? "SEND" : "dry-run (set SEND=true to trade)"} (config: ${configPath})`
  );

  const once = process.env.SCANNER_ONCE === "true";
  const interval = Number(config.pollIntervalMs ?? 12000);

  const runCycle = async () => {
    const started = Date.now();
    console.log(`\n[cycle ${new Date().toISOString()}]`);
    try {
      const results = await scanOnce({
        provider,
        signer,
        engineAddress,
        strategyAddress,
        config,
        send,
      });
      const profitable = results.filter((r) => r.profitable && !r.error).length;
      console.log(
        `[cycle done in ${Date.now() - started}ms] scanned=${results.length} profitable=${profitable}`
      );

      // Alerts: env URL wins over config (webhook URLs usually embed secrets).
      const alertCfg = config.alerts ?? {};
      const webhookUrl = process.env.ALERT_WEBHOOK_URL || alertCfg.webhookUrl;
      const payload = buildCycleAlert({ network: hre.network.name, engineAddress, results, send });
      if (payload && webhookUrl && (send || alertCfg.onDryRun === true)) {
        const res = await notify({ url: webhookUrl, payload });
        console.log(
          res.sent ? "[alert] sent" : `[alert] not sent: ${res.reason ?? res.error ?? "unknown"}`
        );
      }
      // (alerts on dry-run cycles stay silent unless alerts.onDryRun=true)

      if (profitable > 0 && !send) {
        console.log("hint: opportunity found but dry-run — set SEND=true (and fund the updater) to trade");
      }
    } catch (err) {
      console.error("[cycle failed]", err?.shortMessage ?? err?.message ?? err);
    }
  };

  await runCycle();
  if (once) return;

  const timer = setInterval(runCycle, interval);
  const stop = () => {
    clearInterval(timer);
    console.log("\nscanner stopped");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(`scanner polling every ${interval}ms (ctrl-c to stop)`);
}

main().catch((err) => {
  console.error(err?.shortMessage ?? err?.message ?? err);
  process.exitCode = 1;
});