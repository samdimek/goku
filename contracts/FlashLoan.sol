// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import {FlashLoanSimpleReceiverBase} from "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IStrategy} from "./interfaces/IStrategy.sol";
import {TokenUtils} from "./lib/TokenUtils.sol";

/// @title FlashLoan
/// @notice Aave V3 flash-loan engine that routes the borrowed funds through a
///         pluggable, owner-registered strategy module and enforces an atomic
///         minimum profit before allowing repayment.
///
/// Architecture:
///   Bot/off-chain scanner
///        |  requestFlashLoan(asset, amount, strategy, minProfit, params)
///        v
///   Aave POOL.flashLoanSimple(...)  ---- transfers `amount` to this contract
///        |  executeOperation(callback)
///        v
///   This engine  -- transfers `amount` -->  IStrategy.execute(...)
///        |                                     (2-DEX / multi-hop / agg route)
///        |  <-- strategy returns asset balance --
///        |  require(balance >= amount + premium + minProfit)   [atomic guard]
///        |  approve(POOL, amount + premium)
///        v
///   POOL pulls repayment; any surplus stays in this contract as realized profit.
contract FlashLoan is FlashLoanSimpleReceiverBase {
    // ---------------------------------------------------------------- errors
    error NotOwner();
    error NotAuthorized();
    error NotPool();
    error BadInitiator();
    error NotInFlashLoan();
    error LoanActive();
    error ContractPaused();
    error ZeroAddress();
    error ZeroAmount();
    error UnregisteredStrategy();
    error ProfitBelowFloor();
    error Unprofitable(uint256 balance, uint256 required);

    // ---------------------------------------------------------------- events
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event KeeperSet(address indexed keeper);
    event StrategyRegistered(address indexed strategy, bool allowed);
    event PausedSet(bool paused);
    event MinProfitFloorSet(uint256 floor);
    event FlashLoanRequested(
        address indexed asset, uint256 amount, address indexed strategy, uint256 minProfit
    );
    event FlashLoanExecuted(
        address indexed asset, uint256 amount, uint256 premium, uint256 profit, address indexed strategy
    );
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    // ----------------------------------------------------------------- state
    /// @notice Contract admin (withdrawals, registry, pause, keeper).
    address public owner;
    /// @notice Bot EOA allowed to trigger loans on behalf of the owner.
    address public keeper;
    /// @notice Emergency switch that blocks new loan requests.
    bool public paused;
    /// @notice Per-trade floor: every request's minProfit must be >= this.
    uint256 public minProfitFloor;
    /// @notice Registered strategy modules; only these can receive the loan.
    mapping(address => bool) public isStrategy;

    /// @dev Guards against nested/re-entrant flash-loan requests.
    bool private _loanActive;

    // ------------------------------------------------------------- modifiers
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOwnerOrKeeper() {
        if (msg.sender != owner && msg.sender != keeper) revert NotAuthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    // ------------------------------------------------------------ constructor
    constructor(address addressProvider_)
        FlashLoanSimpleReceiverBase(IPoolAddressesProvider(addressProvider_))
    {
        owner = msg.sender;
        keeper = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    receive() external payable {}

    // ------------------------------------------------------------ flash loan

    /// @notice Request an Aave V3 simple flash loan and run `strategy` on the funds.
    /// @param asset          ERC20 to borrow.
    /// @param amount         Amount to borrow.
    /// @param strategy       A registered strategy module that receives the funds.
    /// @param minProfit      Minimum surplus (in `asset`) that must remain after
    ///                       repaying amount + premium; the tx reverts below it.
    /// @param strategyParams Strategy-specific calldata (route, targets, etc.).
    function requestFlashLoan(
        address asset,
        uint256 amount,
        address strategy,
        uint256 minProfit,
        bytes calldata strategyParams
    ) external onlyOwnerOrKeeper whenNotPaused {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!isStrategy[strategy]) revert UnregisteredStrategy();
        if (minProfit < minProfitFloor) revert ProfitBelowFloor();
        if (_loanActive) revert LoanActive();

        emit FlashLoanRequested(asset, amount, strategy, minProfit);

        bytes memory params = abi.encode(strategy, minProfit, strategyParams);
        _loanActive = true;
        POOL.flashLoanSimple(address(this), asset, amount, params, 0);
        _loanActive = false;
    }

    /// @notice Aave callback: runs the strategy and approves repayment.
    /// @dev    Only the Aave Pool may call this, and only for loans this
    ///         contract initiated itself in the current transaction.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        if (msg.sender != address(POOL)) revert NotPool();
        if (initiator != address(this)) revert BadInitiator();
        if (!_loanActive) revert NotInFlashLoan();

        (address strategyAddr, uint256 minProfit, bytes memory strategyParams) =
            abi.decode(params, (address, uint256, bytes));
        if (!isStrategy[strategyAddr]) revert UnregisteredStrategy();

        // Hand the borrowed principal to the strategy module.
        TokenUtils.safeTransfer(asset, strategyAddr, amount);
        IStrategy(strategyAddr).execute(asset, amount, strategyParams);

        // Atomic profitability + repayment guard: fail the whole tx if the
        // strategy did not out-earn the premium (and the requested minProfit).
        uint256 owed = amount + premium;
        uint256 balance = TokenUtils.balanceOf(asset, address(this));
        if (balance < owed + minProfit) revert Unprofitable(balance, owed + minProfit);

        // Aave pulls amount + premium from this contract after we return.
        TokenUtils.safeApprove(asset, address(POOL), owed);

        emit FlashLoanExecuted(asset, amount, premium, balance - owed, strategyAddr);
        return true;
    }

    // ----------------------------------------------------------------- admin

    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function registerStrategy(address strategy, bool allowed) external onlyOwner {
        if (strategy == address(0)) revert ZeroAddress();
        isStrategy[strategy] = allowed;
        emit StrategyRegistered(strategy, allowed);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function setMinProfitFloor(uint256 floor) external onlyOwner {
        minProfitFloor = floor;
        emit MinProfitFloorSet(floor);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Sweep realized profit / residual tokens to the owner.
    function withdraw(address token) external onlyOwner {
        uint256 amount = TokenUtils.balanceOf(token, address(this));
        TokenUtils.safeTransfer(token, owner, amount);
        emit Withdrawn(token, owner, amount);
    }

    // ----------------------------------------------------------------- views

    function getBalance(address tokenAddress) external view returns (uint256) {
        return TokenUtils.balanceOf(tokenAddress, address(this));
    }
}