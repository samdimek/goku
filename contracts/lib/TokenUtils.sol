// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import {IERC20} from "../interfaces/IERC20.sol";

/// @notice ERC20 helpers that tolerate non-standard tokens (tokens that do not
///         return a bool, e.g. USDT) and reset allowances before setting them.
library TokenUtils {
    error TransferFailed();
    error ApproveFailed();
    error BalanceOfFailed();

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    /// @dev Resets the allowance to 0 first so USDT-style tokens that require
    ///      zero-then-set approvals keep working.
    function safeApprove(address token, address spender, uint256 amount) internal {
        if (amount != 0) {
            (bool ok0, bytes memory ret0) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, 0));
            if (!ok0 || (ret0.length != 0 && !abi.decode(ret0, (bool)))) revert ApproveFailed();
        }
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert ApproveFailed();
    }

    function balanceOf(address token, address account) internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(IERC20.balanceOf.selector, account));
        if (!ok || ret.length != 32) revert BalanceOfFailed();
        return abi.decode(ret, (uint256));
    }
}