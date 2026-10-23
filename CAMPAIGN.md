# Live campaign — Sepolia transaction run #1

**Date:** 2026-10-19 · **Network:** Sepolia (chain 11155111) · **Signer:** `0x6D6EC9eF12071eCF3EfcA5C405120B27C10976E5`
**Run id:** `sepolia-campaign-1` · **Raw log:** `results/sepolia-campaign-1.jsonl` (append-only, one JSON object per event)

This document does two jobs: (1) explain **how the whole system works** — the
off-chain scanner, the safety gates, the on-chain engine, the recording
layer — in one place; (2) chronicle **this campaign**: every run, every
transaction, every hurdle and how it was resolved, with the numbers the
investor deck is built from.

---

## Part 1 — How everything works

### 1.1 The system in one paragraph

An off-chain **scanner** (Node.js) watches a configured list of closed
arbitrage cycles — borrow WETH from Aave V3, swap it for a mid token on
venue A, swap back to WETH on venue B, repay Aave, keep the surplus. Every
poll it re-prices each cycle with free `eth_call` reads and, only when a
cycle clears **every** safety gate, submits a transaction through the
on-chain **FlashLoan engine**, which re-checks profitability *inside the Aave
callback* and reverts atomically if the trade cannot cover its own costs.
Realized profit accrues inside the engine as an ERC-20 balance and can only
be swept by its owner to `engine.owner()`. Every decision, transaction,
balance snapshot and operational problem is recorded to an append-only JSONL
log and derived into CSV/markdown artifacts.

### 1.2 On-chain components (freshly deployed for this campaign)

| Component | Address | Role |
| --- | --- | --- |
| `FlashLoan` engine | `0x64B793C3e25E687aDEf90ebE8325d5a1a594000d` | entry point: `requestFlashLoan(asset, amount, strategy, minProfit, params)` pulls an Aave V3 flash loan, runs the registered strategy inside `executeOperation`, requires `balance ≥ amount + premium + minProfit` or reverts (`Unprofitable`), books the surplus |
| `DexRouteArbStrategy` | `0x0ED28277A44FEce027d54bCd3cF9d2Fe6d6e03dD` | executes exactly two trusted-router V2 swaps with per-leg `minAmountOut` pins and a deadline |
| `CalldataArbStrategy` | `0x004DEdbbF3bE545743ad41c9dFc2C578538847FA` | registered (not used by the scanner) |
| Aave V3 Pool (Sepolia) | `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951` | flash-loan liquidity; premium **5 bps** |
| Aave WETH reserve | `0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c` | borrowed asset (also the wrapped native → gas is priced in the same unit) |
| Uniswap V2 router / pair | `0xeE567Fe1…CfE3` / `0x93b2FE90…bb62` | venue A (target 1000 GTT/WETH) |
| SushiSwap router / pair | `0xeabce3e7…5791` / `0x04C76289…8972` | venue B (target 920 GTT/WETH) |
| Mid token (test GTT, open mint) | `0xECC06411598F1c2C2F2383157f8d5Ac01E28587c` | the arb's intermediate token |

An earlier engine (`0xC18cF01d…e58c`, 73,688,138,478,710 wei of profit from the
October 18 runs) is untouched; this campaign deploys and trades through a
fresh stack.

### 1.3 The scanner pipeline (per poll, per cycle)

1. **Validate the cycle** — exactly 2 legs, closed loop, starts and ends in
   the borrow asset (`core.validateCycle`). Invalid cycles are recorded as
   errors, never thrown.
2. **Quote both legs live** — `getAmountsOut` view calls against each venue
   (free, no transaction).
3. **Phase-1 gate (no gas yet)** — `gross = outB − amountIn − premium`
   (premium read from the real Aave pool) must clear the configured
   `minProfitWei`, or the cycle is skipped before anything is paid for.
4. **Slippage pins** — `minAmountOut = quote × (1 − slippageBps/10000)` per
   leg, computed once and enforced on-chain by the strategy.
5. **Phase-2 gate (gas)** — `estimateGas` on the exact call; gas cost =
   `gasUnits × max(feeData, gasPriceFloorWei)` when the borrowed asset wraps
   native ETH. Re-evaluate: gross must cover min-profit + gas.
6. **On-chain net guard** (default on, **relaxed for this campaign**) — the
   `minProfit` passed to `requestFlashLoan` normally includes the gas budget,
   so the engine itself reverts a trade that cannot cover its own gas.
7. **Authoritative simulation** — `requestFlashLoan.staticCall(...)` with the
   *exact* send arguments runs the entire flow against current state. A
   revert here means "do not broadcast".
8. **Optional Tenderly dry-run** (not configured here) and **optional
   private submission** (`SUBMIT_RPC_URL`, not used for this campaign —
   sends go through the public RPC so every transaction is visible).
9. **Send + record** — the receipt's block, gas used, effective gas price and
   confirmation latency are recorded per trade; profit is re-read from the
   engine at the end and cross-checked against the event ledger.

### 1.4 Campaign mode: re-creating the gap (the new part)

An arbitrage trade *converges* the pools it trades between: after one trade
the ~8.7% price gap shrinks to ~2-4% and further cycles are correctly refused
(RESULTS.md F2). To run a **campaign** of trades instead of one, the harness
now restores the gap between send cycles:

- `scanner/lib/restore.js` — a pure constant-product solver. Given a pair's
  live reserves and the venue's target price it computes the exact swap that
  moves the pool back to target: selling mid into the pool raises the
  mid-per-asset price, buying mid from the pool lowers it. It respects the
  0.3% LP fee, never spends more than 50% of the spent side's pool reserve,
  and flags unreachable targets instead of guessing.
- `scanner/run.js` — before **every** send cycle it reads both pairs'
  reserves, plans the restores, funds the wallet (wrap ETH / mint GTT as
  needed, one-time max-approvals), executes the swaps through the real
  routers, and records each one (direction, size, price before/after, tx
  hash, gas).

The restore is a *deliberate market-making loss* (fees + impact of pushing a
price away from equilibrium): it is the cost of demonstrating repeated
arbitrage on a self-seeded test market, and it is accounted for separately in
the true-net math.

### 1.5 Recording: every run, every hurdle, every holding

- **Runs/cycles** — one `cycle` entry per scan (dry or send) with per-item
  quotes, gate decisions, tx hash, receipt facts, confirm latency.
- **Hurdles** — every operational obstacle becomes a `hurdle` entry with its
  resolution: ambiguous RPC errors (`sendWait` retries, then verifies the
  transaction's on-chain effect before ever re-sending), failed restores,
  aborted cycles, ledger-fetch retries. The campaign never swallows an error;
  it records, resolves and continues.
- **Holdings** — a `holdings` snapshot (wallet ETH/GTT/WETH + engine profit,
  block number) is taken at baseline, before and after every send cycle, and
  at the end. The report computes total ETH spent from the first and last
  snapshots.
- **Artifacts** — `results/<runId>.jsonl` (raw), `-trades.csv` (one row per
  sent trade), `-summary.md` (human report incl. hurdles table, restores,
  holdings table, true net), `-config.json` (exact scanner config used).

### 1.6 The deliberate gate relaxation (honest disclosure)

This campaign runs with the two *priced* safety layers relaxed, by explicit
choice, to maximize transaction volume on testnet:

- `GAS_PRICE_FLOOR_WEI=0` — the off-chain gate prices gas from live
  `feeData` (~17-31 wei/gas right now) while the sender pays the harness's
  2 gwei pin. The scanner therefore believes each trade costs ~0.03 µETH of
  gas when it actually costs ~0.95 µETH.
- `NET_PROFIT_ON_CHAIN=false` — the engine's on-chain `minProfit` enforces
  only the gross floor (0), not a gas-inclusive net floor.

What stays ON and unmodified: cycle validation, live quoting, the gross
profit gate, slippage pins on both legs, deadline enforcement, the
`eth_call` staticCall preflight of the exact transaction, the engine's
atomic `Unprofitable` revert, and the owner-only withdrawal. A losing or
reverting trade still cannot settle; what relaxation buys is that
trades whose only sin is not covering the *artificially inflated* testnet gas
pin are allowed to fire. The **true net** (confirmed profit − actual gas
paid) is computed and reported from receipts — on this campaign it is
negative by design, exactly as finding F1 predicted. On mainnet at realistic
gas pricing the same pipeline with the same gates produces positive net; the
October 18 run and the local rehearsals demonstrate the unrelaxed behavior.

---

## Part 2 — Campaign chronicle

**Window:** 2026-10-19 21:28–21:59 UTC (~31 min) · **Blocks:** 11950835–11950986
**Config:** `results/sepolia-campaign-1-config.json` (exact snapshot used)

### 2.1 What ran

| Phase | Count | Outcome |
| --- | --- | --- |
| Dry cycles | 2 | 0 profitable — both correctly **refused** the converged market (the gap had closed after the prior trade; refusal is the designed behavior, RESULTS.md F2) |
| Gap restores | 100 swaps (2 per send cycle) | 100 confirmed, 0 skipped, 0 capped, 0 failed — prices landed on target (1000.0 / 920.0 GTT per WETH) every cycle |
| Send cycles | 50 | **50 confirmed on-chain, 0 reverted, 0 errors** |
| Opportunities evaluated | 52 | 50 profitable, all 50 submitted, all 50 confirmed |
| Hurdles recorded | 0 | The public RPC never dropped, replaced or ambiguously acknowledged a send — no retries were needed all run |

Wall-clock ~36 s per send cycle (restore pair + send + confirm + snapshot);
average confirmation latency **9,351 ms**.

### 2.2 The money (all numbers wei, asset = WETH `0xC558DBd…9a3c`)

| Quantity | Wei | WETH |
| --- | --- | --- |
| Gross profit, 50 confirmed trades | 3,691,297,928,452,727 | 0.003691297928452727 |
| Per-trade gross (avg / min / max) | 73,825,958,569,054 / 73,703,153,998,483 / 73,948,538,058,253 | ~73.8 µ (3.69 % of the 0.002 notional) |
| Aave premium paid (50 × 1e12, 5 bps) | 50,000,000,000,000 | 0.00005 |
| Gas, trade transactions | 47,234,752,000,000,000 | 0.047234752 |
| Gas, restore transactions | 29,084,456,000,000,000 | 0.029084456 |
| **Gas, total** | **76,319,208,000,000,000** | **0.076319208** |
| **True net (gross − all gas)** | **−72,627,910,071,547,273** | **−0.072627910071547273** |

Engine WETH balance: 73,698,131,785,054 (pre-campaign, retained from the
Oct 18 smoke runs) → **3,764,996,060,237,781** after trade 50 — still held
on-chain, withdrawable only by `engine.owner()`; 0 withdrawn. Signer ETH:
1.572852011871489925 → 1.496372374259436437 (spent 0.076319208, exactly the
sum of trade + restore gas below).

The true net is negative **by design** (§1.6): gross per trade ~73.8 µETH vs
~944.7 µETH of actual gas per trade at the harness's flat 2 gwei pin. This
reproduces finding F1 from RESULTS.md on live transactions — the engine,
gates and recording behave identically; only the testnet gas price makes the
run unprofitable, and the campaign reports that honestly instead of hiding it.

### 2.3 Three-way cross-check (recorder ↔ snapshots ↔ chain)

All three independent views reconcile **to the wei**:

| Check | Value | Result |
| --- | --- | --- |
| Recorder realized profit (sum of 50 confirmed evals) | 3,691,297,928,452,727 | — |
| Holdings: final engine balance − baseline | 3,764,996,060,237,781 − 73,698,131,785,054 | = 3,691,297,928,452,727 ✓ |
| On-chain: sum of per-trade engine-balance deltas from `FlashLoanExecuted` events (blocks 11950835–11950986) | 50 events, deltas 73.70–73.95 µ each | = 3,691,297,928,452,727 ✓ |
| Event counts: `FlashLoanRequested` = `FlashLoanExecuted` = confirmed sends | 50 = 50 = 50 | ✓ |
| Borrowed / premium: 50 × 2e15 / 50 × 1e12 | 0.1 / 0.00005 | ✓ |
| Last event's `profit` field = final snapshot = live `balanceOf(engine)` | 3,764,996,060,237,781 | ✓ (re-read after the run) |
| ETH spent (first − last snapshot) = trade gas + restore gas | 0.076319208 = 0.047234752 + 0.029084456 | ✓ |

**Reading the events yourself:** the `profit` argument of `FlashLoanExecuted`
is `balance − owed` where `balance` is the engine's **whole post-trade
balance**, not the per-trade delta — so naively summing the 50 events gives
97,760,859,690,363,821 (a sum of running balances). The true campaign profit
is `lastEvent.profit − preCampaignBalance` = 3,691,297,928,452,727, which is
exactly what the recorder and the holdings snapshots show. A fresh
`npm run ledger:sepolia` (with `LEDGER_FROM_BLOCK=11950835`) reproduces the
event totals above.

### 2.4 Hurdles and how they were handled

Zero hurdles occurred *inside* the campaign window, but the campaign was not
without incidents — both happened **before** cycle 1 and are part of the
record:

1. **First smoke run refused every send (by design).** The initial restore
   solver had the pool mechanics inverted: swapping into a pool *grows* its
   reserve of the input token, so restores pushed prices 961 → 924 instead of
   → 1000. The safety gates saw no gap and refused all sends (0 transactions
   spent). Fixed in `scanner/lib/restore.js`; the unit tests were corrected
   to real constant-product mechanics and the live smoke re-run.
2. **Corrected smoke landed restores exactly on target** (924 → 1000.0,
   1000.6 → 920.0) and fired one confirmed trade (73.7 µWETH gross),
   validating the whole loop on real pools before the 50-cycle commit.

During the campaign itself the append-only log shows no error, retry,
refusal or recovery entries — 100/100 restores and 50/50 sends confirmed on
first attempt (`results/sepolia-campaign-1.jsonl`, `hurdle` count 0).

## Part 3 — Verification guide

Every claim in this document is checkable from a public explorer:

1. Replace the shortened addresses in §1.2 with the full ones above and look
   them up on `sepolia.etherscan.io`.
2. Each trade in Part 2 is an Etherscan transaction from
   `0x6D6EC9eF12071eCF3EfcA5C405120B27C10976E5` to the engine
   `0x64B793C3e25E687aDEf90ebE8325d5a1a594000d` with input
   `requestFlashLoan(...)`; the logs show the Aave flash-loan callback, both
   V2 swaps and the profit booking.
3. `engine.getBalance(0xC558DBd…9a3c)` at any block equals the campaign's
   cumulative confirmed gross profit at that point.
4. Re-running the scanner in dry mode (`SEND_CYCLES=0`) re-derives the same
   quotes from the same pools; `npx hardhat test` reproduces the 74-test
   safety suite.
