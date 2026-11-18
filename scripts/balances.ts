// Prints the USDC balance of the project's wallets on Arc testnet.
import { existsSync, realpathSync } from "node:fs";
import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { arcTestnet } from "viem/chains";
import { config } from "dotenv";

if (!existsSync(".env")) {
  console.error("No .env in this directory. Run `cp .env.example .env` in the repo root and fill in TEST_API_KEY and ENTITY_SECRET first (see docs/TESTING.md).");
  process.exit(1);
}
config({ path: realpathSync(".env"), quiet: true });
const USDC = "0x3600000000000000000000000000000000000000" as const;
const pc = createPublicClient({ chain: arcTestnet, transport: http() });
const wallets = { firewall: process.env.CIRCLE_FIREWALL_WALLET_ADDRESS, baseline: process.env.BASELINE_ADDRESS };

for (const [name, addr] of Object.entries(wallets)) {
  if (!addr) { console.log(`${name}: not set up (run npm run wallets:setup)`); continue; }
  const a = addr as `0x${string}`;
  // ERC-20 view uses 6 decimals; the native gas balance is the same USDC at 18 decimals.
  const erc20 = await pc.readContract({ address: USDC, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [a] });
  console.log(`${name.padEnd(9)} ${a}  ${formatUnits(erc20, 6)} USDC  ${arcTestnet.blockExplorers.default.url}/address/${a}`);
}
