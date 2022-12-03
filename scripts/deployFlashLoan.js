const hre = require("hardhat");

async function main() {
  const FlashLoan = await hre.ethers.getContractFactory("FlashLoan");
  const flashLoan = await FlashLoan.deploy(
    "0x5E52dEc931FFb32f609681B8438A51c675cc232d"
  );

  await flashLoan.deployed();
  console.log("Flash Loan contraact deployed: ", flashLoan.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
