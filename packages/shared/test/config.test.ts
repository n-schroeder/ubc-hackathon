import { describe, expect, it } from "vitest";
import { loadPolicy, loadRegistry, parsePolicy, remapLocalPorts, toListing } from "../src/config.ts";

describe("config", () => {
  it("loads policy.json with bigint amounts", () => {
    const p = loadPolicy();
    expect(p.perCallMax).toBe(10_000n);
    expect(p.humanApprovalAbove).toBe(250_000n);
    expect(p.dailyBudget).toBe(5_000_000n);
    expect(p.velocity.perMinute).toBe(50_000n);
    expect(p.recipientAllowlist.length).toBeGreaterThan(0);
  });
  it("loads registry.json with pinned, checksummed payTo", () => {
    const r = loadRegistry();
    const w = r.find((e) => e.id === "weather-api")!;
    expect(w.expectedPrice).toBe(1_000n);
    expect(w.payTo).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(w.status).toBe("pinned");
  });
  it("the agent's listing carries no addresses (P5 piece)", () => {
    for (const e of loadRegistry()) {
      const l = toListing(e);
      expect(JSON.stringify(l)).not.toMatch(/0x[0-9a-fA-F]{40}/);
      expect(Object.keys(l).sort()).toEqual(["category", "description", "expectedPrice", "id"]);
    }
  });
  it("vendor URLs follow VENDOR_*_PORT, so moving a vendor doesn't break preflight", () => {
    const url = (r: ReturnType<typeof loadRegistry>, id: string) => r.find((e) => e.id === id)!.baseUrl;
    const r = loadRegistry(undefined, { "4021": "5021", "4022": 5022 });
    expect(url(r, "weather-api")).toBe("http://localhost:5021/weather");
    expect(url(r, "air-quality-api")).toBe("http://localhost:5021/air-quality");
    expect(url(r, "premium-weather")).toBe("http://localhost:5022/weather");
    const d = loadRegistry(undefined, {});
    expect(url(d, "weather-api")).toBe("http://localhost:4021/weather");
    expect(url(d, "premium-weather")).toBe("http://localhost:4022/weather");
  });
  it("only local URLs are re-pointed, and a bad port fails closed", () => {
    const [e] = loadRegistry(undefined, {});
    const remote = { ...e!, baseUrl: "https://api.example.com:4021/weather" };
    expect(remapLocalPorts([remote], { "4021": 5021 })[0]!.baseUrl).toBe(remote.baseUrl);
    expect(() => remapLocalPorts([e!], { "4021": "abc" })).toThrow(/Bad port/);
    expect(() => remapLocalPorts([e!], { "4021": 70000 })).toThrow(/Bad port/);
  });
  it("rejects a malformed policy (fail closed at startup)", () => {
    expect(() => parsePolicy({ ...rawPolicy(), perCallMax: "ten cents" })).toThrow();
    expect(() => parsePolicy({ ...rawPolicy(), recipientAllowlist: ["0xnope"] })).toThrow();
  });
});

const rawPolicy = () => ({
  perCallMax: "0.01", perTransferCap: "1", humanApprovalAbove: "0.25", dailyBudget: "5", recipientAllowlist: [],
  mandateDefaults: { budget: "0.5", ttlSeconds: 600 }, preflight: { maxDriftPct: 20 },
  velocity: { perMinute: "0.05", maxCallsPerServicePerTask: 200, duplicateLimit: 5, duplicateWindowSeconds: 60, noProgressLimit: 10 },
});
