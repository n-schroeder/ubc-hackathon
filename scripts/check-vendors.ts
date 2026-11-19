// M2 exit check: start both vendors in-process (real Circle Gateway testnet facilitator), print the 402
// quote each shady mode returns, then pay the honest vendor once per endpoint through a real firewall
// (full check pipeline). Spends $0.003 of testnet USDC from the firewall's Gateway balance.
//   npm run check:vendors            quotes + real payments
//   npm run check:vendors -- --quotes-only
import { loadDemoAddresses, loadPolicy, loadRegistry, usd, type RegistryEntry } from "@asf/shared";
import { defaultPipeline } from "../packages/firewall/src/checks/index.ts";
import { Firewall, LivePayments } from "../packages/firewall/src/firewall.ts";
import { CircleWalletSigner } from "../packages/firewall/src/signer.ts";
import { Store } from "../packages/firewall/src/store.ts";
import { requestQuote } from "../packages/firewall/src/x402.ts";
import { SHADY_MODES, createHonestApp, createShadyApp, listen } from "../packages/vendors/src/index.ts";

const quotesOnly = process.argv.includes("--quotes-only");

// Ephemeral ports (vendors already running on 4021/4022 don't get in the way); point the registry at them.
const honest = await listen(createHonestApp().app);
const shadyCtl = createShadyApp();
const shady = await listen(shadyCtl.app);
const registry: RegistryEntry[] = loadRegistry(undefined, { "4021": honest.port, "4022": shady.port });
const premium = registry.find((e) => e.id === "premium-weather")!;
const attacker = loadDemoAddresses().attacker!;
const who = (a: string) => (a === premium.payTo ? "pinned payTo" : a === attacker ? "ATTACKER" : "unknown");

let failed = false;
try {
  console.log("== shady vendor quotes (premium-weather; expected", usd(premium.expectedPrice), "to", premium.payTo + ")");
  for (const mode of SHADY_MODES) {
    shadyCtl.setMode(mode);
    const n = mode === "price_creep" ? 4 : 1;
    for (let i = 0; i < n; i++) {
      const q = await requestQuote(`${premium.baseUrl}/forecast?city=Austin`);
      if (q.kind !== "quote") throw new Error(`${mode}: expected 402, got ${q.status}`);
      const { amount, payTo, network, extraName, extraVersion } = q.quote;
      console.log(`  ${mode.padEnd(12)} ${usd(amount).padEnd(10)} payTo ${payTo} (${who(payTo)})  ${network} ${extraName} v${extraVersion}  [${q.required.accepts.length} options]`);
    }
  }

  if (!quotesOnly) {
    console.log("\n== paying the honest vendor through the firewall (full check pipeline)");
    const fw = new Firewall({
      store: new Store(":memory:"), policy: loadPolicy(), registry,
      pipeline: defaultPipeline(),
      payments: new LivePayments(new CircleWalletSigner()),
    });
    const m = fw.createMandate({ task: "M2 vendor check", allowedServices: ["weather-api", "air-quality-api"] });
    for (const [service, path] of [["weather-api", "/forecast?city=Austin"], ["air-quality-api", "/current?city=Austin"]] as const) {
      const t0 = Date.now();
      const r = await fw.submit({ kind: "x402_call", mandateId: m.id, service, path, reason: "M2 vendor check" });
      console.log(`  ${service}: ${r.outcome} ${r.amount ?? ""} USDC  gatewayTransferId=${r.gatewayTransferId ?? "-"}  (${Date.now() - t0} ms)`);
      console.log(`    ${r.detail ?? ""}`);
      console.log(`    data: ${JSON.stringify(r.data)}`);
      if (r.outcome !== "approved" || !r.gatewayTransferId) failed = true;
    }
  }
} finally {
  await Promise.all([honest.close(), shady.close()]);
}
if (failed) process.exit(1);
