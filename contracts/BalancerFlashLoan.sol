// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import {IERC20} from "./interfaces/IERC20.sol";
import {IVault} from "./interfaces/IVault.sol";
import {IFlashLoanRecipient} from "./interfaces/IFlashLoanRecipient.sol";
import {IStrategy} from "./interfaces/IStrategy.sol";
import {TokenUtils} from "./lib/TokenUtils.sol";

/// @title BalancerFlashLoan
/// @notice Balancer V2 flash-loan engine that routes the borrowed funds
///         through a pluggable, owner-registered strategy module, enforces an
///         atomic minimum profit before repayment, and forwards every trade's
///         profit to the owner's wallet in the same transaction — realized
///         profits never wait for a manual withdraw().
///
/// Same external surface as the Aave engine (contracts/FlashLoan.sol):
///   requestFlashLoan(asset, amount, strategy, minProfit, strategyParams)
///   + identical FlashLoanRequested / FlashLoanExecuted / Withdrawn events
/// so the scanner, P&L ledger and results tooling drive either engine.
///
/// Architecture:
///   Bot/off-chain scanner
///        |  requestFlashLoan(asset, amount, strategy, minProfit, params)
///        v
///   Balancer Vault.flashLoan(self, [asset], [amount], userData)   (0% fee)
///        |  Vault --transfers amount--> this contract
///        |  Vault -> this.receiveFlashLoan(tokens, amounts, feeAmounts, userData)
///        v
///   This engine --transfers amount--> IStrategy.execute(...)
///        |                              (2-DEX / multi-hop / agg route)
///        |  <-- strategy returns asset balance --
///        |  require(balance >= amount + fee + minProfit)   [atomic guard]
///        |  transfer amount + fee --> Vault                [repay in callback]
///        |  transfer profit       --> profitRecipient      [auto-forward]
///        v
///   Vault verifies its balance was restored, transaction completes.
///
/// Key differences from the Aave engine:
///   - repayment is a plain transfer INSIDE the callback; the Vault checks
///     its own balance right after we return (no approval to pull),
///   - the fee arrives as `feeAmounts[0]` (governance-set; always 0 so far).
///     It is honored from the callback, never assumed — a mispriced premium
///     off-chain can only make the trade revert, never lose money,
///   - profits are auto-forwarded to `profitRecipient` per trade.
contract BalancerFlashLoan is IFlashLoanRecipient {
    // ---------------------------------------------------------------- errors
    error NotOwner();
    error NotAuthorized();
    error NotVault();
    error BadLoanShape();
    error NotInFlashLoan();
    error LoanActive();
    error ContractPaused();
    error ZeroAddress();
    error ZeroAmount();
    error NotContract();
    error UnregisteredStrategy();
    error ProfitBelowFloor();
    error Unprofitable(uint256 balance, uint256 required);

    // ---------------------------------------------------------------- events
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event KeeperSet(address indexed keeper);
    event StrategyRegistered(address indexed strategy, bool allowed);
    event PausedSet(bool paused);
    event MinProfitFloorSet(uint256 floor);
    event ProfitRecipientSet(address indexed profitRecipient);
    event FlashLoanRequested(
        address indexed asset, uint256 amount, address indexed strategy, uint256 minProfit
    );
    event FlashLoanExecuted(
        address indexed asset, uint256 amount, uint256 premium, uint256 profit, address indexed strategy
    );
    event ProfitSwept(address indexed token, address indexed to, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    // ----------------------------------------------------------------- state
    /// @notice Contract admin (strategies, pause, keeper, profit wallet).
    address public owner;
    /// @notice Bot EOA allowed to trigger loans on behalf of the owner.
    address public keeper;
    /// @notice Wallet that receives every trade's profit automatically.
    address public profitRecipient;
    /// @notice Emergency switch that blocks new loan requests.
    bool public paused;
    /// @notice Per-trade floor: every request's minProfit must be >= this.
    uint256 public minProfitFloor;
    /// @notice Registered strategy modules; only these can receive the loan.
    mapping(address => bool) public isStrategy;
    /// @notice The Balancer V2 Vault this engine borrows from (immutable).
    IVault public immutable VAULT;

    /// @dev Guards against nested/re-entrant flash-loan requests. Also the
    ///      initiator check: the Balancer callback carries no initiator, so a
    ///      stray receiveFlashLoan (anyone can name this contract as
    ///      recipient) is rejected when no loan of ours is in flight. The
    ///      Vault's own nonReentrancy rules out nested Vault calls anyway.
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
    /// @param vault_           Balancer V2 Vault to borrow from (must have code).
    /// @param profitRecipient_ Wallet that receives every trade's profit.
    ///                         Required at construction: execution is
    ///                         impossible before the profit destination exists.
    constructor(address vault_, address profitRecipient_) {
        if (vault_ == address(0) || profitRecipient_ == address(0)) revert ZeroAddress();
        if (vault_.code.length == 0) revert NotContract();
        VAULT = IVault(vault_);
        owner = msg.sender;
        keeper = msg.sender;
        profitRecipient = profitRecipient_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit ProfitRecipientSet(profitRecipient_);
    }

    receive() external payable {}

    // ------------------------------------------------------------ flash loan

    /// @notice Request a Balancer V2 flash loan and run `strategy` on the funds.
    /// @param asset          ERC20 to borrow (single-asset loans only).
    /// @param amount         Amount to borrow.
    /// @param strategy       A registered strategy module that receives the funds.
    /// @param minProfit      Minimum surplus (in `asset`) that must remain after
    ///                       repaying amount + fee; the tx reverts below it.
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

        bytes memory userData = abi.encode(strategy, minProfit, strategyParams);
        // Single token is trivially sorted ascending, which the Vault requires.
        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(asset);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        _loanActive = true;
        VAULT.flashLoan(this, tokens, amounts, userData);
        _loanActive = false;
    }

    /// @notice Balancer callback: runs the strategy, repays the Vault from
    ///         inside the callback, and forwards the profit to the owner's
    ///         wallet before returning.
    /// @dev    Only the Balancer Vault may call this, only for single-token
    ///         loans this contract initiated itself in this transaction, and
    ///         the Vault re-verifies its own balance as soon as we return.
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        if (msg.sender != address(VAULT)) revert NotVault();
        // The engine only ever requests single-asset loans; any other shape
        // (e.g. a relayed batch) is not something this contract can repay safely.
        if (tokens.length != 1 || amounts.length != 1 || feeAmounts.length != 1) {
            revert BadLoanShape();
        }
        if (!_loanActive) revert NotInFlashLoan();

        (address strategyAddr, uint256 minProfit, bytes memory strategyParams) =
            abi.decode(userData, (address, uint256, bytes));
        if (!isStrategy[strategyAddr]) revert UnregisteredStrategy();

        address asset = address(tokens[0]);
        uint256 amount = amounts[0];
        // Governance-set; always 0 so far — honored regardless, never assumed.
        uint256 fee = feeAmounts[0];

        // Hand the borrowed principal to the strategy module.
        TokenUtils.safeTransfer(asset, strategyAddr, amount);
        IStrategy(strategyAddr).execute(asset, amount, strategyParams);

        // Atomic profitability + repayment guard: fail the whole tx if the
        // strategy did not out-earn the fee (and the requested minProfit).
        uint256 owed = amount + fee;
        uint256 balance = TokenUtils.balanceOf(asset, address(this));
        if (balance < owed + minProfit) revert Unprofitable(balance, owed + minProfit);

        // Repay first: the Vault checks its own balance as soon as we return.
        TokenUtils.safeTransfer(asset, address(VAULT), owed);

        // Then forward the entire surplus to the profit wallet inside the same
        // transaction — the engine retains nothing, no withdraw() needed.
        uint256 profit = balance - owed;
        if (profit > 0) {
            TokenUtils.safeTransfer(asset, profitRecipient, profit);
            emit ProfitSwept(asset, profitRecipient, profit);
            // Also emit Withdrawn so scanner/lib/ledger.js nets `retained`
            // profit correctly with zero ledger changes (Withdrawn is what
            // the ledger subtracts from gross profit).
            emit Withdrawn(asset, profitRecipient, profit);
        }

        emit FlashLoanExecuted(asset, amount, fee, profit, strategyAddr);
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

    /// @notice Change where future trades auto-forward their profit.
    function setProfitRecipient(address profitRecipient_) external onlyOwner {
        if (profitRecipient_ == address(0)) revert ZeroAddress();
        profitRecipient = profitRecipient_;
        emit ProfitRecipientSet(profitRecipient_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Manual rescue: sweep residual tokens to the profit wallet.
    ///         Trade profits are already auto-forwarded in the callback; this
    ///         only matters for stray balances (e.g. direct transfers).
    function withdraw(address token) external onlyOwner {
        uint256 amount = TokenUtils.balanceOf(token, address(this));
        TokenUtils.safeTransfer(token, profitRecipient, amount);
        emit Withdrawn(token, profitRecipient, amount);
    }

    // ----------------------------------------------------------------- views

    function getBalance(address tokenAddress) external view returns (uint256) {
        return TokenUtils.balanceOf(tokenAddress, address(this));
    }
}
