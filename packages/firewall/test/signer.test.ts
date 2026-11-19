// The Circle signer's request shapes, checked against a stub client (no network, no funds).
import { describe, expect, it } from "vitest";
import { CIRCLE_BLOCKCHAIN, USDC_ADDRESS, parseUsdc } from "@asf/shared";
import { CircleWalletSigner } from "../src/signer.ts";

process.env.TEST_API_KEY ??= "TEST_API_KEY:stub:stub";
process.env.ENTITY_SECRET ??= "0".repeat(64);
process.env.CIRCLE_FIREWALL_WALLET_ID ??= "00000000-0000-0000-0000-000000000000";
process.env.CIRCLE_FIREWALL_WALLET_ADDRESS ??= "0x115ac8ffb8241e1750ca19c26881f2a498c944b2";

function stubbed() {
  const signer = new CircleWalletSigner();
  const calls: any[] = [];
  (signer as any).client = {
    createTransaction: async (input: any) => (calls.push(input), { data: { id: "tx-1" } }),
    getTransaction: async () => ({ data: { transaction: { txHash: "0xabc" } } }),
  };
  return { signer, calls };
}

describe("CircleWalletSigner.transfer", () => {
  it("names the chain with the token address (Circle answers 400 'API parameter invalid' without it)", async () => {
    const { signer, calls } = stubbed();
    const to = "0x91D09630a50b78650170205Eb3020D9907c2853d";
    await expect(signer.transfer(to, parseUsdc("0.01"))).resolves.toEqual({ txHash: "0xabc" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tokenAddress: USDC_ADDRESS, blockchain: CIRCLE_BLOCKCHAIN, amount: ["0.01"], destinationAddress: to });
    expect(calls[0].tokenId).toBeUndefined();
  });
});
