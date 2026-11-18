// F6/F23: nanopayment rows get their Gateway batch tx hash + explorer link once Circle settles them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_API_TESTNET, txUrl, type LedgerRow } from "@asf/shared";
import { makeRig } from "../src/testing.ts";
import { SettlementWatcher, gatewayTransferLookup } from "../src/settlement.ts";

const HASH = "0xba85940fcf603601afd41d575d905b8691fd7546c766f116b14e3335618c4915";

/** A fake Gateway API: answers `GET /x402/transfers/:id` from `transfers`. */
function fakeGateway() {
  const transfers = new Map<string, { status: string; txHash: string | null }>();
  const calls: string[] = [];
  let failNext = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (failNext > 0) { failNext--; return new Response("upstream down", { status: 503 }); }
    const id = decodeURIComponent(url.slice(`${GATEWAY_API_TESTNET}/x402/transfers/`.length));
    const t = transfers.get(id);
    if (!t) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    return Response.json({ id, token: "USDC", amount: "1000", ...t });
  }) as typeof fetch;
  return { transfers, calls, fetchImpl, failTimes: (n: number) => { failNext = n; } };
}

async function paidRig(opts: ConstructorParameters<typeof SettlementWatcher>[2] = {}) {
  const rig = makeRig();
  const m = rig.fw.createMandate({ task: "picnic" });
  const gw = fakeGateway();
  const logs: string[] = [];
  const watcher = new SettlementWatcher(rig.fw, gatewayTransferLookup(gw.fetchImpl), {
    firstDelayMs: 1000, maxDelayMs: 4000, factor: 2, maxTries: 5, log: (s) => logs.push(s), ...opts,
  });
  const events: LedgerRow[] = [];
  rig.fw.on("decision", (r) => events.push(r));
  const pay = () => rig.fw.submit({ kind: "x402_call", mandateId: m.id, service: "weather-api", path: "/forecast", reason: "need weather" });
  return { ...rig, m, gw, watcher, logs, events, pay };
}

describe("settlement watcher", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("adds the batch tx hash + explorer link to a paid nanopayment row, and emits it", async () => {
    const { fw, gw, watcher, events, pay } = await paidRig();
    watcher.start();
    const r = await pay();
    expect(r.gatewayTransferId).toBe("fake-1");
    expect(watcher.pending()).toEqual([r.intentId]);
    gw.transfers.set("fake-1", { status: "received", txHash: null });

    await vi.advanceTimersByTimeAsync(1000);
    expect(gw.calls).toEqual([`${GATEWAY_API_TESTNET}/x402/transfers/fake-1`]);
    expect(fw.store.byIntentId(r.intentId)!.row.txHash).toBeUndefined();

    gw.transfers.set("fake-1", { status: "completed", txHash: HASH });
    await vi.advanceTimersByTimeAsync(2000); // backoff: 1 s, then 2 s
    expect(gw.calls).toHaveLength(2);

    const row = fw.store.byIntentId(r.intentId)!.row;
    expect(row).toMatchObject({ txHash: HASH, explorerUrl: txUrl(HASH), gatewayTransferId: "fake-1", outcome: "approved" });
    expect(fw.getIntent(r.intentId)!.explorerUrl).toBe(txUrl(HASH));
    // The live log gets the same row again (the dashboard upserts it by intentId).
    expect(events.map((e) => e.intentId)).toEqual([r.intentId, r.intentId]);
    expect(events[1]!.explorerUrl).toBe(txUrl(HASH));
    expect(watcher.pending()).toEqual([]);
  });

  it("changes only txHash and explorerUrl; the decision and spend are untouched", async () => {
    const { fw, m, gw, watcher, pay } = await paidRig();
    watcher.start();
    const r = await pay();
    const before = fw.store.byIntentId(r.intentId)!.row;
    gw.transfers.set("fake-1", { status: "batched", txHash: HASH });
    await vi.advanceTimersByTimeAsync(1000);
    const after = fw.store.byIntentId(r.intentId)!.row;
    expect(after).toEqual({ ...before, txHash: HASH, explorerUrl: txUrl(HASH) });
    expect(fw.store.recent()).toHaveLength(1);
    expect(fw.store.getMandate(m.id)!.spent).toBe(1_000n);
  });

  it("keeps polling through lookup errors and 404s, with backoff capped at maxDelayMs", async () => {
    const { fw, gw, watcher, logs, pay } = await paidRig();
    watcher.start();
    const r = await pay();
    gw.failTimes(1);
    await vi.advanceTimersByTimeAsync(1000); // try 1: 503
    await vi.advanceTimersByTimeAsync(2000); // try 2: 404 (not visible yet)
    gw.transfers.set("fake-1", { status: "received", txHash: null });
    await vi.advanceTimersByTimeAsync(4000); // try 3: received
    expect(gw.calls).toHaveLength(3);
    gw.transfers.set("fake-1", { status: "completed", txHash: HASH });
    await vi.advanceTimersByTimeAsync(3999);
    expect(gw.calls).toHaveLength(3); // capped at 4 s, not 8 s
    await vi.advanceTimersByTimeAsync(1);
    expect(gw.calls).toHaveLength(4);
    expect(fw.store.byIntentId(r.intentId)!.row.txHash).toBe(HASH);
    expect(logs.some((l) => /HTTP 503/.test(l))).toBe(true);
  });

  it("gives up after maxTries, and stops at once when Gateway reports the transfer failed", async () => {
    const { gw, watcher, logs, pay } = await paidRig();
    watcher.start();
    await pay();
    gw.transfers.set("fake-1", { status: "received", txHash: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gw.calls).toHaveLength(5);
    expect(watcher.pending()).toEqual([]);
    expect(logs.at(-1)).toMatch(/gave up .* after 5 lookups \(status received\)/);

    await pay();
    gw.transfers.set("fake-2", { status: "failed", txHash: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gw.calls.filter((c) => c.endsWith("fake-2"))).toHaveLength(1);
    expect(logs.at(-1)).toMatch(/fake-2 failed/);
  });

  it("ignores a malformed tx hash from Gateway", async () => {
    const { fw, gw, watcher, pay } = await paidRig({ maxTries: 2 });
    watcher.start();
    const r = await pay();
    gw.transfers.set("fake-1", { status: "completed", txHash: "javascript:alert(1)" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fw.store.byIntentId(r.intentId)!.row.explorerUrl).toBeUndefined();
  });

  it("does not watch denials, direct transfers, or rows that already have a tx hash", async () => {
    const { fw, m, gw, watcher } = await paidRig();
    watcher.start();
    // Denied: outside the mandate's services, so nothing was paid.
    await fw.submit({ kind: "x402_call", mandateId: "no-such-mandate", service: "weather-api", path: "/x", reason: "r" });
    // Direct transfer: has its own tx hash already (and this mandate doesn't allow transfers anyway).
    await fw.submit({ kind: "transfer", mandateId: m.id, recipient: "0x91D09630a50b78650170205Eb3020D9907c2853d", amount: "0.01", reason: "r" });
    expect(watcher.pending()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gw.calls).toEqual([]);
  });

  it("resumes unsettled rows from the ledger on start (firewall restart)", async () => {
    const { fw, gw, watcher, pay } = await paidRig();
    const r = await pay(); // paid while no watcher was running
    gw.transfers.set("fake-1", { status: "completed", txHash: HASH });
    watcher.start();
    expect(watcher.pending()).toEqual([r.intentId]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fw.store.byIntentId(r.intentId)!.row.txHash).toBe(HASH);
  });

  it("stop() cancels pending lookups", async () => {
    const { gw, watcher, pay } = await paidRig();
    watcher.start();
    await pay();
    watcher.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gw.calls).toEqual([]);
  });
});

describe("Firewall.recordSettlement", () => {
  it("refuses rows that aren't paid nanopayments, and never overwrites a tx hash", async () => {
    const rig = makeRig();
    const m = rig.fw.createMandate({ task: "t" });
    const denied = await rig.fw.submit({ kind: "x402_call", mandateId: "nope", service: "weather-api", path: "/", reason: "r" });
    expect(rig.fw.recordSettlement(denied.intentId, HASH)).toBeUndefined();
    expect(rig.fw.recordSettlement("missing", HASH)).toBeUndefined();
    const paid = await rig.fw.submit({ kind: "x402_call", mandateId: m.id, service: "weather-api", path: "/", reason: "r" });
    expect(rig.fw.recordSettlement(paid.intentId, HASH)?.txHash).toBe(HASH);
    expect(rig.fw.recordSettlement(paid.intentId, "0x" + "1".repeat(64))).toBeUndefined();
    expect(rig.fw.store.byIntentId(paid.intentId)!.row.txHash).toBe(HASH);
  });
});
