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
├── FlashLoan.sol                    ← ENGINE (Aave V3): receiver + strategy registry
│                                      + owner/keeper auth + atomic profit guard
├── BalancerFlashLoan.sol            ← ENGINE (Balancer V2): same surface + auto-forwards
│                                      every trade's profit to the owner wallet (§8)
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
| **Arbitrum One** (go-live, chainId 42161) | `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb` | Live target. On-chain verified 2026-10-23: resolves Pool `0x794a61358D6845594F94dc1DB02A252b5b4814aD`, premium 5 bps, WETH reserve ~97.6k WETH. Balancer Vault `0xBA12222222228d8Ba445958a75a0704d566BF2C8` holds ~103.7 WETH. Gas floor 0.02 gwei; L1 data fee is inside `eth_estimateGas`. Flashbots does NOT support this chain. |
| **Sepolia** (testnet) | `0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A` | Aave V3 test market + faucet tokens |
| **Ethereum mainnet** | `0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e` | Same code, `--network mainnet` |
| Local `hardhat` | auto deployed `MockPoolAddressesProvider` | offline dev/deploy smoke tests |

Override for forks/new markets with `POOL_ADDRESSES_PROVIDER` in `.env`
(see [.env.example](.env.example)). Solidity is pinned to **0.8.10** because
`@aave/core-v3`'s `FlashLoanSimpleReceiverBase` uses an exact `pragma 0.8.10`.

```shell
npx hardhat compile
npx hardhat test
npm run deploy:arbitrum            # Aave engine to Arbitrum One (LIVE)
npm run deploy:balancer:arbitrum   # Balancer engine to Arbitrum One (LIVE)

npm run scan:demo                  # offline end-to-end scanner demo
npm test                           # 100 tests (contracts + scanner)
cp scanner/config.example.json scanner/config.json   # then fill in addresses
npm run scan                       # dry-run scanner loop (local/network)
npm run scan:arbitrum              # dry-run on Arbitrum One
SEND=true npm run scan:arbitrum    # actually trade (needs funded key + registered modules)
SCANNER_ONCE=true npm run scan:arbitrum   # single pass, then exit
npm run ledger:arbitrum            # P&L report for the deployed engine
```

Alert webhook: set `ALERT_WEBHOOK_URL` in `.env` (or `alerts.webhookUrl` in
config) to a Slack/Discord/Telegram bridge; ledger range/chunk/decimals live
under `ledger` in `scanner/config.json`.

Scanner configuration lives in `.env` (`ARBITRUM_RPC_URL`, `PRIVATE_KEY`,
optional `ENGINE_ADDRESS` / `ROUTE_STRATEGY_ADDRESS` / `SUBMIT_RPC_URL`
overrides) and `scanner/config.json` (venues, opportunity pairs, `amountIn`,
`minProfitWei`, `slippageBps`, `wrappedNativeAsset` for gas accounting).

Arbitrum-specific facts baked into the defaults (all verified on-chain
2026-10-23): WETH `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`; minimum gas
price 0.02 gwei (`ArbGasInfo.getMinimumGasPrice`) with a 0.05 gwei scanner
floor; the L1 data fee is already folded into `eth_estimateGas` by the
sequencer, so the gate's `gasUnits * gasPrice` is the complete cost; Flashbots
Protect does not support chainId 42161 — the sequencer's mempool is already
private and provider-level MEV protection (Alchemy/QuickNode) is the
available option.

Post-deploy (owner only), as printed by the script:

```js
routeStrategy.setTrustedRouter(<dex router>, true)    // per venue
calldataStrategy.setTrustedTarget(<agg executor>, true)
engine.setKeeper(<bot EOA>, true)                     // optional
engine.setMinProfitFloor(<wei>, ...)                  // optional
```

## 7. Path to production (Arbitrum One)

1. **Fork tests**: run the suite against a real Arbitrum fork (`hardhat forking`
   with `ARBITRUM_RPC_URL`) and live Uniswap V2 + Sushi pools to validate real
   swap calldata.
2. **Off-chain scanner** (Node/bot): quote → simulate → gas-cost → send with
   `minProfit` set from simulation. On Arbitrum the L1 data fee is already in
   `eth_estimateGas`, so no extra fee line is needed.
3. **Arbitrum deploy**: `npm run deploy:arbitrum` (Aave) or
   `npm run deploy:balancer:arbitrum` (Balancer, auto-forwards profit); both
   presets default to the on-chain-verified Arbitrum addresses; keep
   `registerStrategy` limited to audited modules.
4. **Audit + monitoring**: `npm run ledger:arbitrum` already renders the
   `FlashLoanRequested` / `FlashLoanExecuted(profit)` feed as per-asset and
   per-strategy P&L, and the alert hook fires on profitable cycles — extend it
   to also warn when profit is repeatedly 0 (keeps paying gas on doomed routes).

Note: Flashbots Protect is Ethereum-L1-only and cannot relay Arbitrum
transactions; rely on the sequencer's private mempool, or a provider endpoint
(Alchemy/QuickNode) with MEV protection enabled.

## 8. Balancer V2 engine — zero-fee loans with auto-forwarded profits

`contracts/BalancerFlashLoan.sol` is a second engine with the **same external
surface** as the Aave one — identical `requestFlashLoan(asset, amount,
strategy, minProfit, strategyParams)` signature and identical
`FlashLoanRequested` / `FlashLoanExecuted` / `Withdrawn` events — so the
scanner, P&L ledger, results generator and alert hook drive either engine
unchanged (select via `flashLoanProvider` in the scanner config).

### Why Balancer

- **0% flash-loan fee** (governance-set, always 0). The Aave premium is
  0.05% — on the campaign's 0.1 WETH notional that was ~50,000,000,000,000 wei
  per trade; Balancer removes it entirely.
- Same canonical Vault on mainnet, Sepolia **and Arbitrum One**:
  `0xBA12222222228d8Ba445958a75a0704d566BF2C8` (on-chain verified on
  Arbitrum: holds ~103.7 WETH of lendable balance; override with
  `BALANCER_VAULT`).
- The fee is still **honored, not assumed**: the callback's `feeAmounts[0]`
  is what gets repaid. If governance ever sets a fee, mispriced trades
  *revert* (Unprofitable) — never a silent loss.

### Transaction flow

```
Bot (owner/keeper EOA)
  └─ requestFlashLoan(asset, amount, strategy, minProfit, params)
       └─ Vault.flashLoan(self, [asset], [amount], userData)     (nonReentrant)
            ├─ (a) Vault --transfers amount--> engine
            └─ (b) Vault -> engine.receiveFlashLoan(tokens, amounts, feeAmounts, userData)
                   ├─ require msg.sender == VAULT               [NotVault]
                   ├─ require single-token shape (len == 1)     [BadLoanShape]
                   ├─ require loan is currently active          [NotInFlashLoan]
                   ├─ decode (strategy, minProfit, strategyParams); registry check
                   ├─ engine --transfers amount--> strategy.execute(...)
                   │        └─ swaps / route / calldata legs → back to engine
                   ├─ require balance >= amount + fee + minProfit  [Unprofitable]
                   ├─ transfer amount + fee -> VAULT            [repay in callback]
                   └─ transfer profit -> profitRecipient        [AUTO-FORWARD]
            └─ (c) Vault checks its balance was restored (+fee), tx completes
```

Differences from the Aave engine, and why:

| | Aave V3 engine | Balancer V2 engine |
|---|---|---|
| Entry | `Pool.flashLoanSimple` | `Vault.flashLoan(tokens[], amounts[])` |
| Fee source | pool's `FLASHLOAN_PREMIUM_TOTAL` (0.05%) | callback's `feeAmounts[0]` (0% today) |
| Repayment | approve; the Pool **pulls** after the callback | plain transfer back **inside** the callback (the Vault re-checks its own balance right after) |
| Initiator check | `initiator == address(this)` param | `_loanActive` flag (the Balancer callback carries no initiator; the Vault's `nonReentrant` rules out nested calls) |
| Profit destination | retained in the engine until `withdraw()` | **auto-forwarded to `profitRecipient` in the same tx** |

### Auto-forward (instruction: no waiting to withdraw)

After the atomic guard passes and the Vault is repaid, the **entire surplus is
transferred to `profitRecipient` inside the callback** — your wallet is funded
by the same transaction that earned it. The engine retains ~0; `withdraw()`
stays only as a rescue for stray balances (e.g. direct transfers), and it
sweeps to the same profit wallet.

- `profitRecipient` is a **required constructor argument** (reverts on zero
  address, and the deploy script refuses a malformed address before ever
  broadcasting): execution is impossible before the profit destination exists.
- `setProfitRecipient` (owner-only) rotates it later.
- Every sweep also emits `Withdrawn`, so the P&L ledger's `retained`
  (= gross − withdrawn) stays correct with **zero ledger changes**.

### Configuration & deployment

```shell
npm run deploy:balancer:local       # mock Vault, offline rehearsal
npm run deploy:balancer:arbitrum    # real Vault on Arbitrum One (go-live)
npm run deploy:balancer:sepolia     # real Vault on Sepolia
npm run deploy:balancer:mainnet     # real Vault on Ethereum mainnet
# PROFIT_RECIPIENT in .env overrides the default wallet; BALANCER_VAULT
# overrides the Vault address per network.
```

Scanner: set `"flashLoanProvider": "balancer"` in `scanner/config.json` so
the off-chain premium estimate is 0 bps (`flashLoanFeeBps` overrides if
governance ever charges). Everything else — quoting, gas floor (F1),
`netProfitOnChain`, eth_call preflight, Tenderly, private submission,
ledger — works identically.

### Security model (same posture as §5, Balancer-specific notes)

| Threat | Defense |
|---|---|
| Fake `receiveFlashLoan` | `msg.sender == VAULT` (immutable) |
| Stray/relayed callback | `_loanActive` — set only around our own `flashLoan` call |
| Multi-token relayed loan | `BadLoanShape` — the engine only ever borrows a single, trivially-sorted token |
| Profit misrouting | required constructor arg + `onlyOwner` rotation, checksum-validated at deploy |
| Hidden future fee | repayment uses the callback's actual `feeAmounts`, never a hard-coded 0 |

Trade-off to know: the auto-forward adds one ERC-20 transfer per trade (a few
ten-thousand gas) — the price of never leaving profit sitting in a hot
contract. The Aave engine is untouched (campaign-verified bytecode); pick the
provider per deployment.