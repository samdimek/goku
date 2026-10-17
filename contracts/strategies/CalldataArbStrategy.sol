// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import {IStrategy} from "../interfaces/IStrategy.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {TokenUtils} from "../lib/TokenUtils.sol";

/// @title CalldataArbStrategy
/// @notice Arbitrage approach #3: execute pre-composed swap calldata against
///         allowlisted targets — aggregator routes (1inch, 0x, Odos),
///         Uniswap Universal Router commands, or a bespoke executor contract
///         that bundles more legs than the plain V2 route strategy can express.
///
/// Division of responsibility:
///   - Off-chain: build & quote the route, simulate it, assemble calldata.
///   - On-chain: only allowlisted targets are callable, only the engine can
///     invoke this, and the engine's atomic profit guard reverts the whole
///     transaction if the route does not return enough of the borrowed asset.
///
/// Never register a target you have not inspected: the calldata is executed
/// verbatim with the borrowed funds approved for it.
contract CalldataArbStrategy is IStrategy {
    // ---------------------------------------------------------------- errors
    error NotEngine();
    error NotOwner();
    error ZeroAddress();
    error UntrustedTarget();
    error CallFailed(bytes reason);
    error NoReturnData();

    // ---------------------------------------------------------------- events
    event TargetTrustSet(address indexed target, bool trusted);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /// @notice Only this engine may call `execute`.
    address public immutable engine;
    /// @notice Admin of the target allowlist (set to the engine owner).
    address public owner;
    /// @notice Executors/aggregators this strategy is allowed to call.
    mapping(address => bool) public trustedTarget;

    modifier onlyEngine() {
        if (msg.sender != engine) revert NotEngine();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address engine_) {
        if (engine_ == address(0)) revert ZeroAddress();
        engine = engine_;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /// @inheritdoc IStrategy
    function execute(address asset, uint256 amount, bytes calldata params)
        external
        override
        onlyEngine
    {
        // params = abi.encode(target, data)
        (address target, bytes memory data) = abi.decode(params, (address, bytes));

        if (!trustedTarget[target]) revert UntrustedTarget();

        // Let the target pull at most the borrowed amount from this contract
        // (aggregators and the Universal Router settle via transferFrom).
        TokenUtils.safeApprove(asset, target, amount);

        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) revert CallFailed(ret);
        if (ret.length == 0) revert NoReturnData();

        // Drop unspent approvals, then return everything to the engine.
        TokenUtils.safeApprove(asset, target, 0);
        TokenUtils.safeTransfer(asset, msg.sender, TokenUtils.balanceOf(asset, address(this)));
    }

    // ----------------------------------------------------------------- admin

    function setTrustedTarget(address target, bool trusted) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        trustedTarget[target] = trusted;
        emit TargetTrustSet(target, trusted);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}