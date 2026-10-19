"use strict";

/**
 * Results recorder for scanner runs.
 *
 * Every run writes one JSONL file (one JSON object per line, append-only,
 * crash-safe) plus derived artifacts: a trades CSV and a markdown summary.
 * The aggregation functions are pure (take entries, return numbers) so they
 * can be unit-tested without touching disk.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_DIR = path.join(__dirname, "..", "..", "results");

/** Serializable snapshot of a BigInt-carrying value. */
const jsonSafe = (_key, value) => (typeof value === "bigint" ? value.toString() : value);

/** `2026-10-18T12:00:00.000Z` with fallback for exotic clocks. */
function nowIso() {
  try {
    return new Date().toISOString();
  } catch {
    return "";
  }
}

/**
 * Create a run log. Each `record(type, data)` appends one JSONL line:
 *   { t: iso-timestamp, runId, network, type, ...data }
 *
 * `dir` is injectable for tests; default is <project>/results.
 */
function createRun({ runId, network, dir = DEFAULT_DIR, fsImpl = fs }) {
  if (!runId) throw new Error("createRun requires a runId");
  fsImpl.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}.jsonl`);
  const header = { runId, network: network ?? "unknown" };

  const record = (type, data = {}) => {
    const line = JSON.stringify({ t: nowIso(), ...header, type, ...data }, jsonSafe);
    fsImpl.appendFileSync(file, line + "\n", "utf8");
    return data;
  };

  return {
    runId,
    network: header.network,
    dir,
    file,
    record,
    csvFile: path.join(dir, `${runId}-trades.csv`),
    mdFile: path.join(dir, `${runId}-summary.md`),
    configFile: path.join(dir, `${runId}-config.json`),
  };
}

/** Read a JSONL file back into entry objects (tolerates blank trailing line). */
function readEntries(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/** Flatten cycle entries into one row per evaluated opportunity. */
function opportunityRows(entries) {
  const rows = [];
  for (const e of entries) {
    if (e.type !== "cycle") continue;
    for (const item of e.items ?? []) {
      rows.push({ cycleIndex: e.cycleIndex, mode: e.mode, durationMs: e.durationMs, ...item });
    }
  }
  return rows;
}

/**
 * Aggregate a run's entries into analysis-ready numbers:
 *   cycles by mode, opportunities evaluated, profitable, sent/confirmed/
 *   reverted, errors, gross profit (wei) and gas actually spent (wei),
 *   plus setup facts and ledger snapshot if the run recorded them.
 */
function summarize(entries) {
  const cycles = { dry: { count: 0, profitable: 0 }, send: { count: 0, profitable: 0 } };
  let opportunitiesEvaluated = 0;
  let profitable = 0;
  let sent = 0;
  let confirmed = 0;
  let reverted = 0;
  let errors = 0;
  // Realized profit: only trades whose transaction actually confirmed on-chain.
  let grossProfitWei = 0n;
  // Potential profit: what dry-run cycles (and profitable-but-unsent items)
  // would have earned at their quoted prices. Never mixed into realized.
  let potentialProfitWei = 0n;
  let gasSpentWei = 0n;
  let latencySamples = 0;
  let latencyTotalMs = 0;
  const sentTxHashes = [];
  const setup = {};
  let ledger = null;

  for (const e of entries) {
    if (e.type === "setup") {
      Object.assign(setup, e.facts ?? {});
      continue;
    }
    if (e.type === "ledger") {
      ledger = e.pnl ?? null;
      continue;
    }
    if (e.type === "ledger-error") {
      // Surface the failure in the report instead of pretending it never ran.
      ledger = { error: e.error, fromBlock: e.fromBlock };
      continue;
    }
    if (e.type !== "cycle") continue;

    const bucket = e.mode === "send" ? cycles.send : cycles.dry;
    bucket.count += 1;

    for (const item of e.items ?? []) {
      opportunitiesEvaluated += 1;
      if (item.error) errors += 1;
      const confirmedTrade = item.txHash && item.status === "confirmed";
      if (item.profitable) {
        profitable += 1;
        bucket.profitable += 1;
        if (item.eval?.grossProfit) {
          try {
            const g = BigInt(item.eval.grossProfit);
            if (g > 0n) {
              if (confirmedTrade) grossProfitWei += g;
              else potentialProfitWei += g;
            }
          } catch {
            /* unparseable — skip */
          }
        }
      }
      if (item.txHash) {
        sent += 1;
        sentTxHashes.push(item.txHash);
        if (item.status === "confirmed") confirmed += 1;
        if (item.status === "reverted") reverted += 1;
        if (item.gasCostWei) {
          try {
            gasSpentWei += BigInt(item.gasCostWei);
          } catch {
            /* skip */
          }
        }
        if (typeof item.confirmMs === "number") {
          latencySamples += 1;
          latencyTotalMs += item.confirmMs;
        }
      }
    }
  }

  return {
    cycles,
    opportunitiesEvaluated,
    profitable,
    sent,
    confirmed,
    reverted,
    errors,
    grossProfitWei,
    potentialProfitWei,
    gasSpentWei,
    avgConfirmMs: latencySamples ? Math.round(latencyTotalMs / latencySamples) : null,
    sentTxHashes,
    setup,
    ledger,
  };
}

/** Trades CSV: one row per opportunity item that was sent on-chain. */
function tradesCsv(entries) {
  const header = [
    "cycleIndex",
    "mode",
    "id",
    "amountIn",
    "quotedOutB",
    "grossProfitWei",
    "netProfitWei",
    "gasUnits",
    "gasCostWei",
    "txHash",
    "status",
    "blockNumber",
    "confirmMs",
  ];
  const rows = [header.join(",")];
  for (const row of opportunityRows(entries)) {
    if (!row.txHash) continue;
    rows.push(
      [
        row.cycleIndex,
        row.mode,
        row.id ?? "",
        row.quoted?.amountIn ?? "",
        row.quoted?.outB ?? "",
        row.eval?.grossProfit ?? "",
        row.eval?.netProfit ?? "",
        row.gasUnits ?? "",
        row.gasCostWei ?? "",
        row.txHash,
        row.status ?? "",
        row.blockNumber ?? "",
        row.confirmMs ?? "",
      ].join(",")
    );
  }
  return rows.join("\n") + "\n";
}

/** Markdown summary for humans. */
function summaryMarkdown(run, entries, s) {
  const L = [];
  L.push(`# Run ${run.runId}`);
  L.push("");
  L.push(`- network: ${run.network}`);
  L.push(`- started: ${entries[0]?.t ?? "unknown"}`);
  L.push(`- raw log: ${path.basename(run.file)}`);
  L.push("");
  L.push("## Setup facts");
  L.push("");
  const setupEntries = Object.entries(s.setup);
  if (setupEntries.length === 0) L.push("(none recorded)");
  for (const [k, v] of setupEntries) L.push(`- ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
  L.push("");
  L.push("## Scan cycles");
  L.push("");
  L.push(`| mode | cycles | profitable opportunities |`);
  L.push(`| --- | --- | --- |`);
  L.push(`| dry-run | ${s.cycles.dry.count} | ${s.cycles.dry.profitable} |`);
  L.push(`| send | ${s.cycles.send.count} | ${s.cycles.send.profitable} |`);
  L.push("");
  L.push("## Trades");
  L.push("");
  L.push(`- opportunities evaluated: ${s.opportunitiesEvaluated}`);
  L.push(`- profitable: ${s.profitable}`);
  L.push(`- transactions sent: ${s.sent} (confirmed ${s.confirmed}, reverted ${s.reverted})`);
  L.push(`- errors: ${s.errors}`);
  L.push(`- realized profit (confirmed trades): ${s.grossProfitWei} wei`);
  L.push(`- potential profit (dry-run / unconfirmed): ${s.potentialProfitWei} wei`);
  L.push(`- gas actually spent: ${s.gasSpentWei} wei`);
  L.push(
    `- avg confirmation latency: ${s.avgConfirmMs === null ? "n/a" : s.avgConfirmMs + " ms"}`
  );
  if (s.sentTxHashes.length) {
    L.push("");
    L.push("Tx hashes:");
    L.push("");
    for (const h of s.sentTxHashes) L.push(`- ${h}`);
  }
  if (s.ledger) {
    L.push("");
    L.push("## Ledger (on-chain P&L for the engine)");
    L.push("");
    L.push("```");
    L.push(JSON.stringify(s.ledger, jsonSafe, 2));
    L.push("```");
  }
  L.push("");
  return L.join("\n");
}

/**
 * Write all derived artifacts next to the JSONL log:
 *   <runId>.jsonl (already streamed), <runId>-trades.csv, <runId>-summary.md
 * Returns { summary, csvFile, mdFile }.
 */
function writeArtifacts(run, entries = null, fsImpl = fs) {
  const all = entries ?? readEntries(run.file);
  const summary = summarize(all);
  fsImpl.writeFileSync(run.csvFile, tradesCsv(all), "utf8");
  fsImpl.writeFileSync(run.mdFile, summaryMarkdown(run, all, summary), "utf8");
  return { summary, csvFile: run.csvFile, mdFile: run.mdFile };
}

module.exports = {
  DEFAULT_DIR,
  createRun,
  readEntries,
  opportunityRows,
  summarize,
  tradesCsv,
  summaryMarkdown,
  writeArtifacts,
};
