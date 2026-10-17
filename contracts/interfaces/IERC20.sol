// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

/// @notice Minimal ERC20 surface used by the flash-loan engine and strategies.
/// Non-standard tokens (e.g. USDT) that omit return values are handled through
/// TokenUtils' low-level calls rather than this interface's return types.
interface IERC20 {
    function totalSupply() external view returns (uint256);

    function balanceOf(address account) external view returns (uint256);

    function transfer(address to, uint256 amount) external returns (bool);

    function allowance(address owner, address spender) external view returns (uint256);

    function approve(address spender, uint256 amount) external returns (bool);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}