require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// Solidity 0.8.10 is pinned by @aave/core-v3's FlashLoanSimpleReceiverBase,
// so every contract in this project compiles with the same version.
const solidity = {
  version: "0.8.10",
  settings: {
    optimizer: { enabled: true, runs: 200 },
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
  },
};