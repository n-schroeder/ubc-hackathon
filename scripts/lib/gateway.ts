// Circle Gateway helpers for the wallet scripts (wallets:balances, gateway:deposit, baseline:deposit).
// Nanopayments are paid from a Gateway balance, not from the wallet's own USDC.
import { GATEWAY_API_TESTNET, parseUsdc } from "@asf/shared";

/** Gateway's domain id for Arc testnet. */
export const ARC_GATEWAY_DOMAIN = 26;

/** A depositor's USDC balance inside Gateway on Arc testnet, in base units. */
export async function gatewayBalance(depositor: string): Promise<bigint> {
  const r = await fetch(`${GATEWAY_API_TESTNET}/balances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "USDC", sources: [{ depositor, domain: ARC_GATEWAY_DOMAIN }] }),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`Gateway balances: ${r.status} ${JSON.stringify(j)}`);
  return parseUsdc(j.balances?.[0]?.balance ?? "0");
}

/** Polls until Gateway sees at least `atLeast` for the depositor (a deposit takes a few blocks to show up). */
export async function waitForGatewayBalance(depositor: string, atLeast: bigint, onPoll: (bal: bigint) => void, tries = 30): Promise<bigint> {
  let bal = 0n;
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    bal = await gatewayBalance(depositor);
    onPoll(bal);
    if (bal >= atLeast) break;
  }
  return bal;
}
