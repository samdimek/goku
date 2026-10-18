# Goku — Aave V3 Flash-Loan Arbitrage Engine

See [ARCHITECTURE.md](ARCHITECTURE.md) for the goal, component map, transaction
flow, arbitrage strategy options, the off-chain scanner and the go-live checklist.

## Common commands

```shell
npm run compile                    # solc 0.8.10 (pinned by @aave/core-v3)
npm test                           # 40 tests: contracts + scanner

npm run deploy:local               # engine + strategies on the hardhat network
npm run deploy:sepolia             # deploy to Sepolia

npm run scan:demo                  # offline scanner demo (mock market, real tx)
cp scanner/config.example.json scanner/config.json   # then fill in addresses
npm run scan                       # scanner loop, dry-run (never sends)
SCANNER_ONCE=true npm run scan     # single scan pass then exit
SEND=true npm run scan             # actually trade (beware: real funds)

npm run ledger                     # P&L report from FlashLoanExecuted events
npm run ledger:sepolia             # same, on Sepolia

npx hardhat help
npx hardhat node
```

## Layout

- `contracts/FlashLoan.sol` — flash-loan engine (Aave callback, strategy
  registry, atomic min-profit guard, owner/keeper auth)
- `contracts/strategies/` — pluggable arbitrage modules (2-DEX / multi-hop
  routes, allowlisted aggregator calldata)
- `scanner/` — off-chain bot: quotes → gas pricing → on-chain simulation → send
- `test/` — contract + scanner test suites