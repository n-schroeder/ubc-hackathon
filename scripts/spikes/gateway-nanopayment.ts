// M0 spike 3: one real Circle Gateway nanopayment on Arc testnet, signed by the Circle
// developer-controlled wallet (no private key in this process).
//
// 1. Read the wallet's Gateway balance; if it is under 1 USDC, approve + deposit DEPOSIT USDC
//    into the GatewayWallet contract through Circle contract-execution transactions.
// 2. Start a minimal seller (createGatewayMiddleware, testnet facilitator) on a random port.
// 3. Do the x402 handshake by hand: GET → 402 → decode PAYMENT-REQUIRED → BatchEvmScheme
//    (with CircleWalletSigner) → retry with Payment-Signature → decode PAYMENT-RESPONSE.
// 4. Look the transfer up in the Gateway API and print what we learned.
import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import {
  ARC_NETWORK, GATEWAY_API_TESTNET, GATEWAY_WALLET_ADDRESS, USDC_ADDRESS, formatUsdc, parseUsdc, loadRegistry, txUrl,
} from "@asf/shared";
import { CircleWalletSigner } from "../../packages/firewall/src/signer.ts";

const ARC_GATEWAY_DOMAIN = 26;
const DEPOSIT = "5";

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

const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

async function main() {
  const signer = new CircleWalletSigner();
  console.log("buyer (Circle wallet):", signer.address);

  let bal = await gatewayBalance(signer.address);
  console.log("gateway balance:", formatUsdc(bal));
  if (bal < parseUsdc("1")) {
    const amt = parseUsdc(DEPOSIT);
    console.log(`depositing ${DEPOSIT} USDC…`);
    const a = await signer.contractCall(USDC_ADDRESS, "approve(address,uint256)", [GATEWAY_WALLET_ADDRESS, amt]);
    console.log("approve tx:", txUrl(a.txHash));
    const d = await signer.contractCall(GATEWAY_WALLET_ADDRESS, "deposit(address,uint256)", [USDC_ADDRESS, amt]);
    console.log("deposit tx:", txUrl(d.txHash));
    for (let i = 0; i < 30 && bal < parseUsdc("1"); i++) {
      await new Promise((r) => setTimeout(r, 4000));
      bal = await gatewayBalance(signer.address);
      console.log("  gateway balance:", formatUsdc(bal));
    }
  }

  const seller = loadRegistry().find((e) => e.id === "weather-api")!.payTo;
  const gateway = createGatewayMiddleware({
    sellerAddress: seller,
    networks: ARC_NETWORK,
    facilitatorUrl: "https://gateway-api-testnet.circle.com",
  });
  const app = express();
  app.get("/weather", gateway.require("$0.001"), (_req, res) => { res.json({ city: "Austin", tempC: 24 }); });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}/weather`;

  try {
    const first = await fetch(url);
    console.log("unpaid status:", first.status);
    const required = b64json(first.headers.get("PAYMENT-REQUIRED")!);
    console.log("PAYMENT-REQUIRED:", JSON.stringify(required, null, 2));
    const option = required.accepts.find((a: any) => a.network === ARC_NETWORK && a.extra?.name === "GatewayWalletBatched");
    if (!option) throw new Error("no Arc Gateway batching option");

    const scheme = new BatchEvmScheme(signer as any);
    const t0 = Date.now();
    const payload = await scheme.createPaymentPayload(required.x402Version ?? 2, option);
    console.log(`signed in ${Date.now() - t0} ms`);
    const header = Buffer.from(JSON.stringify({ ...payload, resource: required.resource, accepted: option })).toString("base64");
    const t1 = Date.now();
    const paid = await fetch(url, { headers: { "Payment-Signature": header } });
    console.log(`paid status: ${paid.status} in ${Date.now() - t1} ms`, await paid.text());
    const pr = paid.headers.get("PAYMENT-RESPONSE");
    const settle = pr ? b64json(pr) : undefined;
    console.log("PAYMENT-RESPONSE:", JSON.stringify(settle, null, 2));

    if (settle?.transaction) {
      const t = await fetch(`${GATEWAY_API_TESTNET}/x402/transfers/${encodeURIComponent(settle.transaction)}`);
      console.log("transfer lookup:", t.status, await t.text());
    }
    console.log("gateway balance after:", formatUsdc(await gatewayBalance(signer.address)));
  } finally {
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
