// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import {IFlashLoanSimpleReceiver} from "@aave/core-v3/contracts/flashloan/interfaces/IFlashLoanSimpleReceiver.sol";
import {TokenUtils} from "../lib/TokenUtils.sol";

/// @notice Local stand-in for Aave's Pool.flashLoanSimple:
///   1. transfer `amount` of `asset` to the receiver,
///   2. call `executeOperation(...)` on it,
///   3. pull `amount + premium` back (via the approval set in the callback).
/// The pool must be pre-funded with the borrowed asset + premium in tests.
contract MockPool {
    /// @dev Aave's default flash-loan premium is 0.05% (5 bps).
    uint256 public premiumBps = 5;

    function setPremiumBps(uint256 premiumBps_) external {
        premiumBps = premiumBps_;
    }

    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 /* referralCode */
    ) external {
        uint256 premium = (amount * premiumBps) / 10000;
        TokenUtils.safeTransfer(asset, receiverAddress, amount);
        IFlashLoanSimpleReceiver(receiverAddress).executeOperation(
            asset, amount, premium, msg.sender, params
        );
        TokenUtils.safeTransferFrom(asset, receiverAddress, address(this), amount + premium);
    }

    /// @notice Test helper: lets a test call `executeOperation` directly to
    ///         verify the engine's pool/initiator guards.
    function invokeExecute(
        address receiver,
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external {
        IFlashLoanSimpleReceiver(receiver).executeOperation(
            asset, amount, premium, initiator, params
        );
    }
}