import { GATEWAY_API_TESTNET, loadEnv, requireEnv } from "@asf/shared";
loadEnv();
for (const [n, a] of [["firewall", requireEnv("CIRCLE_FIREWALL_WALLET_ADDRESS")], ["baseline", requireEnv("BASELINE_ADDRESS")]]) {
  const r = await fetch(`${GATEWAY_API_TESTNET}/balances`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "USDC", sources: [{ depositor: a, domain: 26 }] }) });
  const j: any = await r.json();
  console.log(`gateway ${n.padEnd(8)} ${j.balances?.[0]?.balance ?? JSON.stringify(j)}`);
}
