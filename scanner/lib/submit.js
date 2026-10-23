"use strict";

/**
 * Choose the signer used for SENDING trades (quotes always use the read
 * provider passed to scanOnce).
 *
 *  - submitRpcUrl unset            -> keep the given signer (public mempool).
 *  - submitRpcUrl set + PRIVATE_KEY -> a Wallet connected to the private
 *    submission RPC. Flashbots Protect (Sepolia: https://rpc-sepolia.flashbots.net/,
 *    mainnet: https://rpc.flashbots.net/fast) accepts standard
 *    eth_sendRawTransaction and, by default, does NOT include reverting
 *    transactions (canRevert is off) -> a trade that would revert never
 *    lands, so no gas is paid for it. It also hides the tx from the public
 *    mempool (sandwich-bot protection). The endpoint must serve standard
 *    read methods too (Protect does — it is used as a wallet custom RPC).
 *  - submitRpcUrl set, no key      -> cannot sign remotely; keep the given
 *    signer and say so (loudly) — never silently downgrade.
 *
 * The private key is only ever used to construct an in-memory Wallet; it is
 * never logged or written anywhere by this module.
 */
function resolveSendSigner({ signer, submitRpcUrl, privateKey, log = () => {} }) {
  if (!submitRpcUrl) return { signer, mode: "public", endpoint: null };
  if (!privateKey) {
    log(
      `  ! submitRpcUrl is set but no PRIVATE_KEY — falling back to the ` +
        `default signer (no private submission)`
    );
    return { signer, mode: "public", endpoint: submitRpcUrl, note: "no-key" };
  }
  // Lazy require keeps module load cheap for callers that never send.
  const { ethers } = require("ethers");
  const provider = new ethers.JsonRpcProvider(submitRpcUrl);
  return {
    signer: new ethers.Wallet(privateKey, provider),
    mode: "private",
    endpoint: submitRpcUrl,
  };
}

module.exports = { resolveSendSigner };
