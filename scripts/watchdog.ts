// Onchain watchdog helpers (QuickNode Streams). See README "Watchdog (QuickNode Streams)".
//
//   npm run watchdog:stream               print the Stream's settings and write the ready-to-paste filter
//                                         to data/quicknode-filter.js (for the QuickNode dashboard)
//   npm run watchdog:stream -- --create   create the Stream through QuickNode's REST API instead
//                                         (needs QUICKNODE_API_KEY and WATCHDOG_PUBLIC_URL in .env)
//   npm run watchdog:simulate [-- deposit|unsigned] [--public]
//                                         POST a correctly signed, SIMULATED delivery to the local webhook,
//                                         to check the wiring without QuickNode or money. `unsigned` (default)
//                                         uses a made-up tx hash, so its explorer link goes nowhere.
//                                         --public sends it through the tunnel (WATCHDOG_PUBLIC_URL) instead.
//   npm run watchdog:rogue -- --yes       REAL testnet transfer of 0.01 USDC from the firewall wallet to the
//                                         demo attacker, straight through Circle's API, bypassing the firewall.
//                                         That is the attack the watchdog exists to catch. Moves real funds:
//                                         only run it when the wallet owner has said yes.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress } from "viem";
import { GATEWAY_WALLET_ADDRESS, REPO_ROOT, loadDemoAddresses, optionalEnv, parseUsdc, requireEnv, txUrl } from "@asf/shared";
import { arcTransferLogs, streamDelivery } from "@asf/firewall/testing";
import { signQuickNode } from "@asf/firewall/watchdog";

const cmd = process.argv[2];
const args = process.argv.slice(3);
const wallet = () => getAddress(requireEnv("CIRCLE_FIREWALL_WALLET_ADDRESS"));
// The webhook's public URL (WATCHDOG_PUBLIC_URL, with or without the /quicknode suffix), or undefined.
const publicHook = () => {
  const hook = optionalEnv("WATCHDOG_PUBLIC_URL");
  return hook ? `${hook.replace(/\/+$/, "").replace(/\/quicknode$/, "")}/quicknode` : undefined;
};
const QN_API = "https://api.quicknode.com/streams/rest/v1";

function filterSource(): string {
  return readFileSync(resolve(REPO_ROOT, "config/quicknode/filter.js"), "utf8").replace("__FIREWALL_WALLET__", wallet().toLowerCase());
}

async function stream() {
  const src = filterSource();
  const out = resolve(REPO_ROOT, "data/quicknode-filter.js");
  mkdirSync(resolve(out, ".."), { recursive: true });
  writeFileSync(out, src);
  const hook = publicHook();
  const destination = hook ?? "<your tunnel URL>/quicknode";
  const network = optionalEnv("QUICKNODE_NETWORK", "arc-testnet")!;

  if (!args.includes("--create")) {
    console.log(`QuickNode Stream for the onchain watchdog: create it at https://dashboard.quicknode.com/streams

  Network       Arc Testnet
  Dataset       Logs
  Start         latest block (only new outflows matter)
  Batch size    5 blocks     (QuickNode asks for at least 5 on sub-second chains like Arc)
  Reorg fixes   on           (re-delivered logs are de-duplicated by the webhook)
  Filter        JavaScript, paste ${out}
                (keeps USDC Transfer logs FROM ${wallet()})
  Destination   Webhook  ${destination}
                Compression: none or gzip (both work). Keep the security token it shows you.

Then put the token in .env as QUICKNODE_STREAM_TOKEN and restart the firewall (npm run demo or npm run firewall).
The firewall prints "watchdog webhook on http://127.0.0.1:4023/quicknode"; tunnel that port (only) with
  npm run tunnel`);
    return;
  }

  const key = requireEnv("QUICKNODE_API_KEY");
  if (!hook) throw new Error("set WATCHDOG_PUBLIC_URL in .env to the public (tunnel) URL of port 4023");
  const body = {
    name: "asf-watchdog: USDC leaving the firewall wallet",
    network,
    dataset: "logs",
    filter_function: Buffer.from(src).toString("base64"),
    region: "usa_east",
    start_range: -1,
    end_range: -1,
    dataset_batch_size: 5,
    include_stream_metadata: "body",
    elastic_batch_enabled: true,
    fix_block_reorgs: 1,
    keep_distance_from_tip: 0,
    destination: "webhook",
    destination_attributes: { url: destination, compression: "none", max_retry: 3, retry_interval_sec: 1, post_timeout_sec: 10 },
    status: "active",
  };
  const res = await fetch(`${QN_API}/streams`, {
    method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`QuickNode said HTTP ${res.status}: ${JSON.stringify(j)}`);
    console.error("If the network name is the problem, set QUICKNODE_NETWORK in .env to the slug the dashboard shows for Arc Testnet.");
    process.exit(1);
  }
  console.log(`created stream ${j.id} on ${j.network ?? network}`);
  const token = j.destination_attributes?.security_token;
  if (token) console.log(`\nAdd to .env, then restart the firewall:\nQUICKNODE_STREAM_TOKEN=${token}`);
}

async function simulate() {
  const token = requireEnv("QUICKNODE_STREAM_TOKEN");
  const port = optionalEnv("WATCHDOG_PORT", "4023");
  const kind = args.find((a) => !a.startsWith("--")) ?? "unsigned";
  // --public sends it through the tunnel (WATCHDOG_PUBLIC_URL), the way QuickNode reaches the webhook.
  const url = args.includes("--public")
    ? (publicHook() ?? (() => { throw new Error("--public needs WATCHDOG_PUBLIC_URL in .env"); })())
    : `http://127.0.0.1:${port}/quicknode`;
  const logs = kind === "deposit"
    ? arcTransferLogs({ from: wallet(), to: GATEWAY_WALLET_ADDRESS, amount: parseUsdc("5"), txHash: "0x833a4234fdf9814a3b0b1abb5f7da7e36c1e5db1309aa8fa34fccbd816737f0d" })
    : arcTransferLogs({ from: wallet(), to: loadDemoAddresses().attacker!, amount: parseUsdc("0.01"), txHash: `0x${"5e".repeat(32)}` });
  const body = JSON.stringify(streamDelivery(logs));
  const nonce = Math.random().toString(36).slice(2);
  const ts = String(Math.floor(Date.now() / 1000));
  const r = await fetch(url, {
    method: "POST", body,
    headers: { "content-type": "application/json", "x-qn-nonce": nonce, "x-qn-timestamp": ts, "x-qn-signature": signQuickNode(token, nonce, ts, body) },
  });
  console.log(`SIMULATED ${kind} delivery to ${url} → HTTP ${r.status} ${await r.text()}`);
  if (kind !== "deposit") console.log("(made-up tx hash: this checks the wiring, it is not onchain evidence)");
}

async function rogue() {
  if (!args.includes("--yes")) {
    console.error("This sends 0.01 real testnet USDC from the firewall wallet to the demo attacker, bypassing the firewall.\n" +
      "Re-run with --yes once the wallet owner has agreed.");
    process.exit(2);
  }
  const { CircleWalletSigner } = await import("@asf/firewall/signer");
  const to = loadDemoAddresses().attacker!;
  const signer = new CircleWalletSigner();
  console.log(`rogue transfer: 0.01 USDC ${signer.address} → ${to}, NOT through the firewall…`);
  const { txHash } = await signer.transfer(to, parseUsdc("0.01"));
  console.log(`sent: ${txUrl(txHash)}\nThe Stream should deliver it within seconds; watch the dashboard's watchdog panel.`);
}

const cmds: Record<string, () => Promise<void>> = { stream, simulate, rogue };
if (!cmd || !cmds[cmd]) {
  console.error("usage: tsx scripts/watchdog.ts stream [--create] | simulate [deposit|unsigned] [--public] | rogue --yes");
  process.exit(2);
}
await cmds[cmd]!();
