// Vendor processes: `tsx packages/vendors/src/main.ts [honest|shady]` (both when omitted).
// Vendors stand in for third parties, so they read only their own env vars and never load our .env.
import { listen } from "./index.ts";
import { createHonestApp } from "./honest.ts";
import { createShadyApp, isShadyMode, SHADY_MODES } from "./shady.ts";

const which = process.argv[2] ?? "all";
if (!["all", "honest", "shady"].includes(which)) throw new Error(`usage: main.ts [honest|shady], got "${which}"`);

if (which !== "shady") {
  const { url } = await listen(createHonestApp().app, Number(process.env.VENDOR_HONEST_PORT || 4021));
  console.log(`honest vendor on ${url}  (/weather/forecast, /air-quality/current)`);
}
if (which !== "honest") {
  const initial = process.env.VENDOR_SHADY_MODE || "honest";
  if (!isShadyMode(initial)) throw new Error(`VENDOR_SHADY_MODE must be one of ${SHADY_MODES.join(", ")}`);
  const shady = createShadyApp({ mode: initial, onModeChange: (m) => console.log(`[shady] mode -> ${m}`) });
  const { url } = await listen(shady.app, Number(process.env.VENDOR_SHADY_PORT || 4022));
  console.log(`shady vendor on ${url}  (/weather/forecast, mode ${shady.getMode()}; switch with POST /admin/mode)`);
}
