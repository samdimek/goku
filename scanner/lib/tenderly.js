"use strict";

/**
 * Optional Tenderly preflight: simulate the EXACT transaction we are about
 * to broadcast against Tenderly's node first. If the simulation reverts,
 * we never send -> the wallet never pays gas for a failing trade.
 *
 * Implementation: REST dry-run (docs.tenderly.co/simulations/single-simulations):
 *   POST https://api.tenderly.co/api/v1/account/{accountSlug}/project/{projectSlug}/simulate
 *   Headers: X-Access-Key: <token>, Content-Type: application/json
 *   Body: { network_id, from, to, input, value, gas, save:false,
 *           save_if_fails:false, simulation_type:"quick" }
 * Success criterion: response.simulation.status === true (boolean).
 *
 * Gating semantics (fail-closed):
 *   - not configured            -> { configured:false, ok:true } (gate skipped)
 *   - simulation says revert     -> ok:false  (never send, regardless of strict)
 *   - API/infra error/bad body   -> ok:false when strict (default);
 *                                   ok:true + degraded flag when strict:false
 *                                   (the eth_call gate still ran before this).
 *
 * Config comes from scanner config `tenderly: {...}` or env vars:
 *   TENDERLY_ACCESS_TOKEN, TENDERLY_ACCOUNT_SLUG, TENDERLY_PROJECT_SLUG
 * (API access requires a Tenderly paid plan.)
 */

function resolveTenderlyConfig(config = {}, env = process.env) {
  const t = config.tenderly ?? {};
  const cfg = {
    accessToken: t.accessToken || env.TENDERLY_ACCESS_TOKEN || "",
    accountSlug: t.accountSlug || env.TENDERLY_ACCOUNT_SLUG || "",
    projectSlug: t.projectSlug || env.TENDERLY_PROJECT_SLUG || "",
    // strict=true: any infrastructure failure blocks the send too.
    strict: t.strict !== false,
    enabled: t.enabled !== false,
  };
  cfg.configured = Boolean(
    cfg.enabled && cfg.accessToken && cfg.accountSlug && cfg.projectSlug
  );
  return cfg;
}

function endpoint(cfg) {
  return `https://api.tenderly.co/api/v1/account/${cfg.accountSlug}/project/${cfg.projectSlug}/simulate`;
}

/** Infra failure (API error, malformed body): strict => block, else degrade. */
function infra(cfg, reason) {
  return cfg.strict
    ? { configured: true, ok: false, infra: true, reason }
    : { configured: true, ok: true, degraded: true, reason };
}

/**
 * Run the dry-run simulation.
 *
 * @param cfg        resolveTenderlyConfig() output.
 * @param tx         { networkId, from, to, data, value, gasLimit }
 * @param fetchImpl  injectable fetch (tests); defaults to global fetch.
 * @returns { configured, ok, reason?, degraded?, gasUsed? }
 */
async function tenderlySimulate({ cfg, tx, fetchImpl }) {
  if (!cfg?.configured) return { configured: false, ok: true, reason: "not-configured" };
  const doFetch = fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return infra(cfg, "no-fetch-available");

  let res;
  try {
    res = await doFetch(endpoint(cfg), {
      method: "POST",
      headers: {
        "X-Access-Key": cfg.accessToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        network_id: String(tx.networkId),
        from: tx.from,
        to: tx.to,
        input: tx.data,
        value: tx.value ?? "0",
        gas: Number(tx.gasLimit),
        // Never persist dry-runs in the Tenderly dashboard.
        save: false,
        save_if_fails: false,
        simulation_type: "quick",
      }),
    });
  } catch (err) {
    return infra(cfg, `request-failed: ${String(err?.message ?? err).slice(0, 200)}`);
  }

  if (!res?.ok) return infra(cfg, `http-${res?.status ?? "?"}`);

  let body = null;
  try {
    body = typeof res.json === "function" ? await res.json() : null;
  } catch {
    return infra(cfg, "unparseable-response");
  }

  const status = body?.simulation?.status;
  if (status === false || status === 0) {
    // Definitive revert: never send this trade.
    const detail =
      body?.simulation?.error ||
      body?.transaction?.error ||
      body?.simulation?.errorReason ||
      "reverted in simulation";
    return { configured: true, ok: false, reason: `revert: ${String(detail).slice(0, 300)}` };
  }
  if (status === true || status === 1) {
    const gasUsed = body?.simulation?.gas_used ?? body?.transaction?.gas_used;
    return { configured: true, ok: true, gasUsed: gasUsed != null ? String(gasUsed) : undefined };
  }
  return infra(cfg, "missing-simulation-status");
}

module.exports = { resolveTenderlyConfig, tenderlySimulate, endpoint };
