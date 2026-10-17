// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

/// @notice Minimal stand-in for Aave's PoolAddressesProvider: the engine's
///         base class only calls `getPool()` during construction.
contract MockPoolAddressesProvider {
    address public pool;

    constructor(address pool_) {
        pool = pool_;
    }

    function getPool() external view returns (address) {
        return pool;
    }

    function setPool(address pool_) external {
        pool = pool_;
    }
}