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

Reproduce: `npm test` (57 passing) · `npm run e2e` (local) ·
`npm run e2e:sepolia` (live; requires funded `PRIVATE_KEY` in `.env`).

## 5. Limitations

- Alerts (`ALERT_WEBHOOK_URL`) were not exercised against a real Slack/
  Discord endpoint; per-trade gas accounting in the *ledger* still reports
  gross premium/profit only (actual gas lives in the cycle records/CSV).
- The seeded GTT/WETH market is test-only by construction; F1's fix should be
  validated with a cycle whose notional makes gas a designed part of the gate
  (or a local rerun with a forced `gasPriceFloorWei`).
- Only the V2-style `getAmountsOut` quoting path is exercised; no V3 quoter.
