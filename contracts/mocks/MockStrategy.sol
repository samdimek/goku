// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import {IStrategy} from "../interfaces/IStrategy.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {TokenUtils} from "../lib/TokenUtils.sol";

/// @notice Test-only strategy that simulates an arbitrage outcome: the engine
///         sends it `amount`, it replies with `amount + simulateProfit` from its
///         prefunded balance. Set simulateProfit below premium+minProfit to
///         exercise the engine's unprofitable-trade revert.
contract MockStrategy is IStrategy {
    error NotEngine();

    address public immutable engine;
    uint256 public simulateProfit;

    constructor(address engine_) {
        engine = engine_;
    }

    function setSimulateProfit(uint256 profit) external {
        simulateProfit = profit;
    }

    function execute(address asset, uint256 amount, bytes calldata) external override {
        if (msg.sender != engine) revert NotEngine();
        // Principal arrived from the engine; return it plus simulated profit.
        TokenUtils.safeTransfer(asset, engine, amount + simulateProfit);
    }
}