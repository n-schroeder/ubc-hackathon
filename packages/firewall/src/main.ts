// Firewall process entry point. The ONLY process that loads wallet credentials.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT, loadPolicy, loadRegistry, optionalEnv } from "@asf/shared";
import { defaultPipeline } from "./checks/index.ts";
import { Firewall, LivePayments } from "./firewall.ts";
import { createApp } from "./server.ts";
import { CircleWalletSigner } from "./signer.ts";
import { Store } from "./store.ts";

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
const app = createApp(fw, { adminToken, staticDir: resolve(import.meta.dirname, "../public") });
app.listen(port, "127.0.0.1", () => {
  console.log(`firewall listening on http://127.0.0.1:${port} (wallet ${signer.address})`);
  console.log(`dashboard: http://127.0.0.1:${port}/#token=${adminToken}`);
});
