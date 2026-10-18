// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import {TokenUtils} from "../lib/TokenUtils.sol";

/// @notice Minimal Uniswap-V2-compatible router for tests: 1:1 swap plus a
///         configurable bonus paid out of the router's prefunded balance,
///         simulating a venue whose price is better than parity. Prefund the
///         router with `path[path.length-1]` tokens before swapping.
contract MockRouter {
    /// @notice Extra basis points paid to the swapper on top of amountIn.
    uint256 public bonusBps;
    uint256 public constant BPS = 10000;

    function setBonusBps(uint256 bonusBps_) external {
        bonusBps = bonusBps_;
    }

    /// @notice V2-compatible quoter so the scanner can price routes locally:
    ///          pays this router's bonus on top of amountIn (1:1 base rate).
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts)
    {
        require(path.length >= 2, "BAD_PATH");
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[amounts.length - 1] = amountIn + (amountIn * bonusBps) / BPS;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(deadline >= block.timestamp, "EXPIRED");
        require(path.length >= 2, "BAD_PATH");

        uint256 amountOut = amountIn + (amountIn * bonusBps) / BPS;
        require(amountOut >= amountOutMin, "TOO_LITTLE_OUT");

        TokenUtils.safeTransferFrom(path[0], msg.sender, address(this), amountIn);
        TokenUtils.safeTransfer(path[path.length - 1], to, amountOut);

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[amounts.length - 1] = amountOut;
    }
}