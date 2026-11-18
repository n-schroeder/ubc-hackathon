// M1: the firewall core with an allow-all (or hand-made) pipeline.
import { describe, expect, it } from "vitest";
import type { Check } from "@asf/shared";
import { makeRig } from "../src/testing.ts";
import { serviceUrl, type Pipeline } from "../src/firewall.ts";

const allowAll: Pipeline = { beforeQuote: [], afterQuote: [] };

function rigWithMandate(pipeline = allowAll) {
  const rig = makeRig({ pipeline });
  const m = rig.fw.createMandate({ task: "test", allowTransfers: true });
  return { ...rig, m };
}

describe("firewall core", () => {
  it("records a ledger row and pays an x402 quote when the pipeline passes", async () => {
    const { fw, pay, m } = rigWithMandate();
    const r = await fw.submit({ kind: "x402_call", mandateId: m.id, service: "weather-api", path: "/forecast?city=Austin", reason: "need weather" });
    expect(r.outcome).toBe("approved");
    expect(r.amount).toBe("0.001");
    expect(r.gatewayTransferId).toBe("fake-1");
    expect(r.data).toEqual({ ok: true, url: "http://localhost:4021/weather/forecast?city=Austin" });
    expect(pay.paid).toHaveLength(1);
    const rows = fw.store.recent();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe("need weather");
    expect(fw.store.getMandate(m.id)!.spent).toBe(1_000n);
  });

  it("never pays twice for the same idempotency key", async () => {
    const { fw, pay, m } = rigWithMandate();
    const req = { kind: "x402_call" as const, mandateId: m.id, service: "weather-api", path: "/forecast", reason: "r", idempotencyKey: "k1" };
    const a = await fw.submit(req);
    const b = await fw.submit(req);
    expect(b.intentId).toBe(a.intentId);
    expect(b.detail).toMatch(/duplicate idempotency key/);
    expect(pay.paid).toHaveLength(1);
    expect(fw.store.recent()).toHaveLength(1);
  });

  it("serializes concurrent submissions", async () => {
    const { fw, pay, m } = rigWithMandate();
    const reqs = Array.from({ length: 5 }, (_, i) => fw.submit({ kind: "x402_call", mandateId: m.id, service: "weather-api", path: `/forecast?i=${i}`, reason: "r" }));
    const out = await Promise.all(reqs);
    expect(out.every((o) => o.outcome === "approved")).toBe(true);
    expect(fw.store.recent().map((r) => r.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(pay.paid).toHaveLength(5);
  });

  it("logs invalid intents as denials (every decision is logged)", async () => {
    const { fw, m } = rigWithMandate();
    const r = await fw.submit({ kind: "transfer", mandateId: m.id, recipient: "0xnope", amount: "1", reason: "r" });
    expect(r).toMatchObject({ outcome: "denied", rule: "intent.invalid" });
    const r2 = await fw.submit({ kind: "transfer", mandateId: m.id, recipient: "0x91D09630a50b78650170205Eb3020D9907c2853d", amount: "-5", reason: "r" });
    expect(r2.rule).toBe("intent.invalid");
    expect(fw.store.recent()).toHaveLength(2);
  });

  it("fails closed when a check throws", async () => {
    const boom: Check = { name: "boom", run: () => { throw new Error("kaboom"); } };
    const { fw, pay, m } = rigWithMandate({ beforeQuote: [], afterQuote: [boom] });
    const r = await fw.submit({ kind: "x402_call", mandateId: m.id, service: "weather-api", path: "/forecast", reason: "r" });
    expect(r).toMatchObject({ outcome: "denied", rule: "boom.error" });
    expect(pay.paid).toHaveLength(0);
  });

  it("fails closed when the vendor's 402 can't be read", async () => {
    const { fw, pay, m } = rigWithMandate();
    pay.quotes.set("http://localhost:4021/weather/", () => { throw new Error("garbage header"); });
    const r = await fw.submit({ kind: "x402_call", mandateId: m.id, service: "weather-api", path: "/forecast", reason: "r" });
    expect(r).toMatchObject({ outcome: "denied", rule: "preflight.quote_unavailable" });
  });

  it("refuses paths that escape the service's base URL", async () => {
    const { fw, pay, m, registry } = rigWithMandate();
    const w = registry.find((s) => s.id === "weather-api")!;
    expect(serviceUrl(w, "/forecast?city=X")).toBe("http://localhost:4021/weather/forecast?city=X");
    for (const p of ["/../air-quality/current", "//evil.com/x", "http://evil.com/", "forecast"]) expect(serviceUrl(w, p)).toBeUndefined();
    const r = await fw.submit({ kind: "x402_call", mandateId: m.id, service: "weather-api", path: "/../air-quality/current", reason: "r" });
    expect(r.rule).toBe("intent.bad_path");
    expect(pay.paid).toHaveLength(0);
  });

  it("escalates, waits for a human, then re-checks and pays on approval", async () => {
    const esc: Check = { name: "escalation", run: (_i, ctx) => ctx.humanApproved ? { outcome: "pass", rule: "escalation.human_approved", detail: "" } : { outcome: "escalate", rule: "escalation.over_threshold", detail: "big" } };
    const { fw, pay, m } = rigWithMandate({ beforeQuote: [], afterQuote: [esc] });
    const r = await fw.submit({ kind: "transfer", mandateId: m.id, recipient: "0x477a60aCA7a95EFc29949A5A051d5D599a4d6F6B", amount: "0.50", reason: "r" });
    expect(r.outcome).toBe("pending_human");
    expect(pay.transfers).toHaveLength(0);
    expect(fw.pendingApprovals()).toHaveLength(1);
    const ok = await fw.resolveApproval(r.intentId, true, "noah");
    expect(ok!.outcome).toBe("human_approved");
    expect(ok!.explorerUrl).toMatch(/^https:\/\/explorer\.testnet\.arc\.io\/tx\/0x/);
    expect(pay.transfers).toEqual([{ to: "0x477a60aCA7a95EFc29949A5A051d5D599a4d6F6B", amount: 500_000n }]);
    expect(fw.getIntent(r.intentId)!.outcome).toBe("human_approved");
    expect(fw.pendingApprovals()).toHaveLength(0);
    expect(await fw.resolveApproval(r.intentId, true)).toBeUndefined(); // can't approve twice
  });

  it("a human can deny an escalated intent", async () => {
    const esc: Check = { name: "escalation", run: () => ({ outcome: "escalate", rule: "escalation.over_threshold", detail: "big" }) };
    const { fw, pay, m } = rigWithMandate({ beforeQuote: [], afterQuote: [esc] });
    const r = await fw.submit({ kind: "transfer", mandateId: m.id, recipient: "0x477a60aCA7a95EFc29949A5A051d5D599a4d6F6B", amount: "0.50", reason: "r" });
    const d = await fw.resolveApproval(r.intentId, false);
    expect(d!.outcome).toBe("human_denied");
    expect(pay.transfers).toHaveLength(0);
  });

  it("records a failed transfer as failed and does not count it as spent", async () => {
    const { fw, pay, m } = rigWithMandate();
    pay.failTransfers = true;
    const r = await fw.submit({ kind: "transfer", mandateId: m.id, recipient: "0x477a60aCA7a95EFc29949A5A051d5D599a4d6F6B", amount: "0.10", reason: "r" });
    expect(r).toMatchObject({ outcome: "failed", rule: "payment.failed" });
    expect(fw.store.getMandate(m.id)!.spent).toBe(0n);
  });

  it("counts a signed x402 payment as spent even if the vendor then errors", async () => {
    const { fw, pay, m } = rigWithMandate();
    pay.vendorStatus = 500;
    const r = await fw.submit({ kind: "x402_call", mandateId: m.id, service: "weather-api", path: "/forecast", reason: "r" });
    expect(r.outcome).toBe("approved");
    expect(r.detail).toMatch(/vendor returned HTTP 500/);
    expect(fw.store.getMandate(m.id)!.spent).toBe(1_000n);
  });

  it("trips the breaker when a check asks for it", async () => {
    const trip: Check = { name: "velocity", run: () => ({ outcome: "deny", rule: "velocity.test", detail: "x", tripBreaker: true }) };
    const { fw, m } = rigWithMandate({ beforeQuote: [], afterQuote: [trip] });
    await fw.submit({ kind: "x402_call", mandateId: m.id, service: "weather-api", path: "/forecast", reason: "r" });
    expect(fw.breaker()).toMatchObject({ state: "open", rule: "velocity.test" });
    expect(fw.resetBreaker().state).toBe("closed");
  });
});
