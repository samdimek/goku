// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

/// @notice Uniswap V2 / SushiSwap / Fork-compatible router surface used by the
///         two-leg route strategy. V3 pools can be reached through the same
///         encoding via `exactInput`, or through the calldata strategy.
interface ISwapRouterV2 {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsOut(
        uint256 amountIn,
        address[] calldata path
    ) external view returns (uint256[] memory amounts);
}