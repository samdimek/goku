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
    },
    // Mainnet: go-live config. Same code, only the addresses provider changes.
    mainnet: {
      url: process.env.MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com",
      accounts,
      chainId: 1,
    },
  },
};