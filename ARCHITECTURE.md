# Goku Flash-Loan Architecture

> Aave V3 flash-loan **arbitrage engine**: borrow an ERC-20 with no collateral,
> exploit price discrepancies across exchanges inside one transaction, repay
> `amount + premium` in that same transaction, keep whatever surplus remains.

## 1. The goal

The codebase (a Hardhat project with one Aave-flavored contract) is building
toward a **self-funding arbitrage bot**:

1. Off-chain scanner spots a price gap for a token between two venues.
2. The bot borrows the token from Aave V3 via `flashLoanSimple` — no collateral,
   no capital at risk beyond gas.
3. Inside the callback the funds are swapped across the venues (buy low on A,
   sell high on B).
4. The loan + premium is repaid atomically; anything left over is **pure profit**
   resting in the contract until `withdraw()`.

If the trade is not profitable, the whole transaction reverts — the borrowed
principal was never at risk, only gas. That revert-on-loss property is enforced
**on-chain**, not by the bot's honesty: see the profit guard below.

Constraints chosen for this project:

- **Testnet-first**: Aave V3 Sepolia market (`0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A`).
- **Mainnet-ready**: switching networks only changes the address provider —
  the contract code is identical.

## 2. Component map

```text
contracts/
├── FlashLoan.sol                    ← ENGINE: Aave receiver + strategy registry
│                                      + owner/keeper auth + atomic profit guard
├── interfaces/
│   ├── IERC20.sol                   minimal ERC20 surface
│   ├── IStrategy.sol                the pluggable-strategy interface
│   └── ISwapRouterV2.sol            V2-compatible router surface
├── lib/
│   └── TokenUtils.sol               USDT-safe approve/transfer/balanceOf
└── strategies/
    ├── DexRouteArbStrategy.sol      approaches #1 + #2 (two-DEX, multi-hop cycle)
    └── CalldataArbStrategy.sol      approach #3 (aggregator / universal-router calldata)

scanner/                             ← OFF-CHAIN SCANNER (the bot half)
├── index.js                         polling CLI: quote → evaluate → staticCall → send
├── demoLocal.js                     offline end-to-end demo on the hardhat network
├── config.example.json              copy to config.json; venues, pairs, thresholds
└── lib/
    ├── abi.js                       minimale ABI fragments (router/engine/pool)
    ├── core.js                      pure logic: cycle validation, profit math,
    │                                slippage pins, route-param encoding
    └── scan.js                      on-chain quoting, gas pricing, simulation, send

scripts/deployFlashLoan.js           deploys engine + both strategies, registers them
test/{FlashLoan,scanner}.js         40 tests: contracts + scanner (unit & e2e)
mocks (contracts/mocks/)             MockPool, MockERC20, MockRouter (with quoter)
```

### Why the engine/strategy split

The loan mechanics (Aave callback, repayment approval, access control, profit
guard) never change. The *profitable idea* changes constantly. Splitting them
means:

- New arbitrage approaches are **new modules**, registered with
  `engine.registerStrategy(addr, true)` — no redeploy of the engine.
- Every strategy inherits the same guarantees for free: pool-only callbacks,
  self-initiation checks, atomic min-profit enforcement.
- Strategies are stateless between trades and can only be invoked *by the
  engine*, so a buggy module cannot be poked by an outsider.

## 3. Transaction flow

```
Bot (owner/keeper EOA)
  └─ requestFlashLoan(asset, amount, strategy, minProfit, strategyParams)
       └─ Aave POOL.flashLoanSimple(self, asset, amount, params, 0)
            ├─ (a) POOL --transfers amount--> engine
            └─ (b) POOL -> engine.executeOperation(asset, amount, premium, initiator, params)
                   ├─ require msg.sender == POOL            [NotPool]
                   ├─ require initiator == engine           [BadInitiator]
                   ├─ require loan is currently active      [NotInFlashLoan]
                   ├─ decode (strategy, minProfit, strategyParams)
                   ├─ engine --transfers amount--> strategy.execute(...)
                   │        └─ swaps / route / calldata legs → back to engine
                   ├─ require balance >= amount + premium + minProfit  [Unprofitable]
                   └─ approve POOL for amount + premium
            └─ (c) POOL pulls amount + premium; surplus stays in engine
  … owner later: engine.withdraw(token)
```

`params = abi.encode(strategy, minProfit, strategyParams)` — the strategy call
is fully determined by the loan request this contract itself made.

## 4. Arbitrage approaches (the strategy options)

| # | Approach | Module | When to use |
|---|----------|--------|-------------|
| 1 | **Two-DEX atomic arb**: `asset→X` on venue A, `X→asset` on venue B | `DexRouteArbStrategy` with 1-hop paths | The classic: same pair priced differently on Uniswap vs Sushi vs Curve-forks |
| 2 | **Multi-hop / cyclic arb**: `asset→X→…→asset`, possibly across 3+ pools | `DexRouteArbStrategy` with multi-hop paths (both legs must connect: `pathA[-1] == pathB[0]`) | Indirect mispricing, e.g. `WETH→USDC→DAI` vs a cheaper `WETH→DAI` pool |
| 3 | **Aggregator / bespoke executor**: any pre-composed calldata (1inch, 0x, Uniswap Universal Router commands) | `CalldataArbStrategy` with an allowlisted target | Routes too complex for plain V2 paths — the off-chain scanner composes the call, the on-chain guard still vetoes losses |

All three share one rule: **the borrowed asset must come back to the engine**,
converted by the route itself. The engine never accepts "profit in another
token" — a route that ends in a different token simply cannot repay and reverts.

### Off-chain counterpart — **built: `scanner/`**

The scanner (`scanner/index.js`, run with `npx hardhat run scanner/index.js
--network sepolia` or `npm run scan:sepolia`) implements the loop described in
this document:

1. **Quote**: for each configured opportunity, both legs are priced through the
   routers' `getAmountsOut` (quoted output ≈ executable output for V2 pools;
   always re-checked on-chain before sending).
2. **Price the loan**: premium is *read from the pool*
   (`FLASHLOAN_PREMIUM_TOTAL()`), never hard-coded — Aave governance can change it.
3. **Price the gas**: `requestFlashLoan.estimateGas` × `eth_gasPrice`; when the
   borrowed asset is the wrapped-native (config `wrappedAsset`), gas is netted
   directly out of the profit decision, so a "profitable" trade that costs more
   than it earns is never sent. Off-chain margin = per-opportunity `minProfitWei`.
4. **Simulate**: `requestFlashLoan.staticCall(...)` executes the entire flash
   loan against current state — the same atomic guard the chain enforces — and
   failure marks the opportunity unsent instead of burning gas.
5. **Send**: only with `SEND=true`. Optionally over a private relay
   (`SUBMIT_RPC_URL`, e.g. Flashbots Protect) so sandwich bots never see the
   transaction. Each leg carries slippage pins (`slippageBps`) as `minAmountOut`.

Safety defaults: **dry-run unless `SEND=true`**, `SCANNER_ONCE=true` for a single
pass, per-opportunity errors are reported rather than crashing the loop, and
invalid cycles are rejected by `core.validateCycle` before any RPC call.

### Ops layer — **built: alerts + P&L ledger**

- **Alerts** (`scanner/lib/alert.js`, wired into the scan loop): when a cycle
  yields a profitable opportunity, a POST-JSON payload (mode, per-opportunity
  profit, tx hash) goes to `ALERT_WEBHOOK_URL` (env, wins) or
  `alerts.webhookUrl` (config). Dry-run cycles stay silent unless
  `alerts.onDryRun: true`. The notifier never throws — a failed webhook logs and
  the loop continues. Payloads are dry-run/`send`-aware; unit-tested via an
  injected transport.
- **P&L ledger** (`npm run ledger`): aggregates `FlashLoanRequested`,
  `FlashLoanExecuted` and `Withdrawn` events in configurable block chunks into
  per-asset (borrowed / premium / gross profit / withdrawn / **retained in
  contract**) and per-strategy rows, rendered with per-token decimals. This is
  the accounting feed for the "is the bot actually profitable?" question and
  the alert in §7.4. Reverted trades emit no events — by design they moved no
  funds.

`npm run scan:demo` runs the whole path offline against a mock market with a
deliberate 1.2% price gap and asserts the exact realized profit.

## 5. Security model

| Threat | Defense |
|---|---|
| Fake `executeOperation` calls | `msg.sender == POOL` (immutable, from the address provider) |
| Relayed/stale callbacks | `initiator == address(this)` + `_loanActive` flag set only around our own request → no reentrancy / nested loans |
| Losing trades | Atomic `balance >= amount + premium + minProfit` — revert the entire tx |
| Rug-by-module | Strategies registered by owner only; strategies only callable **by the engine** |
| Malicious route targets | Router/target **allowlists** on each strategy module + canonical `V2` function signature (no arbitrary selector from params — Calldata strategy is the one exception, hence allowlisted) |
| Admin key compromise | `onlyOwner` on registry/pause/withdraw/keeper; `setPaused(true)` emergency brake; `minProfitFloor` stops the keeper from firing zero-margin trades |
| Non-standard tokens (USDT) | All transfers/approvals via `TokenUtils` low-level calls with zero-then-set approve |
| Keeper abuse | Keeper can only request loans already bounded by `minProfitFloor`; it can never withdraw funds |

Known limitations (by design, documented for the audit path):

- Profits accumulate in the contract; sweep with `withdraw()`. No auto-compound.
- `CalldataArbStrategy` executes its calldata verbatim — only allowlist targets
  you have reviewed.
- Strategy modules approve routers from their own balance and assume the
  borrowed asset round-trips; fee-on-transfer tokens are unsupported.

## 6. Networks & configuration

| Network | PoolAddressesProvider | Notes |
|---|---|---|
| **Sepolia** (default testnet) | `0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A` | Aave V3 test market + faucet tokens |
| **Ethereum mainnet** (go-live) | `0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e` | Same code, `--network mainnet` |
| Local `hardhat` | auto deployed `MockPoolAddressesProvider` | offline dev/deploy smoke tests |

Override for forks/new markets with `POOL_ADDRESSES_PROVIDER` in `.env`
(see [.env.example](.env.example)). Solidity is pinned to **0.8.10** because
`@aave/core-v3`'s `FlashLoanSimpleReceiverBase` uses an exact `pragma 0.8.10`.

```shell
npx hardhat compile
npx hardhat test
npx hardhat run scripts/deployFlashLoan.js --network sepolia

npm run scan:demo                  # offline end-to-end scanner demo
npm test                           # 40 tests (contracts + scanner)
cp scanner/config.example.json scanner/config.json   # then fill in addresses
npm run scan                       # dry-run scanner loop (local/network)
npm run scan:sepolia               # dry-run on Sepolia
SEND=true npm run scan:sepolia     # actually trade (needs funded key + registered modules)
SCANNER_ONCE=true npm run scan:sepolia   # single pass, then exit
npm run ledger:sepolia             # P&L report for the deployed engine
```

Alert webhook: set `ALERT_WEBHOOK_URL` in `.env` (or `alerts.webhookUrl` in
config) to a Slack/Discord/Telegram bridge; ledger range/chunk/decimals live
under `ledger` in `scanner/config.json`.

Scanner configuration lives in `.env` (`SEPOLIA_RPC_URL`, `PRIVATE_KEY`,
optional `ENGINE_ADDRESS` / `ROUTE_STRATEGY_ADDRESS` / `SUBMIT_RPC_URL`
overrides) and `scanner/config.json` (venues, opportunity pairs, `amountIn`,
`minProfitWei`, `slippageBps`, `wrappedNativeAsset` for gas accounting).

Post-deploy (owner only), as printed by the script:

```js
routeStrategy.setTrustedRouter(<dex router>, true)    // per venue
calldataStrategy.setTrustedTarget(<agg executor>, true)
engine.setKeeper(<bot EOA>, true)                     // optional
engine.setMinProfitFloor(<wei>, ...)                  // optional
```

## 7. Path to production

1. **Fork tests**: run the suite against a real mainnet fork (`hardhat forking`)
   with live Uniswap V2/V3 + Sushi pools to validate real swap calldata.
2. **Off-chain scanner** (Node/bot): quote → simulate → gas-cost → send via
   Flashbots with `minProfit` set from simulation.
3. **Mainnet deploy**: `POOL_ADDRESSES_PROVIDER` already defaults to mainnet
   under `--network mainnet`; keep `registerStrategy` limited to audited modules.
4. **Audit + monitoring**: `npm run ledger` already renders the
   `FlashLoanRequested` / `FlashLoanExecuted(profit)` feed as per-asset and
   per-strategy P&L, and the alert hook fires on profitable cycles — extend it
   to also warn when profit is repeatedly 0 (keeps paying gas on doomed routes).