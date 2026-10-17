// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import {IStrategy} from "../interfaces/IStrategy.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {ISwapRouterV2} from "../interfaces/ISwapRouterV2.sol";
import {TokenUtils} from "../lib/TokenUtils.sol";

/// @title DexRouteArbStrategy
/// @notice Arbitrage approach #1 and #2, both encoded as explicit routes:
///
///   A. Two-DEX arbitrage (canonical flash-loan arb):
///        routerA: asset -> tokenB      (buy cheap on venue A)
///        routerB: tokenB -> asset      (sell dear on venue B)
///
///   B. Multi-hop / cyclic arbitrage across pools:
///        routerA: asset -> X -> Y       (or a full cycle asset -> X -> asset)
///        routerB: Y -> asset
///
/// Only allowlisted routers can be used, both paths must form a closed cycle
/// that starts and ends in the borrowed asset, and the engine's profit guard
/// decides whether the trade was worth it.
///
/// This module is intentionally stateless between trades: it holds funds only
/// during the callback and forwards its entire `asset` balance back to the
/// engine before returning.
contract DexRouteArbStrategy is IStrategy {
    // ---------------------------------------------------------------- errors
    error NotEngine();
    error NotOwner();
    error ZeroAddress();
    error UntrustedRouter();
    error BadPath();
    error BadPathStart();
    error BadPathEnd();
    error MidMismatch();

    // ---------------------------------------------------------------- events
    event RouterTrustSet(address indexed router, bool trusted);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /// @notice Only this engine may call `execute`.
    address public immutable engine;
    /// @notice Admin of the router allowlist (set to the engine owner).
    address public owner;
    /// @notice DEX routers this strategy is allowed to call.
    mapping(address => bool) public trustedRouter;

    /// @dev Route decoded from `params`.
    struct RouteParams {
        address routerA;
        address[] pathA;
        address routerB;
        address[] pathB;
        uint256 minAmountOutA;
        uint256 minAmountOutB;
        uint256 deadline;
    }

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
        // Decode into a memory struct to keep the stack shallow.
        RouteParams memory r = abi.decode(params, (RouteParams));

        if (!trustedRouter[r.routerA] || !trustedRouter[r.routerB]) revert UntrustedRouter();
        if (r.pathA.length < 2 || r.pathB.length < 2) revert BadPath();
        if (r.pathA[0] != asset) revert BadPathStart();
        if (r.pathB[r.pathB.length - 1] != asset) revert BadPathEnd();
        // The cycle must be closed: buy-side output == sell-side input.
        if (r.pathA[r.pathA.length - 1] != r.pathB[0]) revert MidMismatch();

        // Leg 1: asset -> ... -> mid on venue A.
        uint256 mid;
        {
            TokenUtils.safeApprove(r.pathA[0], r.routerA, amount);
            uint256[] memory amountsA = ISwapRouterV2(r.routerA).swapExactTokensForTokens(
                amount, r.minAmountOutA, r.pathA, address(this), r.deadline
            );
            mid = amountsA[amountsA.length - 1];
        }

        // Leg 2: mid -> ... -> asset on venue B.
        {
            TokenUtils.safeApprove(r.pathB[0], r.routerB, mid);
            ISwapRouterV2(r.routerB).swapExactTokensForTokens(
                mid, r.minAmountOutB, r.pathB, address(this), r.deadline
            );
        }
        // Final balance (principal + profit) goes back to the engine, which
        // checks profitability before approving repayment.
        TokenUtils.safeTransfer(asset, msg.sender, TokenUtils.balanceOf(asset, address(this)));
    }

    // ----------------------------------------------------------------- admin

    function setTrustedRouter(address router, bool trusted) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        trustedRouter[router] = trusted;
        emit RouterTrustSet(router, trusted);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}