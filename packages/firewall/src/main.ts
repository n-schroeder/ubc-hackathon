// Firewall process entry point. The ONLY process that loads wallet credentials.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT, loadPolicy, loadRegistry, optionalEnv } from "@asf/shared";
import { defaultPipeline } from "./checks/index.ts";
import { Firewall, LivePayments } from "./firewall.ts";
import { createApp } from "./server.ts";
import { SettlementWatcher, gatewayTransferLookup } from "./settlement.ts";
import { CircleWalletSigner } from "./signer.ts";
import { Store } from "./store.ts";
import { Watchdog } from "./watchdog.ts";
import { createWatchdogApp } from "./watchdog-server.ts";

const port = Number(optionalEnv("FIREWALL_PORT", "4020"));
const dbPath = optionalEnv("FIREWALL_DB", resolve(REPO_ROOT, "data/firewall.db"))!;
if (dbPath !== ":memory:") mkdirSync(resolve(dbPath, ".."), { recursive: true });
const adminToken = optionalEnv("FIREWALL_ADMIN_TOKEN") ?? randomBytes(16).toString("hex");

const signer = new CircleWalletSigner();
const fw = new Firewall({
  store: new Store(dbPath),
  policy: loadPolicy(),
  registry: loadRegistry(),
  pipeline: defaultPipeline(),
  payments: new LivePayments(signer),
});
// Nanopayments settle in Gateway batches; fill in each row's batch tx hash + explorer link when it lands.
new SettlementWatcher(fw, gatewayTransferLookup()).start();

// Onchain watchdog (QuickNode Streams): on only when the stream's security token is configured.
const qnToken = optionalEnv("QUICKNODE_STREAM_TOKEN");
const watchdog = qnToken ? new Watchdog(fw, signer.address) : undefined;
if (watchdog) {
  const wdPort = Number(optionalEnv("WATCHDOG_PORT", "4023"));
  createWatchdogApp(watchdog, { securityToken: qnToken! }).listen(wdPort, "127.0.0.1", () =>
    console.log(`watchdog webhook on http://127.0.0.1:${wdPort}/quicknode (tunnel this port only), watching ${watchdog.wallet}`));
}

const app = createApp(fw, { adminToken, staticDir: resolve(import.meta.dirname, "../public"), watchdog });
app.listen(port, "127.0.0.1", () => {
  console.log(`firewall listening on http://127.0.0.1:${port} (wallet ${signer.address})`);
  console.log(`dashboard: http://127.0.0.1:${port}/#token=${adminToken}`);
});
