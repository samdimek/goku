# Goku — Flash-Loan Arbitrage Engine (Aave V3 + Balancer V2)

See [ARCHITECTURE.md](ARCHITECTURE.md) for the goal, component map, transaction
flow, arbitrage strategy options, the off-chain scanner and the go-live checklist.

Two flash-loan engines, same external surface (same `requestFlashLoan`
signature + identical events, so one scanner drives both):

- `contracts/FlashLoan.sol` — Aave V3 (`flashLoanSimple`, premium read from
  the pool, repayment via approval).
- `contracts/BalancerFlashLoan.sol` — Balancer V2 (`IVault.flashLoan`,
  0-bps fee honored from the callback's `feeAmounts`, repayment by transfer
  inside the callback, **every trade's profit auto-forwarded to your wallet
  in the same transaction** — no `withdraw()` wait). See ARCHITECTURE §8.

## Common commands

Go-live network: **Arbitrum One (chainId 42161)** — real mainnet. All Arbitrum
addresses below are pinned from on-chain verification (Aave V3 provider
`0xa976...3CDb` → Pool `0x794a...14aD`, premium 5 bps, WETH reserve ~97.6k;
Balancer Vault `0xBA12...F2C8` holding ~103.7 WETH; Uniswap V2 + SushiSwap
factories cross-checked via each router's `factory()`).

```shell
npm run compile                    # solc 0.8.10 (pinned by @aave/core-v3)
npm test                           # 100 tests: contracts + scanner

npm run deploy:local               # Aave engine + strategies on hardhat
npm run deploy:arbitrum            # Aave engine to Arbitrum One (LIVE)
npm run deploy:balancer:local      # Balancer engine (mock Vault) on hardhat
npm run deploy:balancer:arbitrum   # Balancer engine to Arbitrum One (LIVE)

npm run scan:demo                  # offline scanner demo (mock market, real tx)
cp scanner/config.example.json scanner/config.json   # then fill in addresses
npm run scan                       # scanner loop, dry-run (never sends)
npm run scan:arbitrum              # dry-run against Arbitrum One
SCANNER_ONCE=true npm run scan:arbitrum   # single scan pass then exit
SEND=true npm run scan:arbitrum    # actually trade (beware: real funds!)

npm run ledger                     # P&L report from FlashLoanExecuted events
npm run ledger:arbitrum            # same, on Arbitrum One

npx hardhat help
npx hardhat node
```

Testnet commands (`:sepolia`) and the Ethereum-mainnet Balancer deploy
(`deploy:balancer:mainnet`) still exist for reference; the live target is
Arbitrum. Two Arbitrum-specific notes baked into the configs:

- **Gas**: Arbitrum's minimum gas price is 0.02 gwei (verified on-chain via
  `ArbGasInfo.getMinimumGasPrice`); the scanner's F1 floor defaults to
  0.05 gwei on `--network arbitrum`. The L1 data fee is already included in
  `eth_estimateGas` by Arbitrum nodes, so `gasUnits * gasPrice` is the full
  cost — the existing accounting is correct without an extra L1 line.
- **Private submission**: Flashbots Protect does **not** support Arbitrum
  (chainId 42161). The sequencer's mempool is already private; for extra MEV
  protection use a provider endpoint (Alchemy/QuickNode) with it enabled.
  `SUBMIT_RPC_URL` still accepts any endpoint that serves
  `eth_sendRawTransaction`.

## Layout

- `contracts/FlashLoan.sol` — Aave V3 flash-loan engine (callback, strategy
  registry, atomic min-profit guard, owner/keeper auth)
- `contracts/BalancerFlashLoan.sol` — Balancer V2 flash-loan engine: same
  guards, plus per-trade profit auto-forward to the owner wallet
  (`PROFIT_RECIPIENT`; deploy script defaults to your wallet)
- `contracts/strategies/` — pluggable arbitrage modules (2-DEX / multi-hop
  routes, allowlisted aggregator calldata)
- `scanner/` — off-chain bot: quotes → gas pricing → on-chain simulation → send
- `test/` — contract + scanner test suites