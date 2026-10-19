"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createRun,
  readEntries,
  opportunityRows,
  summarize,
  tradesCsv,
  summaryMarkdown,
  writeArtifacts,
} = require("../scanner/lib/results");
const { scanOnce } = require("../scanner/lib/scan");

/** Entries as a real send-capable run would produce them. */
function sampleEntries() {
  return [
    { t: "2026-10-18T10:00:00.000Z", runId: "r1", network: "sepolia", type: "run", dryCycles: 1, sendCycles: 2 },
    {
      t: "2026-10-18T10:00:01.000Z",
      runId: "r1",
      network: "sepolia",
      type: "setup",
      facts: { engine: "0xE1", strategy: "0xS1" },
    },
    {
      t: "2026-10-18T10:01:00.000Z",
      runId: "r1",
      network: "sepolia",
      type: "cycle",
      cycleIndex: 1,
      mode: "dry",
      durationMs: 800,
      items: [
        {
          id: "opp-1",
          profitable: true,
          dryRun: true,
          eval: { grossProfit: "750000000000000", netProfit: "740000000000000" },
          quoted: { amountIn: "20000000000000000", outB: "20750000000000000" },
        },
      ],
    },
    {
      t: "2026-10-18T10:02:00.000Z",
      runId: "r1",
      network: "sepolia",
      type: "cycle",
      cycleIndex: 1,
      mode: "send",
      durationMs: 21000,
      items: [
        {
          id: "opp-1",
          profitable: true,
          txHash: "0xaaa",
          status: "confirmed",
          blockNumber: 123,
          gasUsed: "300000",
          gasPriceUsed: "20000000000",
          gasCostWei: "6000000000000000",
          confirmMs: 20000,
          eval: { grossProfit: "750000000000000", netProfit: "744000000000000" },
          quoted: { amountIn: "20000000000000000", outB: "20750000000000000" },
        },
        {
          id: "opp-2",
          profitable: false,
          error: "estimateGas failed: reverted",
        },
      ],
    },
    {
      t: "2026-10-18T10:04:00.000Z",
      runId: "r1",
      network: "sepolia",
      type: "cycle",
      cycleIndex: 2,
      mode: "send",
      durationMs: 19000,
      items: [
        {
          id: "opp-1",
          profitable: true,
          txHash: "0xbbb",
          status: "reverted",
          blockNumber: 125,
          gasUsed: "90000",
          gasCostWei: "1800000000000000",
          confirmMs: 18000,
          eval: { grossProfit: "750000000000000" },
        },
      ],
    },
    {
      t: "2026-10-18T10:05:00.000Z",
      runId: "r1",
      network: "sepolia",
      type: "ledger",
      pnl: { attempts: "3", executedTrades: "2" },
    },
  ];
}

describe("results recorder (pure functions)", function () {
  it("summarizes cycles, trades, profit, gas and latency", function () {
    const s = summarize(sampleEntries());

    expect(s.cycles.dry).to.deep.equal({ count: 1, profitable: 1 });
    expect(s.cycles.send).to.deep.equal({ count: 2, profitable: 2 });
    expect(s.opportunitiesEvaluated).to.equal(4);
    expect(s.profitable).to.equal(3);
    expect(s.sent).to.equal(2);
    expect(s.confirmed).to.equal(1);
    expect(s.reverted).to.equal(1);
    expect(s.errors).to.equal(1);
    // realized = confirmed trades only (the reverted tx earns nothing)
    expect(s.grossProfitWei).to.equal(750000000000000n);
    // potential = dry-run item + reverted-but-quoted item
    expect(s.potentialProfitWei).to.equal(2n * 750000000000000n);
    // actual gas of both sent txs
    expect(s.gasSpentWei).to.equal(7800000000000000n);
    expect(s.avgConfirmMs).to.equal(19000);
    expect(s.sentTxHashes).to.deep.equal(["0xaaa", "0xbbb"]);
    expect(s.setup).to.deep.equal({ engine: "0xE1", strategy: "0xS1" });
    expect(s.ledger).to.deep.equal({ attempts: "3", executedTrades: "2" });
  });

  it("flattens opportunity rows across cycles", function () {
    const rows = opportunityRows(sampleEntries());
    expect(rows).to.have.lengthOf(4);
    expect(rows[0].id).to.equal("opp-1");
    expect(rows[0].mode).to.equal("dry");
    expect(rows[2].mode).to.equal("send");
  });

  it("renders a trades CSV with only sent rows", function () {
    const csv = tradesCsv(sampleEntries());
    const lines = csv.trim().split("\n");
    expect(lines[0]).to.match(/^cycleIndex,mode,id,amountIn,/);
    expect(lines).to.have.lengthOf(3); // header + 2 sent trades
    expect(lines[1]).to.contain("0xaaa").and.to.contain("confirmed");
    expect(lines[2]).to.contain("0xbbb").and.to.contain("reverted");
    expect(csv.endsWith("\n")).to.equal(true);
  });

  it("renders a markdown summary with the recorded numbers", function () {
    const run = {
      runId: "r1",
      network: "sepolia",
      file: path.join("results", "r1.jsonl"),
    };
    const entries = sampleEntries();
    const md = summaryMarkdown(run, entries, summarize(entries));
    expect(md).to.contain("# Run r1");
    expect(md).to.contain("| send | 2 | 2 |");
    expect(md).to.contain("transactions sent: 2 (confirmed 1, reverted 1)");
    expect(md).to.contain("0xaaa");
    expect(md).to.contain("## Ledger");
  });
});

describe("results recorder (disk)", function () {
  let dir;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "goku-results-"));
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("streams JSONL and derives csv/md artifacts", function () {
    const run = createRun({ runId: "t1", network: "hardhat", dir });
    run.record("run", { dryCycles: 1 });
    run.record("setup", { facts: { engine: "0xE" } });
    run.record("cycle", { cycleIndex: 1, mode: "dry", items: [{ id: "x", profitable: false }] });

    // JSONL: one parseable object per line, header fields on every line
    const entries = readEntries(run.file);
    expect(entries).to.have.lengthOf(3);
    for (const e of entries) {
      expect(e.runId).to.equal("t1");
      expect(e.network).to.equal("hardhat");
      expect(e.t).to.be.a("string");
    }
    expect(entries[2].items[0].id).to.equal("x");

    const { summary, csvFile, mdFile } = writeArtifacts(run);
    expect(fs.existsSync(csvFile)).to.equal(true);
    expect(fs.existsSync(mdFile)).to.equal(true);
    expect(summary.opportunitiesEvaluated).to.equal(1);
    // empty run still produces a valid header-only CSV
    expect(fs.readFileSync(csvFile, "utf8").trim().split("\n")).to.have.lengthOf(1);
  });

  it("serializes BigInt values as strings", function () {
    const run = createRun({ runId: "t2", network: "hardhat", dir });
    run.record("ledger", { pnl: { grossProfit: 1150000000000000000n } });
    const [entry] = readEntries(run.file);
    expect(entry.pnl.grossProfit).to.equal("1150000000000000000");
  });

  it("requires a runId", function () {
    expect(() => createRun({ network: "hardhat", dir })).to.throw(/runId/);
  });
});

describe("results recorder (integration with a live scan)", function () {
  it("records a dry then send cycle against the mock market and summarizes", async function () {
    // Reuse the exact market the scanner end-to-end tests run against.
    const { marketFixture } = require("./scanner");
    const { config, engineAddress, strategyAddress, provider, signer } =
      await loadFixture(marketFixture);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goku-results-int-"));
    try {
      const run = createRun({ runId: "int1", network: "hardhat", dir });

      const dry = await scanOnce({
        provider, signer, engineAddress, strategyAddress, config, send: false, log: () => {},
      });
      run.record("cycle", { cycleIndex: 1, mode: "dry", durationMs: 1, items: dry });

      const sent = await scanOnce({
        provider, signer, engineAddress, strategyAddress, config, send: true, log: () => {},
      });
      run.record("cycle", { cycleIndex: 1, mode: "send", durationMs: 1, items: sent });

      const { summary } = writeArtifacts(run);
      expect(summary.cycles.dry).to.deep.equal({ count: 1, profitable: 1 });
      expect(summary.cycles.send).to.deep.equal({ count: 1, profitable: 1 });
      expect(summary.sent).to.equal(1);
      expect(summary.confirmed).to.equal(1);
      expect(summary.reverted).to.equal(0);
      // realized profit comes from the confirmed send only; the dry-run
      // cycle's quote lands in potential, never in realized
      expect(summary.grossProfitWei).to.equal(ethers.parseEther("11.5"));
      expect(summary.potentialProfitWei).to.equal(ethers.parseEther("11.5"));
      expect(summary.gasSpentWei).to.be.greaterThan(0n);
      expect(summary.avgConfirmMs).to.be.a("number");
      expect(summary.sentTxHashes[0]).to.match(/^0x[0-9a-fA-F]{64}$/);

      // CSV row reflects the real trade
      const csv = fs.readFileSync(run.csvFile, "utf8").trim().split("\n");
      expect(csv).to.have.lengthOf(2);
      expect(csv[1]).to.contain(sent[0].txHash);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
