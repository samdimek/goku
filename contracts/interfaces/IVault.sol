// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import {IERC20} from "./IERC20.sol";
import {IFlashLoanRecipient} from "./IFlashLoanRecipient.sol";

/// @notice Minimal Balancer V2 Vault surface used by the flash-loan engine
///         (subset of balancer-v2-monorepo IVault).
///
/// Canonical deployments (same address on all three networks):
///   Arbitrum One     : 0xBA12222222228d8Ba445958a75a0704d566BF2C8  (go-live)
///   Ethereum mainnet : 0xBA12222222228d8Ba445958a75a0704d566BF2C8
///   Ethereum Sepolia : 0xBA12222222228d8Ba445958a75a0704d566BF2C8
///
/// Constraints enforced by the real Vault (the engine must respect them):
///   - `tokens` and `amounts` must have equal length,
///   - `tokens` must be sorted ascending by address (a single-token loan is
///     trivially sorted),
///   - the Vault must actually hold enough of each token to lend,
///   - `flashLoan` is nonReentrant — no nested Vault calls.
interface IVault {
    function flashLoan(
        IFlashLoanRecipient recipient,
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}
