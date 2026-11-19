// Reads Arc testnet USDC's ERC-20 metadata and EIP-712 domain from the chain.
import { createPublicClient, http, parseAbi } from "viem";
import { arcTestnet } from "viem/chains";
import { USDC_ADDRESS } from "@asf/shared";
const USDC = (process.argv[2] ?? USDC_ADDRESS) as `0x${string}`;
const pc = createPublicClient({ chain: arcTestnet, transport: http() });
const abi = parseAbi([
  "function name() view returns (string)", "function symbol() view returns (string)",
  "function decimals() view returns (uint8)", "function version() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);
for (const fn of ["name", "symbol", "decimals", "version", "DOMAIN_SEPARATOR"] as const) {
  try { console.log(fn, await pc.readContract({ address: USDC, abi, functionName: fn })); }
  catch (e: any) { console.log(fn, "ERR", e.shortMessage); }
}
try { console.log("eip712Domain", await pc.getEip712Domain({ address: USDC })); } catch (e: any) { console.log("eip712Domain ERR", e.shortMessage); }
console.log("block", await pc.getBlockNumber());
