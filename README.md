# Goku

A replica of the fearless, brave and with a warrior spirit Saiyan, with boundless determination and insatiable thirst for combat, combat against centralization of resources. All this in a mission to create a pure-hearted nature. G-O-K-U-!

---

## Introduction

Flash loans are the ultimate power-up in the exciting realm of decentralized finance (DeFi), a unique capability bestowed by the Ethereum blockchain.

Imagine having the ability to instantly summon enormous quantities of bitcoin without the need for collateral. You can use this tremendous power as long as the bitcoin is returned inside the same transaction block. Failure to repay the loan? Fear not—everything resets to protect the lender. Time and strategy are crucial in this high-stakes game, where only the bravest players succeed!

---

### Phase of a flash loan

1. Requesting for the loan:

   - Here, a user initiates a smart contract on a DeFi Protocol that supports flashloans, specifying the amount to be borrowed and the operations they intend to performed with the borrowed funds. The lending protocol could be Aave.
   - The code on this stage allows for the protocol to verify the request and upon approval, the specified amount of crypto is disbursed to the borrower's address, [contract's address].

2. Funds utilization:

   - Execution of Arbitrage Trades. The borrower may use the funds for arbitrage, this involves buying a cryptocurrency at a lower price in one exchange and selling it at a higher price on another exchange. For example; One borrows 100 ETH and buys at 99 in one exchange but selss at 102 ETH in another exchange.
   - Collateral swaps. The borrower could use the borrowed amount to repay an existing loan on one platform, withdraw the collateral and use it to open another loan on another platform with better interest rates.
   - Liquidation Processes. Borrowers can liquidate under-collaterized positions on DeFi protocols, taking advantage of discounted collateral sales.

3. Repayment:
   - Reversibility; All actions taken in a flashloan must be completed within a single transaction block. The contract should ensure any fees together with the borrowing amount is returned to the lending pool before the block is mined.
   - Condition validation; If the contract's conditions are met within the same transaction, repayment is made and the othe remaining tokens sent to the borrowers address. It is this economic incentive that propells human to build flashloans.

---
