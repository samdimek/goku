require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// Solidity 0.8.10 is pinned by @aave/core-v3's FlashLoanSimpleReceiverBase,
// so every contract in this project compiles with the same version.
const solidity = {
  version: "0.8.10",
  settings: {
    optimizer: { enabled: true, runs: 200 },
  },
  // The Balancer engine is the hot path (every trade pays its runtime gas),
  // so it trades a larger deployment for cheaper execution: optimizer runs
  // cranked up for that file only. Aave-side contracts keep 200 runs so the
  // campaign-verified bytecode is unchanged.
  overrides: {
    "contracts/BalancerFlashLoan.sol": {
      settings: {
        optimizer: { enabled: true, runs: 1000000 },
      },
    },
  },
};

const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity,
  networks: {
    // Testnet first; add GOERLI-style networks here only if you need them.
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      accounts,
      chainId: 11155111,
      // Best-effort floor. hardhat-ethers may still derive EIP-1559 fees from
      // the network when broadcasting (observed on Sepolia), so callers must
      // also tolerate underpriced-replacement errors — scanner/run.js' sendWait
      // does exactly that. 2 gwei on testnet is cheap insurance either way.
      gasPrice: 2_000_000_000,
    },
    // Mainnet: go-live config. Same code, only the addresses provider changes.
    mainnet: {
      url: process.env.MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com",
      accounts,
      chainId: 1,
    },
    // Arbitrum One — the go-live network (actual mainnet, chainId 42161).
    // Unlike Sepolia, do NOT pin gasPrice here: Arbitrum's L2 base fee is
    // dynamic around a 0.02 gwei floor (verified on-chain via
    // ArbGasInfo.getMinimumGasPrice) and hardhat-ethers derives EIP-1559
    // fees from the network. Pinning an L1-scale gas price would overpay
    // ~100x. The scanner's F1 gate prices gas at max(feeData, floor) with
    // its own configurable floor (see .env GAS_PRICE_FLOOR_WEI).
    arbitrum: {
      url: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
      accounts,
      chainId: 42161,
    },
  },
};