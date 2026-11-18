// Fund the unsafe baseline's Gateway balance so `npm run task -- --unsafe` can make x402 calls (F22).
//
//   npm run baseline:deposit [-- <amount, default 2>]
//
// The baseline signs with BASELINE_PRIVATE_KEY directly (viem), the way most agent wallets work today.
// Deposits only when the Gateway balance is under 1 USDC. Never touches the firewall's wallet.
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ARC_TESTNET, GATEWAY_API_TESTNET, GATEWAY_WALLET_ADDRESS, USDC_ADDRESS, formatUsdc, loadEnv, parseUsdc, requireEnv, txUrl,
} from "@asf/shared";

const ARC_GATEWAY_DOMAIN = 26;
const ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function deposit(address token, uint256 value)",
]);

async function gatewayBalance(depositor: string): Promise<bigint> {
  const r = await fetch(`${GATEWAY_API_TESTNET}/balances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "USDC", sources: [{ depositor, domain: ARC_GATEWAY_DOMAIN }] }),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`balances: ${r.status} ${JSON.stringify(j)}`);
  return parseUsdc(j.balances?.[0]?.balance ?? "0");
}

async function main() {
  loadEnv();
  const amount = parseUsdc(process.argv[2] ?? "2");
  const account = privateKeyToAccount(requireEnv("BASELINE_PRIVATE_KEY") as `0x${string}`);
  const wallet = createWalletClient({ account, chain: ARC_TESTNET, transport: http() });
  const chain = createPublicClient({ chain: ARC_TESTNET, transport: http() });
  console.log("baseline:", account.address);

  let bal = await gatewayBalance(account.address);
  console.log("gateway balance:", formatUsdc(bal));
  if (bal >= parseUsdc("1")) return console.log("already funded; nothing to do");

  const send = async (fn: "approve" | "deposit", args: readonly unknown[], to: `0x${string}`) => {
    const hash = await wallet.writeContract({ address: to, abi: ABI, functionName: fn, args: args as any });
    const rc = await chain.waitForTransactionReceipt({ hash });
    console.log(`${fn} tx:`, txUrl(hash), rc.status);
    if (rc.status !== "success") throw new Error(`${fn} reverted`);
  };
  await send("approve", [GATEWAY_WALLET_ADDRESS, amount], USDC_ADDRESS);
  await send("deposit", [USDC_ADDRESS, amount], GATEWAY_WALLET_ADDRESS);

  for (let i = 0; i < 30 && bal < parseUsdc("1"); i++) {
    await new Promise((r) => setTimeout(r, 4000));
    bal = await gatewayBalance(account.address);
    console.log("  gateway balance:", formatUsdc(bal));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
