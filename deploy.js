const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  // 1. Deploy PassportFactory
  console.log("\n── Deploying PassportFactory...");
  const Factory = await ethers.getContractFactory("PassportFactory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();
  console.log("PassportFactory:", await factory.getAddress());

  // 2. Deploy a PassportRegistry for India via factory
  console.log("\n── Deploying PassportRegistry (India) via factory...");
  const tx = await factory.deployRegistry("IND", "Ministry of External Affairs", deployer.address);
  const receipt = await tx.wait();
  const event = receipt.logs.find(l => l.fragment?.name === "RegistryDeployed");
  const registryAddress = event.args.registry;
  console.log("PassportRegistry (IND):", registryAddress);

  // 3. Deploy BorderGateway
  console.log("\n── Deploying BorderGateway...");
  const Gateway = await ethers.getContractFactory("BorderGateway");
  const gateway = await Gateway.deploy(registryAddress);
  await gateway.waitForDeployment();
  console.log("BorderGateway:", await gateway.getAddress());

  // 4. Grant BORDER_AGENT_ROLE to BorderGateway on the registry
  const registry = await ethers.getContractAt("PassportRegistry", registryAddress);
  const BORDER_AGENT_ROLE = await registry.BORDER_AGENT_ROLE();
  await (await registry.grantRole(BORDER_AGENT_ROLE, await gateway.getAddress())).wait();
  console.log("\n── Granted BORDER_AGENT_ROLE to BorderGateway");

  console.log("\n✓ Deployment complete");
  console.log("─────────────────────────────────");
  console.log("PassportFactory :", await factory.getAddress());
  console.log("PassportRegistry:", registryAddress);
  console.log("BorderGateway   :", await gateway.getAddress());
  console.log("─────────────────────────────────");
  console.log("\nAdd these to your .env:");
  console.log(`FACTORY_ADDRESS=${await factory.getAddress()}`);
  console.log(`REGISTRY_ADDRESS=${registryAddress}`);
  console.log(`GATEWAY_ADDRESS=${await gateway.getAddress()}`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });