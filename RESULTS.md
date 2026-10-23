# Product test results — off-chain scanner + on-chain flash-loan bot (Sepolia)

**Date:** 2026-10-18 · **Network:** Sepolia (chain 11155111) · **Signer:** `0x6D6EC9eF12071eCF3EfcA5C405120B27C10976E5`

This documents the joint test of the off-chain scanner (`scanner/`) and the
on-chain flash-loan engine (`contracts/FlashLoan.sol` + `DexRouteArbStrategy`),
executed end-to-end against **real Sepolia contracts**: the Aave V3 Pool, the
Uniswap V2 router, and the SushiSwap router. Every cycle, transaction and
ledger entry was recorded to append-only JSONL logs with derived CSV/markdown
artifacts under `results/` (gitignored run artifacts; regenerate with
`npm run e2e:sepolia`).

## 1. Environment (all facts verified live before execution)

| Component | Address / value | How verified |
| --- | --- | --- |
| Aave V3 Pool (Sepolia) | `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951` | `FLASHLOAN_PREMIUM_TOTAL` = **5 bps** |
| Aave WETH reserve | `0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c` | config bitmap decode: active ✓, not paused ✓, **flashLoanEnabled ✓**, liquidity ≈ 0.02 WETH |
| Uniswap V2 router / factory | `0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3` / `0xF62c03E08ada871A0bEb309762E260a7a6a880E6` | `getAmountsOut` live, `createPair` used |
| SushiSwap router / factory | `0xeabce3e74ef41fb40024a21cc2ee2f5ddc615791` / `0x734583f62bb6ace3c9ba9bd5a53143ca2ce8c55a` | V2-compatible surface verified live, `createPair` used |
| Engine / strategy | `0xC18cF01df154Ea33EC548455209cd7C48fB3e58c` / `0xE6cb3F47911392E1875223F1cF4bA99A338c5889` | deployed by this test, registered + trusted |
| Mid token (test GTT) | `0xECC06411598F1c2C2F2383157f8d5Ac01E28587c` | mintable test ERC-20 |
| Pools seeded | UniV2: 0.1 WETH ↔ 100 GTT (1000/WETH) · Sushi: 0.1 WETH ↔ 92 GTT (920/WETH) | **8.7% deliberate price gap** |
| Flash-loan notional | 0.002 WETH per cycle | fits Aave's ~0.02 WETH pool liquidity |

**Borrow-asset sourcing decision:** the wallet held only Sepolia ETH (no
faucet tokens), Aave's Sepolia WETH reserve is flash-loan-enabled with usable
liquidity, and WETH9 `deposit()` is permissionless — so the run wraps ETH→WETH
for pool seeding and flash-borrows the notional from Aave itself. No faucet
claim needed.

## 2. What happened (runs 1–9, all recorded)

Runs 1–7 were setup phases that surfaced and fixed real-world failures
(public-RPC "replacement transaction underpriced" errors *after* acceptance,
missing GTT mint, resume-after-interruption). The substantive runs:

### Run `sepolia-e2e-8` — the live trade ✅

- 2 dry-run cycles: opportunity found, `staticCall` against the **real Aave
  pool** passed. Quoted gross **73,688,138,478,710 wei**.
- 1 send cycle: **transaction confirmed**

  | Field | Value |
  | --- | --- |
  | Tx | `0x8f130da23d9cd7043a3486cea80e437c7cac3d3f8b9142dbf113f810ee2dc914` |
  | Block | 11942095 (Sepolia) |
  | Status | success (status=1) |
  | Gas used | 961,948 units @ 2.0 gwei effective = **0.001923896 ETH** |
  | Confirmation latency | 12,395 ms |

- On-chain flow proven end-to-end: `requestFlashLoan` → Aave pool →
  `executeOperation` → strategy → Uniswap V2 swap → SushiSwap swap → repay →
  profit booked on the engine.

### Run `sepolia-e2e-9` — convergence + correct refusal, full ledger ✅

- Resume path re-used the deployed engine/strategy/token and skipped
  already-seeded pools (only wraps/mint/scan ran; exit 0).
- After trade 1 repriced the pools (gap 8.7% → ~2.2%), all 3 cycles
  evaluated **unprofitable** (`grossProfit -85,712,347,772,292 < required 0`)
  and **sent nothing** — the scanner's refusal is correct: at 0.002 size,
  constant-product impact + 0.6% fees ≈ 4.6% > remaining 2.2% gap.
- Ledger over blocks 11940093–11942173:

  | Metric | Value |
  | --- | --- |
  | Attempts / executed / reverted | 1 / 1 / 0 |
  | Borrowed | 0.002 WETH |
  | Aave premium paid | 0.000001 WETH (5 bps) |
  | **Gross profit (retained in engine)** | **0.00007368813847871 WETH** |
  | Withdrawn | 0 |

- Cross-check: quoted gross (run 8) = ledger `grossProfit` = live
  `engine.getBalance(WETH)` — all three independently report
  **73,688,138,478,710 wei**. The off-chain math and the on-chain accounting
  agree exactly.

## 3. Findings

### F1 — the scanner approved a net-negative trade (gas-model defect) ⚠️

**Status (2026-10-19): fixed** — gas-price floor applied, plus an on-chain
net-profit guard; details and verification in §6.

The arb was gross-profitable (+73.7 µETH vs 1 µETH premium), but the actual
tx cost **0.001923896 ETH** in gas — ~26× the profit — so the trade was
**net ≈ −0.00185 ETH**. Root cause: the scanner prices gas from
`provider.getFeeData()` (`scan.js:getGasPriceWei`), which reported
**20 wei/gas** at decision time (Sepolia basefee ≈ 16 wei at that instant),
while the transaction was actually broadcast with hardhat's pinned
`gasPrice: 2 gwei` (both pins and effective receipt price verified: exactly
2.0 gwei). The netting therefore saw 26,128,860 wei of gas instead of
1,923,896,000,000 wei and passed its own profitability gate.

**Recommended fix (not yet applied):** make the gas-price source that the
decision uses identical to the price the sender will use — e.g. allow
`gasPriceFloorWei` in config / env and use `max(feeData, floor)` in
`getGasPriceWei`, or pass hardhat's resolved network `gasPrice` into
`scanOnce`. With floor = 2 gwei this cycle would correctly have been
*skipped* at evaluation time.

### F2 — market convergence behaved exactly as arbitrage theory predicts

One trade moved the pools from 8.7% apart to ~2.2% apart; every subsequent
evaluation was correctly negative. The scanner refuses losing cycles —
`profitable: 0, sent: 0, errors: 0` in run 9 is a pass, not a failure.

### F3 — public Sepolia RPCs are hostile to naive send loops

`eth_sendRawTransaction` sometimes returns an error *after* accepting the tx
(observed: "replacement transaction underpriced"), and `eth_getLogs` can be
served by a node whose head lags your own confirmed blocks ("requested N,
head N−1"). Mitigations added at the cause: `sendWait` effect-verification
everywhere in `run.js` setup, ledger fetch retries with graceful degradation,
and resume support (`ENGINE_ADDRESS` / `ROUTE_STRATEGY_ADDRESS` / `MID_TOKEN`
/ `LEDGER_FROM_BLOCK` env vars) so an interrupted run never re-deploys.

### F4 — testnet gas dominates micro-arb economics

At 2 gwei, a ~962k-gas flash-loan tx costs ~0.0019 ETH; at genuinely
near-zero basefee, an EIP-1559 tx still pays a priority-fee floor. Profitable
arbitrage at 0.002 WETH notional is impossible on testnet when gas is
metered realistically — expected, and precisely why F1's fix matters: the
scanner must *know* this and skip, which it failed to do here.

## 4. Raw artifacts

| File | Contents |
| --- | --- |
| `results/sepolia-e2e-8.jsonl` | run header, setup facts, 2 dry cycles, 1 confirmed send (tx hash, gasUsed, gasPriceUsed, confirmMs) |
| `results/sepolia-e2e-9.jsonl` | resumed run, 3 refusal evaluations, full ledger snapshot, engine balance |
| `results/sepolia-e2e-9-summary.md` | human report incl. ledger JSON |
| `results/sepolia-e2e-9-trades.csv` | trade rows (empty in run 9: no tx sent) |
| `results/hardhat-*.jsonl` + siblings | local rehearsal runs (mock market, 11.5 mWETH profit, 57/57 tests) |

Reproduce: `npm test` (68 passing as of 2026-10-19) · `npm run e2e` (local) ·
`npm run e2e:sepolia` (live; requires funded `PRIVATE_KEY` in `.env`).

## 5. Limitations

- Alerts (`ALERT_WEBHOOK_URL`) were not exercised against a real Slack/
  Discord endpoint; per-trade gas accounting in the *ledger* still reports
  gross premium/profit only (actual gas lives in the cycle records/CSV).
- The seeded GTT/WETH market is test-only by construction; F1's fix should be
  validated with a cycle whose notional makes gas a designed part of the gate
  (or a local rerun with a forced `gasPriceFloorWei`).
- Only the V2-style `getAmountsOut` quoting path is exercised; no V3 quoter.

## 6. Post-test hardening (2026-10-19)

### Profit custody and withdrawal — where the money is

Realized profit **stays in the engine contract** (`FlashLoan`) as one ERC-20
balance per asset (`engine.getBalance(asset)`); nothing is swept
automatically. `withdraw(token)` (owner-only) transfers the token's entire
balance to `engine.owner()`. Verified live at block 11948653:

| Fact | Value |
| --- | --- |
| Engine | `0xC18cF01df154Ea33EC548455209cd7C48fB3e58c` |
| `owner` (the address withdrawals go to) | `0x6D6EC9eF12071eCF3EfcA5C405120B27C10976E5` (= the test signer/deployer) |
| `keeper` | same address |
| Retained WETH profit (not yet withdrawn) | 73,688,138,478,710 wei |
| `minProfitFloor` / `paused` | 0 / false |

### F1 fixed: the decision now prices gas at what the sender pays

`scan.js:getGasPriceWei` now returns **max(feeData, gasPriceFloorWei)**
(`gasPriceFloorWei` in scanner config, `GAS_PRICE_FLOOR_WEI` in env; an empty
env value counts as unset, and a malformed value throws instead of silently
disabling protection). The Sepolia E2E harness defaults the floor to **2
gwei** — the price the run-8 transaction actually paid — so the same
cycle is now refused at the gate (`GAS_PRICE_FLOOR_WEI=0` restores the old
behavior for reproducing a live send).

Verified three ways: unit tests for the floor and its degraded-provider
path; a send-mode regression test where a 1M-gwei floor makes the gate
refuse and broadcast nothing; and a full orchestrator rerun
(`GAS_PRICE_FLOOR_WEI=1e14`) where the mock opportunity is evaluated
unprofitable in both dry and send cycles — **0 sent, 0 errors, exit 0**.

### Net-profit guard on-chain

New config `netProfitOnChain` (default true): when the borrowed asset wraps
native ETH, the `minProfit` passed to `requestFlashLoan` **includes the gas
budget** (`minProfit = floor + gasUnits × gasPriceFloorWei`), so the engine's
`Unprofitable` revert fires on trades that cannot cover their own gas. The
on-chain guard now enforces the same net requirement the off-chain gate
does — a scanner bug or state race can no longer let a net-negative trade
settle. Set `netProfitOnChain: false` to enforce only the gross floor.

### Never pay for a failed transaction: gates before broadcast

1. **eth_call preflight (always on):** `requestFlashLoan.staticCall` runs
   with the exact send arguments (including the gas-inclusive on-chain
   minProfit) immediately before broadcast; a revert is recorded
   (`preflight.ethCall = "revert"`) and nothing is sent. Free.
2. **Tenderly dry-run (optional, fail-closed):** `scanner/lib/tenderly.js`
   simulates the exact transaction via Tenderly's REST simulate API
   (`.../account/{slug}/project/{slug}/simulate`, `save:false`) before
   broadcast; a simulated revert blocks the send (`blockedBy: "tenderly"`).
   `strict` (default true) also blocks on API/infra errors; `strict:false`
   degrades to the eth_call gate. Enable via `tenderly` config or
   `TENDERLY_ACCESS_TOKEN` / `TENDERLY_ACCOUNT_SLUG` / `TENDERLY_PROJECT_SLUG`
   (Tenderly API access requires a paid plan).
3. **Private submission (`SUBMIT_RPC_URL` / `config.submitRpcUrl`):**
   `scanner/lib/submit.js` signs and sends through a private RPC — e.g.
   Flashbots Protect (Sepolia `https://rpc-sepolia.flashbots.net/`, mainnet
   `https://rpc.flashbots.net/fast`), which accepts standard
   `eth_sendRawTransaction`, hides the tx from the public mempool, and per
   Flashbots' default policy does **not include reverting transactions** —
   so a trade that would revert costs no gas at all. Quotes still come from
   the read provider; only the send goes private.

Test suite: **68 passing** (11 new tests: floor pricing + F1 regression,
net guard on/off, four Tenderly gate cases, submit-signer resolution). Local
rehearsal (`npm run e2e`) still books exactly 11.5 mWETH with the net guard
active; the forced-floor rerun refuses the same trade and exits 0.

## 7. Live campaign — 50 consecutive flash-loan trades (2026-10-19)

**Full chronicle, system description and verification guide: `CAMPAIGN.md`.**
Raw log `results/sepolia-campaign-1.jsonl` (260 entries) + summary/CSV/config
siblings. Fresh stack: engine `0x64B793C3e25E687aDEf90ebE8325d5a1a594000d`,
strategy `0x0ED28277A44FEce027d54bCd3cF9d2Fe6d6e03dD`, blocks 11950835–11950986.

### What ran

A campaign-mode run (`RESTORE_GAP=true`, relaxed demo gates per §6:
`GAS_PRICE_FLOOR_WEI=0`, `netProfitOnChain: false`): 2 dry cycles (correctly
refused the converged market), then 50 send cycles. Between every send cycle
the new gap-restoration loop (`scanner/lib/restore.js` + `run.js`) read both
pairs' real reserves and executed constant-product swaps through the real
UniV2/Sushi routers to move each venue back to its target price — 100/100
restore swaps confirmed, prices landing on target (1000.0 / 920.0) every
cycle. Holdings snapshots (wallet/engine balances) were taken at baseline,
before/after every send and at the end.

### Results

| Metric | Value |
| --- | --- |
| Send cycles / confirmed / reverted / errors | 50 / **50** / 0 / 0 |
| Hurdles (RPC ambiguity, retries, recoveries) | **0** during the campaign window |
| Gross profit (sum of confirmed evals) | 3,691,297,928,452,727 wei (avg 73.83 µ/trade, 3.69 % of 0.002 notional) |
| Aave premium paid | 50,000,000,000,000 wei (50 × 5 bps of 0.002) |
| Gas: trades / restores / total | 47,234,752,000,000,000 / 29,084,456,000,000,000 / **76,319,208,000,000,000** wei |
| **True net (gross − all gas)** | **−72,627,910,071,547,273 wei** (−0.0726 ETH) — negative *by design* at the 2 gwei pin: F1 reproduced live, reported honestly |
| Avg confirmation latency | 9,351 ms (~36 s wall per full cycle) |
| Engine WETH balance | 73,698,131,785,054 → 3,764,996,060,237,781 (live-re-read; 0 withdrawn) |

### Three-way cross-check (all exact to the wei)

Recorder realized profit = final − baseline engine balance = Σ of per-trade
engine-balance deltas derived from the 50 `FlashLoanExecuted` events =
**3,691,297,928,452,727**. Event counts 50 requested = 50 executed = 50
confirmed sends; borrowed 0.1 / premium 0.00005 as expected (50 × 2e15 /
50 × 1e12); ETH spent from snapshots (0.076319208) equals trade+restore gas
exactly. **Event-semantics caveat:** `FlashLoanExecuted.profit` is
`balance − owed` = the engine's whole post-trade balance, not the per-trade
delta — naively summing the 50 events yields 97,760,859,690,363,821 (a sum of
running balances); the true figure is `last event − pre-campaign balance`.

### Pre-campaign incidents (also part of the record)

The first live smoke caught a real bug before the campaign spent anything:
the restore solver had inverted pool mechanics (swapping into a pool grows
its input-token reserve), pushing prices 961 → 924 instead of → 1000; the
safety gates correctly refused every send (0 transactions spent). Fixed in
`scanner/lib/restore.js`, unit tests corrected to real constant-product
mechanics, and a second smoke validated restores landing exactly on target
plus one confirmed trade before the 50-cycle commit.

Test suite now **74 passing** (6 new restore-solver tests; the 68 existing
tests unchanged and green, including the local `npm run e2e` rehearsal which
still books exactly 11.5 mWETH).
