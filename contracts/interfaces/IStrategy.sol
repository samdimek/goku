// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

/// @title IStrategy
/// @notice Pluggable arbitrage logic executed by the FlashLoan engine inside
///         Aave's flash-loan callback.
///
/// Flow (all in one transaction):
///   1. The engine receives `amount` of `asset` from the Aave Pool.
///   2. The engine transfers `amount` of `asset` to this strategy.
///   3. The engine calls `execute(asset, amount, params)`.
///   4. The strategy performs its swaps/arbitrage and MUST transfer back to
///      msg.sender (the engine) at least `amount + premium + minProfit` worth
///      of `asset` before returning.
///   5. The engine verifies the final balance atomically and approves repayment.
///
/// If the strategy returns too little, the engine reverts the whole
/// transaction: the loan is never taken, only gas is spent.
interface IStrategy {
    /// @param asset   The borrowed ERC20 (already transferred to this contract).
    /// @param amount  The borrowed amount.
    /// @param params  Strategy-specific calldata, decoded inside the strategy.
    function execute(address asset, uint256 amount, bytes calldata params) external;
}