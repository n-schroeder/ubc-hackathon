// Prints each project wallet's USDC on Arc testnet and its balance inside Circle Gateway (read-only).
// Nanopayments are paid from the Gateway balance; the wallet's own USDC pays gas and funds deposits.
import { createPublicClient, http, parseAbi } from "viem";
import { ARC_TESTNET, USDC_ADDRESS, addressUrl, formatUsdc, optionalEnv } from "@asf/shared";
import { gatewayBalance } from "./lib/gateway.ts";

const pc = createPublicClient({ chain: ARC_TESTNET, transport: http() });
const wallets = { firewall: optionalEnv("CIRCLE_FIREWALL_WALLET_ADDRESS"), baseline: optionalEnv("BASELINE_ADDRESS") };

for (const [name, addr] of Object.entries(wallets) as [keyof typeof wallets, string | undefined][]) {
  if (!addr) { console.log(`${name.padEnd(9)} not set up (run npm run wallets:setup)`); continue; }
  const a = addr as `0x${string}`;
  // The ERC-20 view uses 6 decimals; Arc's native gas balance is the same USDC at 18 decimals, so read the ERC-20.
  const [wallet, gateway] = await Promise.all([
    pc.readContract({ address: USDC_ADDRESS, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [a] }),
    gatewayBalance(a).catch((e: Error) => e),
  ]);
  const gw = gateway instanceof Error ? `? (${gateway.message})` : formatUsdc(gateway);
  console.log(`${name.padEnd(9)} ${a}  wallet ${formatUsdc(wallet)} USDC  gateway ${gw} USDC  ${addressUrl(a)}`);
}
console.log("\nTop up Gateway with npm run gateway:deposit (firewall) or npm run baseline:deposit (baseline).");
