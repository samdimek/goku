// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import {IERC20} from "../interfaces/IERC20.sol";
import {IFlashLoanRecipient} from "../interfaces/IFlashLoanRecipient.sol";
import {TokenUtils} from "../lib/TokenUtils.sol";

/// @notice Local stand-in for the Balancer V2 Vault's flashLoan, mirroring
///         the real contract's behavior (balancer-v2-monorepo FlashLoans.sol):
///   1. transfer `amounts[i]` of each token to the recipient,
///   2. call `receiveFlashLoan(tokens, amounts, feeAmounts, userData)` on it,
///   3. verify each token's balance was restored to at least its pre-loan
///      balance PLUS the fee — revert the whole transaction otherwise.
///
/// The recipient repays by transferring tokens back inside the callback (the
/// real Vault does NOT pull via transferFrom). The Vault must be pre-funded
/// with the borrowed asset; feeAmounts is amount * feeBps / 10000, and
/// feeBps defaults to 0 like Balancer governance has always kept it.
contract MockBalancerVault {
    error LengthMismatch();
    error NotRepaid(address token, uint256 balance, uint256 required);

    /// @dev Flash-loan fee in bps; 0 mirrors Balancer's standing setting.
    uint256 public feeBps;

    function setFeeBps(uint256 feeBps_) external {
        feeBps = feeBps_;
    }

    function flashLoan(
        IFlashLoanRecipient recipient,
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external {
        if (tokens.length != amounts.length) revert LengthMismatch();

        uint256 n = tokens.length;
        uint256[] memory feeAmounts = new uint256[](n);
        uint256[] memory balancesBefore = new uint256[](n);

        for (uint256 i = 0; i < n; i++) {
            balancesBefore[i] = TokenUtils.balanceOf(address(tokens[i]), address(this));
            feeAmounts[i] = (amounts[i] * feeBps) / 10000;
            TokenUtils.safeTransfer(address(tokens[i]), address(recipient), amounts[i]);
        }

        IFlashLoanRecipient(recipient).receiveFlashLoan(tokens, amounts, feeAmounts, userData);

        // Post-callback check, exactly like the real Vault: the pre-loan
        // balance must be restored at least the fee amount.
        for (uint256 i = 0; i < n; i++) {
            uint256 bal = TokenUtils.balanceOf(address(tokens[i]), address(this));
            uint256 required = balancesBefore[i] + feeAmounts[i];
            if (bal < required) revert NotRepaid(address(tokens[i]), bal, required);
        }
    }

    /// @notice Test helper: call receiveFlashLoan directly (bypassing
    ///         flashLoan) so tests can verify the engine's Vault/loan guards
    ///         without a loan in flight. `msg.sender` seen by the recipient
    ///         is this mock Vault.
    function invokeReceive(
        IFlashLoanRecipient recipient,
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external {
        recipient.receiveFlashLoan(tokens, amounts, feeAmounts, userData);
    }
}
