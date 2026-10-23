// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import {IERC20} from "./IERC20.sol";

/// @notice Balancer V2 Vault flash-loan recipient callback (mirror of
///         balancer-v2-monorepo IFlashLoanRecipient).
///
/// The Vault transfers the borrowed tokens first, then calls this. The
/// recipient MUST transfer `amounts[i] + feeAmounts[i]` of each token back to
/// the Vault before returning: after this function returns, the Vault checks
/// that each token's balance was restored to at least its pre-loan balance
/// plus the fee, and reverts the whole transaction otherwise.
///
/// The fee is governance-set and has always been 0 on Balancer V2, but the
/// Vault passes `feeAmounts` explicitly — honor those values, never assume 0.
interface IFlashLoanRecipient {
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}
