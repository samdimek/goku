const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { marketFixture } = require("./scanner");
const { scanOnce } = require("../scanner/lib/scan");
const { fetchPnl, fetchEvents, formatPnl } = require("../scanner/lib/ledger");
const { buildCycleAlert, notify } = require("../scanner/lib/alert");

async function runOneTrade(fixture) {
  const { config, engineAddress, strategyAddress, provider, signer } = fixture;
  const results = await scanOnce({
    provider, signer, engineAddress, strategyAddress, config, send: true, log: () => {},
  });
  expect(results[0].status).to.equal("confirmed");
  return results;
}

describe("scanner/ledger (P&L from events)", function () {
  it("returns empty aggregates for an engine with no trades", async function () {
    const { engineAddress } = await loadFixture(marketFixture);
    const pnl = await fetchPnl({
      provider: ethers.provider,
      engineAddress,
      fromBlock: 0,
      chunkSize: 5,
    });
    expect(pnl.executedTrades).to.equal(0n);
    expect(pnl.attempts).to.equal(0n);
    expect(Object.keys(pnl.byAsset)).to.have.lengthOf(0);
    expect(formatPnl(pnl)).to.match(/no completed trades/);
  });

  it("aggregates borrowed, premium, profit and per-strategy stats", async function () {
    const fixture = await loadFixture(marketFixture);
    await runOneTrade(fixture);

    const pnl = await fetchPnl({
      provider: ethers.provider,
      engineAddress: fixture.engineAddress,
      fromBlock: 0,
      chunkSize: 5, // force multiple chunks to exercise pagination
    });

    expect(pnl.executedTrades).to.equal(1n);
    expect(pnl.fromBlock).to.equal(0);
    expect(pnl.toBlock).to.equal(await ethers.provider.getBlockNumber());

    const assetRow = pnl.byAsset[ethers.getAddress(fixture.assetAddr)];
    expect(assetRow).to.not.equal(undefined);
    expect(assetRow.trades).to.equal(1n);
    expect(assetRow.borrowed).to.equal(ethers.parseEther("1000"));
    expect(assetRow.premium).to.equal(ethers.parseEther("0.5"));
    expect(assetRow.grossProfit).to.equal(ethers.parseEther("11.5"));
    expect(assetRow.withdrawn).to.equal(0n);
    expect(assetRow.retained).to.equal(ethers.parseEther("11.5"));

    const stratRow = pnl.byStrategy[ethers.getAddress(fixture.strategyAddress)];
    expect(stratRow.trades).to.equal(1n);
    expect(stratRow.grossProfit).to.equal(ethers.parseEther("11.5"));

    const report = formatPnl(pnl, { [fixture.assetAddr]: 18 });
    expect(report).to.match(/profit=11\.5 /);
    expect(report).to.match(/retained=11\.5/);
  });

  it("tracks withdrawals and nets them against profit", async function () {
    const fixture = await loadFixture(marketFixture);
    await runOneTrade(fixture);

    const engine = await ethers.getContractAt("FlashLoan", fixture.engineAddress);
    await (await engine.withdraw(fixture.assetAddr)).wait();

    const pnl = await fetchPnl({
      provider: ethers.provider,
      engineAddress: fixture.engineAddress,
      fromBlock: 0,
      chunkSize: 1000,
    });
    expect(pnl.withdrawals).to.equal(1n);

    const row = pnl.byAsset[ethers.getAddress(fixture.assetAddr)];
    expect(row.grossProfit).to.equal(ethers.parseEther("11.5"));
    expect(row.withdrawn).to.equal(ethers.parseEther("11.5"));
    expect(row.retained).to.equal(0n);
  });

  it("splits events by block range", async function () {
    const fixture = await loadFixture(marketFixture);

    // Before any trade: everything in [0..now] is empty.
    const before = await ethers.provider.getBlockNumber();
    const empty = await fetchEvents({
      provider: ethers.provider,
      engineAddress: fixture.engineAddress,
      fromBlock: 0,
      toBlock: before,
      chunkSize: 10,
    });
    expect(empty.executed).to.have.lengthOf(0);

    await runOneTrade(fixture);
    const all = await fetchEvents({
      provider: ethers.provider,
      engineAddress: fixture.engineAddress,
      fromBlock: 0,
      toBlock: "latest",
      chunkSize: 1000,
    });
    expect(all.executed).to.have.lengthOf(1);
    expect(all.requested).to.have.lengthOf(1);

    // A range strictly after the trade is empty again.
    const head = await ethers.provider.getBlockNumber();
    const afterOnly = await fetchEvents({
      provider: ethers.provider,
      engineAddress: fixture.engineAddress,
      fromBlock: head + 1,
      toBlock: head + 1,
      chunkSize: 10,
    });
    expect(afterOnly.executed).to.have.lengthOf(0);
  });
});

describe("scanner/alert", function () {
  const hit = (over = {}) => ({
    id: "opp-1",
    profitable: true,
    error: undefined,
    dryRun: false,
    txHash: "0xabc",
    status: "confirmed",
    eval: { grossProfit: "11500000000000000000", netProfit: "11400000000000000000", premium: "500000000000000000", minAmountOutA: "995", minAmountOutB: "1006", },
    ...over,
  });

  it("returns null when no opportunity fired", function () {
    expect(buildCycleAlert({ results: [], send: false })).to.equal(null);
    expect(
      buildCycleAlert({ results: [hit({ profitable: false })], send: false })
    ).to.equal(null);
    expect(
      buildCycleAlert({ results: [hit({ error: "estimateGas failed: x" })], send: false })
    ).to.equal(null);
  });

  it("builds a payload with mode, id, profit and txHash", function () {
    const payload = buildCycleAlert({
      network: "hardhat",
      engineAddress: "0x00000000000000000000000000000000000000EE",
      results: [hit()],
      send: true,
    });
    expect(payload.event).to.equal("arbitrage.opportunity");
    expect(payload.mode).to.equal("send");
    expect(payload.network).to.equal("hardhat");
    expect(payload.count).to.equal(1);
    expect(payload.text).to.match(/EXECUTED on hardhat/);
    expect(payload.text).to.match(/0xabc/);
    expect(payload.opportunities[0].netProfit).to.equal("11400000000000000000");
  });

  it("marks dry-run payloads as simulated", function () {
    const payload = buildCycleAlert({ results: [hit({ txHash: undefined, status: undefined })], send: false });
    expect(payload.mode).to.equal("dry-run");
    expect(payload.opportunities[0].status).to.equal("simulated");
  });

  it("POSTs the payload to the webhook", async function () {
    const captured = {};
    const fakeFetch = async (url, init) => {
      captured.url = url;
      captured.body = JSON.parse(init.body);
      return { ok: true, status: 200 };
    };
    const payload = buildCycleAlert({ results: [hit()], send: true });
    const res = await notify({ url: "https://hooks.example/x", payload, fetchImpl: fakeFetch });
    expect(res.sent).to.equal(true);
    expect(captured.url).to.equal("https://hooks.example/x");
    expect(captured.body.event).to.equal("arbitrage.opportunity");
    expect(captured.body.count).to.equal(1);
  });

  it("fails soft without a url and never throws on transport errors", async () => {
    expect((await notify({ url: "", payload: {} })).sent).to.equal(false);
    const boom = async () => {
      throw new Error("connection refused");
    };
    const res = await notify({ url: "https://x", payload: {}, fetchImpl: boom });
    expect(res.sent).to.equal(false);
    expect(res.error).to.match(/connection refused/);
  });
});