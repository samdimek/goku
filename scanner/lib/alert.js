"use strict";

/**
 * Build the alert payload for a completed scan cycle, or null when there is
 * nothing to shout about (no profitable opportunity in this cycle).
 */
function buildCycleAlert({ network = "unknown", engineAddress = "?", results = [], send = false }) {
  const hits = results.filter((r) => r.profitable && !r.error);
  if (hits.length === 0) return null;

  const mode = send ? "EXECUTED" : "dry-run";
  const opportunities = hits.map((r) => ({
    id: r.id,
    grossProfit: r.eval?.grossProfit ?? null,
    netProfit: r.eval?.netProfit ?? null,
    premium: r.eval?.premium ?? null,
    minAmountOutA: r.eval?.minAmountOutA ?? null,
    minAmountOutB: r.eval?.minAmountOutB ?? null,
    txHash: r.txHash ?? null,
    status: r.status ?? "simulated",
  }));

  return {
    event: "arbitrage.opportunity",
    network,
    engine: engineAddress,
    mode: send ? "send" : "dry-run",
    at: new Date().toISOString(),
    count: opportunities.length,
    text:
      `[goku scanner] ${mode} on ${network}: ${hits.length} opportunity(ies) — ` +
      hits.map((r) => `${r.id} (net ${r.eval?.netProfit ?? "?"} wei${r.txHash ? `, tx ${r.txHash}` : ""})`).join("; "),
    opportunities,
  };
}

/**
 * POST the payload to a webhook (Slack/Discord/Telegram bridge, etc.).
 * Never throws: failures come back as { sent: false, error } so the scan
 * loop can keep running. `fetchImpl` is injectable for tests.
 */
async function notify({ url, payload, fetchImpl }) {
  if (!url) return { sent: false, reason: "no-url" };
  const doFetch = fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return { sent: false, reason: "no-fetch" };
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const ok = res?.ok ?? true; // some bridges return no .ok
    return { sent: Boolean(ok), status: res?.status ?? 0 };
  } catch (err) {
    return { sent: false, error: String(err?.message ?? err).slice(0, 300) };
  }
}

module.exports = { buildCycleAlert, notify };