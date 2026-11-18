// M3–M6: the real check pipeline (defaultPipeline) against the real policy/registry files, with fake
// payments. Each test asserts the exact rule id, since the red-team suite and the agent depend on them.
import { describe, expect, it } from "vitest";
import { GATEWAY_WALLET_ADDRESS, USDC_ADDRESS, loadDemoAddresses, loadPolicy, parseUsdc, type IntentRequest, type Mandate, type Policy } from "@asf/shared";
import { gatewayOption, makeRig } from "../src/testing.ts";

const attacker = loadDemoAddresses().attacker!;
const policyWith = (patch: (p: Policy) => void) => { const p = loadPolicy(); patch(p); return p; };

function setup(opts: { policy?: Policy; mandate?: Parameters<ReturnType<typeof makeRig>["fw"]["createMandate"]>[0] } = {}) {
  const rig = makeRig({ policy: opts.policy });
  const m = rig.fw.createMandate(opts.mandate ?? { task: "picnic", allowTransfers: true });
  const friend = rig.policy.recipientAllowlist[0]!;
  const premium = rig.registry.find((s) => s.id === "premium-weather")!;
  const call = (path = "/forecast?city=Austin", extra: Partial<IntentRequest> = {}) =>
    rig.fw.submit({ kind: "x402_call", mandateId: m.id, service: "weather-api", path, reason: "need weather", ...extra });
  const transfer = (recipient: string, amount: string, extra: Partial<IntentRequest> = {}) =>
    rig.fw.submit({ kind: "transfer", mandateId: m.id, recipient, amount, reason: "pay", ...extra });
  const premiumCall = () => call("/forecast?city=Austin", { service: "premium-weather" });
  /** Make the shady vendor quote this option instead of its honest price. */
  const shady = (o: Partial<Parameters<typeof gatewayOption>[0]> | (() => Parameters<typeof gatewayOption>[0])) =>
    rig.pay.quote(`${premium.baseUrl}/`, typeof o === "function" ? () => gatewayOption(o()) : gatewayOption({ amount: premium.expectedPrice, payTo: premium.payTo, ...o }));
  return { ...rig, m, friend, premium, call, transfer, premiumCall, shady };
}

describe("happy path", () => {
  it("approves an honest call and every check passes, in pipeline order", async () => {
    const { fw, call, pay } = setup();
    const r = await call();
    expect(r).toMatchObject({ outcome: "approved", amount: "0.001" });
    expect(pay.paid).toHaveLength(1);
    expect(fw.store.recent()[0]!.checks.map((c) => c.rule)).toEqual([
      "breaker.closed", "mandate.active", "preflight.ok", "policy.ok", "mandate.budget_ok", "velocity.ok", "escalation.below_threshold",
    ]);
  });

  it("emits the mandate with its new spent after a paid decision", async () => {
    const { fw, call, m } = setup();
    const seen: Mandate[] = [];
    fw.on("mandate", (x) => seen.push(x));
    await call();
    expect(seen.at(-1)).toMatchObject({ id: m.id, spent: 1_000n });
  });
});

describe("breaker (P3)", () => {
  it("denies everything while open, without asking the vendor", async () => {
    const { fw, call, pay } = setup();
    fw.store.setBreaker({ state: "open", trippedAt: "2026-11-19T14:59:00Z", rule: "velocity.per_minute" });
    let asked = 0;
    const orig = pay.requestQuote.bind(pay);
    pay.requestQuote = async (u) => { asked++; return orig(u); };
    expect(await call()).toMatchObject({ outcome: "denied", rule: "breaker.open" });
    expect(asked).toBe(0);
  });
});

describe("mandate (P4)", () => {
  it("denies an unknown mandate", async () => {
    const { call } = setup();
    expect(await call("/forecast", { mandateId: "nope" })).toMatchObject({ outcome: "denied", rule: "mandate.none_active" });
  });

  it("denies payment after the task ended (completed, revoked, expired)", async () => {
    for (const end of ["completed", "revoked", "expired"] as const) {
      const { fw, m, call, clock } = setup();
      if (end === "expired") clock.advance(fw.policy.mandateDefaults.ttlSeconds + 1);
      else fw.setMandateStatus(m.id, end);
      const r = await call();
      expect(r.rule).toBe("mandate.none_active");
      expect(r.detail).toContain(end);
    }
  });

  it("denies services outside the task's scope", async () => {
    const { call } = setup({ mandate: { task: "weather only", allowedServices: ["weather-api"] } });
    expect((await call("/current?city=Austin", { service: "air-quality-api" })).rule).toBe("mandate.service_not_allowed");
    expect((await call()).outcome).toBe("approved");
  });

  it("denies transfers when the task doesn't allow them", async () => {
    const { transfer, friend } = setup({ mandate: { task: "no transfers" } });
    expect((await transfer(friend, "0.10")).rule).toBe("mandate.transfers_not_allowed");
  });

  it("denies a payment that would exceed the task budget, and everything once it is used up", async () => {
    const { call, transfer, friend } = setup({ mandate: { task: "tiny", budget: "0.002", allowTransfers: true } });
    expect((await call("/forecast?city=A")).outcome).toBe("approved");
    expect((await transfer(friend, "0.01")).rule).toBe("mandate.budget_exceeded"); // after the quote: amount > left
    expect((await call("/forecast?city=B")).outcome).toBe("approved");
    expect((await call("/forecast?city=C")).rule).toBe("mandate.budget_exceeded"); // before the quote: nothing left
  });
});

describe("pre-flight (P2)", () => {
  it("denies unknown services", async () => {
    expect((await setup().call("/x", { service: "crypto-oracle" })).rule).toBe("preflight.unknown_service");
  });

  it("payee swap → preflight.payto_mismatch", async () => {
    const { shady, premiumCall, pay } = setup();
    shady({ payTo: attacker });
    const r = await premiumCall();
    expect(r).toMatchObject({ outcome: "denied", rule: "preflight.payto_mismatch" });
    expect(r.detail).toMatch(/payTo 0x91D0…853d ≠ pinned 0x4eA9…a2F4 for premium-weather/);
    expect(pay.paid).toHaveLength(0);
  });

  it("overcharge → preflight.price_out_of_band", async () => {
    const { shady, premiumCall } = setup();
    shady({ amount: parseUsdc("0.05") });
    expect((await premiumCall()).rule).toBe("preflight.price_out_of_band");
  });

  it("allows up to the +50% band", async () => {
    const { shady, premiumCall } = setup();
    shady({ amount: parseUsdc("0.0015") });
    expect((await premiumCall()).outcome).toBe("approved");
  });

  it("price creep: +25% over the last paid price → preflight.price_drift, then out of band", async () => {
    const { shady, premiumCall, premium } = setup();
    let price = premium.expectedPrice;
    shady(() => { const p = price; price = (price * 125n + 99n) / 100n; return { amount: p, payTo: premium.payTo }; });
    expect((await premiumCall()).outcome).toBe("approved"); // $0.001
    expect((await premiumCall()).rule).toBe("preflight.price_drift"); // $0.00125
    expect((await premiumCall()).rule).toBe("preflight.price_out_of_band"); // $0.001563
  });

  it("allows small increases under the drift limit", async () => {
    const { shady, premiumCall, premium } = setup();
    let price = premium.expectedPrice;
    shady(() => { const p = price; price = (price * 110n) / 100n; return { amount: p, payTo: premium.payTo }; });
    expect((await premiumCall()).outcome).toBe("approved");
    expect((await premiumCall()).outcome).toBe("approved");
  });

  it("refuses to sign anything but a Gateway batched authorization on Arc USDC", async () => {
    const cases: [Partial<Parameters<typeof gatewayOption>[0]>, string][] = [
      [{ extra: { name: "USDC" } }, "preflight.scheme_mismatch"],
      [{ scheme: "upto" }, "preflight.scheme_mismatch"],
      [{ network: "eip155:1" }, "preflight.network_mismatch"],
      [{ asset: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" }, "preflight.asset_mismatch"],
      [{ extra: { verifyingContract: USDC_ADDRESS } }, "preflight.verifying_contract"],
    ];
    for (const [o, rule] of cases) {
      const { shady, premiumCall, pay } = setup();
      shady(o);
      expect((await premiumCall()).rule, rule).toBe(rule);
      expect(pay.paid).toHaveLength(0);
    }
    const { shady, premiumCall } = setup();
    shady({ extra: { verifyingContract: GATEWAY_WALLET_ADDRESS.toLowerCase() } }); // case doesn't matter
    expect((await premiumCall()).outcome).toBe("approved");
  });
});

describe("policy (P1)", () => {
  it("injection: transfer to an unknown address → policy.recipient_not_allowed (and names the cap too)", async () => {
    const { transfer, pay } = setup();
    const r = await transfer(attacker, "50");
    expect(r).toMatchObject({ outcome: "denied", rule: "policy.recipient_not_allowed" });
    expect(r.detail).toMatch(/not on the allowlist.*exceeds the \$1\.00 per-transfer cap/);
    expect(pay.transfers).toHaveLength(0);
  });

  it("injection: 50 USDC to an allowed recipient → policy.per_tx_cap", async () => {
    const { transfer, friend } = setup();
    expect((await transfer(friend, "50")).rule).toBe("policy.per_tx_cap");
  });

  it("per-call max", async () => {
    const { call } = setup({ policy: policyWith((p) => { p.perCallMax = parseUsdc("0.0005"); }) });
    expect((await call()).rule).toBe("policy.per_call_max");
  });

  it("daily budget across all mandates", async () => {
    const { call } = setup({ policy: policyWith((p) => { p.dailyBudget = parseUsdc("0.002"); }) });
    expect((await call("/forecast?city=A")).outcome).toBe("approved");
    expect((await call("/forecast?city=B")).outcome).toBe("approved");
    expect((await call("/forecast?city=C")).rule).toBe("policy.daily_budget");
  });
});

describe("escalation (P1)", () => {
  it("queues a transfer over the threshold; a human approval pays it", async () => {
    const { fw, transfer, friend, pay } = setup();
    const r = await transfer(friend, "0.30");
    expect(r).toMatchObject({ outcome: "pending_human", rule: "escalation.over_threshold" });
    expect(pay.transfers).toHaveLength(0);
    const a = await fw.resolveApproval(r.intentId, true, "dashboard");
    expect(a?.outcome).toBe("human_approved");
    expect(pay.transfers).toHaveLength(1);
    expect(fw.store.byIntentId(r.intentId)!.row.checks.map((c) => c.rule)).toContain("escalation.human_approved");
  });

  it("a human denial never pays", async () => {
    const { fw, transfer, friend, pay } = setup();
    const r = await transfer(friend, "0.30");
    expect((await fw.resolveApproval(r.intentId, false))?.outcome).toBe("human_denied");
    expect(pay.transfers).toHaveLength(0);
  });

  it("an approval is re-checked: it can't pay while the breaker is open", async () => {
    const { fw, transfer, friend, pay } = setup();
    const r = await transfer(friend, "0.30");
    fw.store.setBreaker({ state: "open", trippedAt: "x", rule: "velocity.per_minute" });
    expect(await fw.resolveApproval(r.intentId, true)).toMatchObject({ outcome: "denied", rule: "breaker.open" });
    expect(pay.transfers).toHaveLength(0);
  });

  it("approved transfers don't count toward the nanopayment velocity limit", async () => {
    const { fw, transfer, friend, call } = setup();
    const r = await transfer(friend, "0.30");
    expect((await fw.resolveApproval(r.intentId, true))?.outcome).toBe("human_approved");
    expect((await call()).outcome).toBe("approved");
    expect(fw.breaker().state).toBe("closed");
  });
});

describe("velocity (P3)", () => {
  it("runaway loop on one request → velocity.duplicate, trips the breaker", async () => {
    const { fw, call } = setup();
    for (let i = 0; i < fw.policy.velocity.duplicateLimit; i++) expect((await call()).outcome).toBe("approved");
    const r = await call();
    expect(r).toMatchObject({ outcome: "denied", rule: "velocity.duplicate" });
    expect(fw.breaker()).toMatchObject({ state: "open", rule: "velocity.duplicate" });
    expect((await call("/forecast?city=Elsewhere")).rule).toBe("breaker.open");
  });

  it("duplicates outside the window are fine", async () => {
    const { fw, call, clock } = setup();
    for (let i = 0; i < fw.policy.velocity.duplicateLimit; i++) await call();
    clock.advance(fw.policy.velocity.duplicateWindowSeconds + 1);
    expect((await call()).outcome).toBe("approved");
  });

  it("$/minute over the limit → velocity.per_minute with the rate in the detail", async () => {
    const { fw, call } = setup({ policy: policyWith((p) => { p.velocity.perMinute = parseUsdc("0.005"); }) });
    for (let i = 0; i < 5; i++) expect((await call(`/forecast?city=C${i}`)).outcome).toBe("approved");
    const r = await call("/forecast?city=C5");
    expect(r).toMatchObject({ outcome: "denied", rule: "velocity.per_minute", detail: "VELOCITY $0.006/min > $0.005/min, spending paused" });
    expect(fw.breaker().state).toBe("open");
  });

  it("the per-minute window rolls", async () => {
    const { call, clock } = setup({ policy: policyWith((p) => { p.velocity.perMinute = parseUsdc("0.005"); }) });
    for (let i = 0; i < 5; i++) await call(`/forecast?city=C${i}`);
    clock.advance(61);
    expect((await call("/forecast?city=C5")).outcome).toBe("approved");
  });

  it("a human reset is a clean slate: the next call doesn't re-trip on pre-reset spend", async () => {
    const { fw, call, clock } = setup({ policy: policyWith((p) => { p.velocity.perMinute = parseUsdc("0.005"); }) });
    for (let i = 0; i < 6; i++) await call(`/forecast?city=C${i}`);
    expect(fw.breaker().state).toBe("open");
    clock.advance(5);
    expect(fw.resetBreaker().resetAt).toBe(clock.now.toISOString());
    clock.advance(1);
    expect((await call("/forecast?city=D")).outcome).toBe("approved");
    expect(fw.breaker().state).toBe("closed");
  });

  it("calls per service per task → velocity.calls_per_service", async () => {
    const { call } = setup({ policy: policyWith((p) => { p.velocity.maxCallsPerServicePerTask = 3; }) });
    for (let i = 0; i < 3; i++) expect((await call(`/forecast?city=C${i}`, { taskProgress: `step ${i}` })).outcome).toBe("approved");
    expect((await call("/forecast?city=C3", { taskProgress: "step 3" })).rule).toBe("velocity.calls_per_service");
  });

  it("slow drain (new page every time, no progress) → velocity.no_progress", async () => {
    const { fw, call } = setup();
    const limit = fw.policy.velocity.noProgressLimit;
    for (let p = 1; p <= limit; p++) expect((await call(`/forecast?city=Austin&page=${p}`, { taskProgress: "weather for Austin" })).outcome).toBe("approved");
    const r = await call(`/forecast?city=Austin&page=${limit + 1}`, { taskProgress: "weather for Austin" });
    expect(r).toMatchObject({ outcome: "denied", rule: "velocity.no_progress" });
    expect(fw.breaker().state).toBe("open");
  });

  it("making progress keeps the no-progress rule quiet", async () => {
    const { fw, call } = setup();
    for (let p = 0; p <= fw.policy.velocity.noProgressLimit + 2; p++) {
      expect((await call(`/forecast?city=C${p}`, { taskProgress: `cities done: ${p}` })).outcome).toBe("approved");
    }
  });

  it("transfers aren't subject to velocity rules", async () => {
    const { transfer, friend } = setup({ policy: policyWith((p) => { p.velocity.perMinute = parseUsdc("0.01"); }) });
    for (let i = 0; i < 3; i++) expect((await transfer(friend, "0.05", { reason: `t${i}` })).outcome).toBe("approved");
  });
});
