// Onchain watchdog (QuickNode Streams): parsing Arc Transfer logs, the webhook signature, matching outflows
// against the ledger, and the alert path (breaker trips, agent stops spending).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { GATEWAY_WALLET_ADDRESS, REPO_ROOT, loadDemoAddresses, parseUsdc } from "@asf/shared";
import { arcTransferLogs, makeRig, streamDelivery, type TestRig } from "../src/testing.ts";
import { Watchdog, extractOutflows, signQuickNode, verifyQuickNode } from "../src/watchdog.ts";
import { createWatchdogApp } from "../src/watchdog-server.ts";

const WALLET = "0x115ac8ffb8241e1750ca19c26881f2a498c944b2";
const ATTACKER = loadDemoAddresses().attacker!;
const OTHER = "0x00000000000000000000000000000000000b0b01";
const tx = (n: number) => `0x${n.toString(16).padStart(64, "c")}`;
// A real Gateway deposit from the firewall wallet on Arc testnet (block 0x456b1ce): 5 USDC, logged twice.
const REAL_DEPOSIT_TX = "0x833a4234fdf9814a3b0b1abb5f7da7e36c1e5db1309aa8fa34fccbd816737f0d";

describe("extractOutflows", () => {
  it("merges Arc's ERC-20 + native Transfer pair into one 6-decimal outflow", () => {
    const logs = arcTransferLogs({ from: WALLET, to: GATEWAY_WALLET_ADDRESS, amount: 5_000_000n, txHash: REAL_DEPOSIT_TX, block: 0x456b1ce });
    expect(logs).toHaveLength(2);
    const out = extractOutflows(streamDelivery(logs), WALLET);
    expect(out).toEqual([expect.objectContaining({ txHash: REAL_DEPOSIT_TX, amount: 5_000_000n, source: "erc20", blockNumber: 0x456b1ce })]);
    expect(out[0]!.to.toLowerCase()).toBe(GATEWAY_WALLET_ADDRESS.toLowerCase());
  });

  it("still sees a movement that only appears as the native log (18 → 6 decimals)", () => {
    const logs = arcTransferLogs({ from: WALLET, to: ATTACKER, amount: 50_000n, txHash: tx(1), only: "native" });
    expect(extractOutflows(streamDelivery(logs), WALLET)).toEqual([expect.objectContaining({ amount: 50_000n, source: "native" })]);
  });

  it("ignores inflows, other wallets, other tokens, other events and reorged-out logs", () => {
    const inflow = arcTransferLogs({ from: ATTACKER, to: WALLET, amount: 1n, txHash: tx(2) });
    const other = arcTransferLogs({ from: OTHER, to: ATTACKER, amount: 1n, txHash: tx(3) });
    const token = arcTransferLogs({ from: WALLET, to: ATTACKER, amount: 1n, txHash: tx(4), only: "erc20" }).map((l) => ({ ...l, address: OTHER }));
    const approval = arcTransferLogs({ from: WALLET, to: ATTACKER, amount: 1n, txHash: tx(5), only: "erc20" })
      .map((l) => ({ ...l, topics: ["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925", ...l.topics.slice(1)] }));
    const reorged = arcTransferLogs({ from: WALLET, to: ATTACKER, amount: 1n, txHash: tx(6) }).map((l) => ({ ...l, removed: true }));
    expect(extractOutflows(streamDelivery([...inflow, ...other, ...token, ...approval, ...reorged]), WALLET)).toEqual([]);
  });

  it("reads the filter's output shape and receipt-shaped payloads too", () => {
    const logs = arcTransferLogs({ from: WALLET, to: ATTACKER, amount: 7n, txHash: tx(7) });
    expect(extractOutflows({ outflows: logs }, WALLET)).toHaveLength(1);
    expect(extractOutflows({ data: [[{ status: "0x1", logs }]] }, WALLET)).toHaveLength(1);
    expect(extractOutflows(null, WALLET)).toEqual([]);
    expect(extractOutflows("garbage", WALLET)).toEqual([]);
  });
});

describe("QuickNode webhook signature", () => {
  const token = "qn-security-token-0123456789abcdef";
  const body = JSON.stringify(streamDelivery([]));
  const sig = signQuickNode(token, "nonce-1", "1763500000", body);

  it("accepts HMAC-SHA256(nonce + timestamp + body) in hex", () => {
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyQuickNode(token, { nonce: "nonce-1", timestamp: "1763500000", signature: sig }, body)).toBe(true);
  });

  it("refuses a wrong token, a tampered body, a moved timestamp, or missing headers", () => {
    expect(verifyQuickNode("another-token-xxxxxxxxxxxxxxxxxxxx", { nonce: "nonce-1", timestamp: "1763500000", signature: sig }, body)).toBe(false);
    expect(verifyQuickNode(token, { nonce: "nonce-1", timestamp: "1763500000", signature: sig }, body + " ")).toBe(false);
    expect(verifyQuickNode(token, { nonce: "nonce-1", timestamp: "1763500001", signature: sig }, body)).toBe(false);
    expect(verifyQuickNode(token, { nonce: "nonce-1", timestamp: "1763500000" }, body)).toBe(false);
    expect(verifyQuickNode("", { nonce: "nonce-1", timestamp: "1763500000", signature: signQuickNode("", "nonce-1", "1763500000", body) }, body)).toBe(false);
  });
});

describe("Watchdog: matching outflows against the ledger", () => {
  let rig: TestRig;
  let wd: Watchdog;
  const friend = () => rig.policy.recipientAllowlist[0]!;
  const setup = () => {
    rig = makeRig();
    wd = new Watchdog(rig.fw, WALLET);
  };
  afterEach(() => wd?.stop());

  const signedTransfer = async (amount = "0.10") => {
    const m = rig.fw.createMandate({ task: "pay a friend", allowTransfers: true });
    const r = await rig.fw.submit({ kind: "transfer", mandateId: m.id, recipient: friend(), amount, reason: "tip" });
    expect(r.outcome).toBe("approved");
    return r;
  };

  it("a Gateway deposit is the firewall funding its own balance: no alert", () => {
    setup();
    const [ev] = wd.ingest(streamDelivery(arcTransferLogs({ from: WALLET, to: GATEWAY_WALLET_ADDRESS, amount: 5_000_000n, txHash: REAL_DEPOSIT_TX })));
    expect(ev!.verdict).toEqual({ status: "gateway_deposit" });
    expect(rig.fw.breaker().state).toBe("closed");
  });

  it("a transfer the firewall signed matches its ledger row by tx hash", async () => {
    setup();
    const r = await signedTransfer();
    const [ev] = wd.ingest(streamDelivery(arcTransferLogs({ from: WALLET, to: friend(), amount: parseUsdc("0.10"), txHash: r.txHash! })));
    expect(ev!.verdict).toEqual({ status: "matched_intent", intentId: r.intentId });
    expect(rig.fw.breaker().state).toBe("closed");
  });

  it("an outflow nobody signed is an alert: breaker opens and the agent's next payment is refused", async () => {
    setup();
    const m = rig.fw.createMandate({ task: "picnic" });
    const [ev] = wd.ingest(streamDelivery(arcTransferLogs({ from: WALLET, to: ATTACKER, amount: parseUsdc("0.05"), txHash: tx(9) })));
    expect(ev!.verdict).toMatchObject({ status: "alert", rule: "watchdog.unsigned_outflow" });
    expect(rig.fw.breaker()).toMatchObject({ state: "open", rule: "watchdog.unsigned_outflow" });
    const next = await rig.fw.submit({ kind: "x402_call", mandateId: m.id, service: "weather-api", path: "/forecast?city=Austin", reason: "weather" });
    expect(next).toMatchObject({ outcome: "denied", rule: "breaker.open" });
    expect(rig.pay.paid).toHaveLength(0);
  });

  it("the signed tx sending a different amount or recipient is a mismatch alert", async () => {
    setup();
    const r = await signedTransfer();
    const [ev] = wd.ingest(streamDelivery(arcTransferLogs({ from: WALLET, to: friend(), amount: parseUsdc("0.90"), txHash: r.txHash! })));
    expect(ev!.verdict).toMatchObject({ status: "alert", rule: "watchdog.mismatch" });
    expect(rig.fw.breaker().state).toBe("open");
  });

  it("a log that lands before the ledger row is written matches the transfer being signed", async () => {
    setup();
    const realTransfer = rig.pay.transfer.bind(rig.pay);
    const seen: unknown[] = [];
    rig.pay.transfer = async (to, amount) => {
      const res = await realTransfer(to, amount);
      seen.push(...wd.ingest(streamDelivery(arcTransferLogs({ from: WALLET, to, amount, txHash: res.txHash }))));
      return res;
    };
    const r = await signedTransfer();
    expect(seen).toEqual([expect.objectContaining({ verdict: { status: "matched_in_flight", intentId: r.intentId } })]);
    expect(rig.fw.breaker().state).toBe("closed");
    // The same amount to the same recipient again, unsigned this time, is NOT covered by that old intent.
    const [ev] = wd.ingest(streamDelivery(arcTransferLogs({ from: WALLET, to: friend(), amount: parseUsdc("0.10"), txHash: tx(10) })));
    expect(ev!.verdict.status).toBe("alert");
  });

  it("a transfer recorded as failed that landed anyway matches once, not twice", async () => {
    setup();
    rig.pay.failTransfers = true;
    const m = rig.fw.createMandate({ task: "pay a friend", allowTransfers: true });
    const r = await rig.fw.submit({ kind: "transfer", mandateId: m.id, recipient: friend(), amount: "0.10", reason: "tip" });
    expect(r.outcome).toBe("failed");
    const deliver = (n: number) => wd.ingest(streamDelivery(arcTransferLogs({ from: WALLET, to: friend(), amount: parseUsdc("0.10"), txHash: tx(n) })))[0]!;
    expect(deliver(11).verdict).toEqual({ status: "matched_in_flight", intentId: r.intentId });
    expect(deliver(12).verdict.status).toBe("alert");
  });

  it("re-deliveries (retries, reorg replays) are no-ops", () => {
    setup();
    const d = streamDelivery(arcTransferLogs({ from: WALLET, to: ATTACKER, amount: 1n, txHash: tx(13) }));
    expect(wd.ingest(d)).toHaveLength(1);
    rig.fw.resetBreaker();
    expect(wd.ingest(d)).toEqual([]);
    expect(rig.fw.breaker().state).toBe("closed");
    expect(wd.recent()).toHaveLength(1);
  });
});

describe("the Stream's filter function (config/quicknode/filter.js)", () => {
  const src = readFileSync(resolve(REPO_ROOT, "config/quicknode/filter.js"), "utf8").replace("__FIREWALL_WALLET__", WALLET);
  // QuickNode evaluates the file and calls main(stream); do the same.
  const main = new Function(`${src}; return main;`)() as (s: unknown) => any;

  it("keeps only USDC leaving the firewall wallet, and the webhook reads what it keeps", () => {
    const mine = arcTransferLogs({ from: WALLET, to: ATTACKER, amount: 5n, txHash: tx(20) });
    const noise = [
      ...arcTransferLogs({ from: ATTACKER, to: WALLET, amount: 5n, txHash: tx(21) }),
      ...arcTransferLogs({ from: OTHER, to: ATTACKER, amount: 5n, txHash: tx(22) }),
    ];
    const kept = main(streamDelivery([...noise, ...mine]));
    expect(kept.outflows).toHaveLength(2);
    expect(extractOutflows(kept, WALLET)).toEqual([expect.objectContaining({ txHash: tx(20), amount: 5n })]);
  });

  it("returns null (QuickNode skips the delivery) when nothing left the wallet", () => {
    expect(main(streamDelivery(arcTransferLogs({ from: OTHER, to: ATTACKER, amount: 5n, txHash: tx(23) })))).toBeNull();
    expect(main({ data: [] })).toBeNull();
  });
});

describe("webhook endpoint", () => {
  const token = "qn-security-token-0123456789abcdef";

  async function serve() {
    const rig = makeRig();
    const wd = new Watchdog(rig.fw, WALLET);
    const server = createWatchdogApp(wd, { securityToken: token, log: () => {} }).listen(0, "127.0.0.1");
    await new Promise((ok) => server.once("listening", ok));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/quicknode`;
    return { rig, wd, url, close: () => new Promise<void>((ok) => server.close(() => ok())) };
  }
  const headers = (body: string, t = token) => ({
    "content-type": "application/json", "x-qn-nonce": "n1", "x-qn-timestamp": "1763500000",
    "x-qn-signature": signQuickNode(t, "n1", "1763500000", body),
  });

  it("refuses a forged delivery before reading it", async () => {
    const s = await serve();
    const body = JSON.stringify(streamDelivery(arcTransferLogs({ from: WALLET, to: ATTACKER, amount: 1n, txHash: tx(30) })));
    const r = await fetch(s.url, { method: "POST", headers: headers(body, "forger-token-xxxxxxxxxxxxxxxxxxxxxx"), body });
    expect(r.status).toBe(401);
    expect(s.wd.recent()).toEqual([]);
    expect(s.rig.fw.breaker().state).toBe("closed");
    await s.close();
  });

  it("accepts a signed delivery, gzip included, and raises the alert", async () => {
    const s = await serve();
    const body = JSON.stringify(streamDelivery(arcTransferLogs({ from: WALLET, to: ATTACKER, amount: 1n, txHash: tx(31) })));
    const r = await fetch(s.url, { method: "POST", headers: { ...headers(body), "content-encoding": "gzip" }, body: gzipSync(body) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ outflows: 1, alerts: 1 });
    expect(s.rig.fw.breaker()).toMatchObject({ state: "open", rule: "watchdog.unsigned_outflow" });
    await s.close();
  });

  it("only serves the webhook route", async () => {
    const s = await serve();
    expect((await fetch(s.url.replace("/quicknode", "/intents"), { method: "POST" })).status).toBe(404);
    await s.close();
  });
});
