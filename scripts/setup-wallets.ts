// Creates the project's wallets on Arc testnet and records them in .env.
//
//   FIREWALL wallet  - Circle Developer-Controlled Wallet (EOA). Only the firewall uses it.
//                      Its key lives at Circle; we sign through Circle's API.
//   BASELINE wallet  - a plain local key, used only by the "--unsafe" demo agent.
//                      Funded with a tiny amount from the firewall wallet later.
//
// Safe to re-run: anything already in .env is reused, not recreated.
import { appendFileSync, realpathSync } from "node:fs";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { config } from "dotenv";

const ENV_PATH = realpathSync(".env");
config({ path: ENV_PATH, quiet: true });

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

const client = initiateDeveloperControlledWalletsClient({
  apiKey: need("TEST_API_KEY"),
  entitySecret: need("ENTITY_SECRET"),
});

const added: string[] = [];

let walletId = process.env.CIRCLE_FIREWALL_WALLET_ID;
let firewallAddress = process.env.CIRCLE_FIREWALL_WALLET_ADDRESS;

if (!walletId) {
  const set = await client.createWalletSet({ name: "agent-spending-firewall" });
  const walletSetId = set.data?.walletSet?.id;
  if (!walletSetId) throw new Error("createWalletSet returned no id");

  const res = await client.createWallets({
    walletSetId,
    blockchains: ["ARC-TESTNET"],
    count: 1,
    accountType: "EOA",
    metadata: [{ name: "firewall" }],
  });
  const w = res.data?.wallets?.[0];
  if (!w?.id || !w.address) throw new Error("createWallets returned no wallet");
  walletId = w.id;
  firewallAddress = w.address;
  added.push(
    `CIRCLE_WALLET_SET_ID=${walletSetId}`,
    `CIRCLE_FIREWALL_WALLET_ID=${walletId}`,
    `CIRCLE_FIREWALL_WALLET_ADDRESS=${firewallAddress}`,
  );
}

let baselineAddress: string;
if (process.env.BASELINE_PRIVATE_KEY) {
  baselineAddress = privateKeyToAccount(process.env.BASELINE_PRIVATE_KEY as `0x${string}`).address;
} else {
  const pk = generatePrivateKey();
  baselineAddress = privateKeyToAccount(pk).address;
  added.push(
    `# Unsafe-baseline demo wallet (testnet only, never used by the firewall)`,
    `BASELINE_PRIVATE_KEY=${pk}`,
    `BASELINE_ADDRESS=${baselineAddress}`,
  );
}

if (added.length) {
  appendFileSync(ENV_PATH, `\n# --- added by scripts/setup-wallets.ts ---\n${added.join("\n")}\n`);
}

console.log(`Firewall wallet (Circle, fund this one): ${firewallAddress}`);
console.log(`Baseline wallet (local key, funded later from the firewall wallet): ${baselineAddress}`);
console.log(added.length ? `Recorded new values in .env` : `Nothing new; reused values from .env`);
