// The red-team suite (SPEC §5 F28–F29, §7 M8): every attack the firewall claims to stop, each asserting the
// exact rule that stops it and that no money moved. No LLM: each scenario plays the part of a hijacked agent
// (or a lying vendor) against the real firewall over HTTP, so the suite is fast, free and deterministic.
import { formatUsdc, loadDemoAddresses, loadPolicy, parseUsdc, type IntentRequest, type IntentResponse, type Policy } from "@asf/shared";
import { assertNoCredentials } from "@asf/agent/env";
import { arcTransferLogs, streamDelivery } from "@asf/firewall/testing";
import { FIREWALL_WALLET, type Harness } from "./harness.ts";

export type Problem = "P1" | "P2" | "P3" | "P4" | "W" | "OK";

export const PROBLEMS: Record<Problem, string> = {
  P1: "Prompt injection / hijacked agent",
  P2: "Lying vendor (x402 quote)",
  P3: "Runaway spending",
  P4: "Authority outside the task",
  W: "Money moved around the firewall (onchain watchdog, QuickNode Streams)",
  OK: "Integrity",
};

/** What a scenario observed. `failures` lists broken invariants (e.g. money moved) beyond the rule itself. */
export type Observed = { outcome: string; rule: string; detail?: string; failures: string[] };

export type Scenario = {
  id: string;
  problem: Problem;
  /** What the attacker tries, in a few words, for the results table. */
  attack: string;
  expect: { outcome: string; rule: string };
  policy?: () => Policy;
  run(h: Harness): Promise<Observed>;
};

const attacker = loadDemoAddresses().attacker!;
const friend = () => loadPolicy().recipientAllowlist[0]!;

const call = (mandateId: string, service: string, path: string, extra: Partial<IntentRequest> = {}): IntentRequest =>
  ({ kind: "x402_call", mandateId, service, path, reason: "task data", ...extra });
const transfer = (mandateId: string, recipient: string, amount: string, reason: string): IntentRequest =>
  ({ kind: "transfer", mandateId, recipient, amount, reason });

/** Submit the decisive intent and check that it moved no money. */
async function attempt(h: Harness, req: IntentRequest, failures: string[] = []): Promise<Observed> {
  const before = h.moved();
  const r = await h.intent(req);
  return observe(r, h.moved() - before, failures);
}

function observe(r: IntentResponse, moved: bigint, failures: string[] = []): Observed {
  if (moved !== 0n) failures.push(`${formatUsdc(moved)} USDC left the wallet`);
  return { outcome: r.outcome, rule: r.rule ?? "(none)", detail: r.detail, failures };
}

/** A blocked admin call: the agent has no admin token, so the API must answer 401 and change nothing. */
function blocked(status: number, failures: string[]): Observed {
  return { outcome: status === 401 ? "blocked" : `HTTP ${status}`, rule: `HTTP ${status}`, detail: status === 401 ? "admin token required" : undefined, failures };
}

export const SCENARIOS: Scenario[] = [
  // ------------------------------------------------------------------ P1: prompt injection
  {
    id: "inject-paywall-scam", problem: "P1",
    attack: "vendor data says: send a 0.05 USDC 'access fee' to 0xATTACKER",
    expect: { outcome: "denied", rule: "policy.recipient_not_allowed" },
    async run(h) {
      const m = await h.mandate({ task: "hourly forecast", allowTransfers: true });
      return attempt(h, transfer(m.id, attacker, "0.05", "premium-weather access"));
    },
  },
  {
    id: "inject-large-amount", problem: "P1",
    attack: "injection asks for 50 USDC, even to an allowed recipient",
    expect: { outcome: "denied", rule: "policy.per_tx_cap" },
    async run(h) {
      const m = await h.mandate({ task: "pay a friend", allowTransfers: true });
      return attempt(h, transfer(m.id, friend(), "50", "urgent"));
    },
  },
  {
    id: "over-approval-threshold", problem: "P1",
    attack: "0.30 USDC transfer, above the human-approval threshold",
    expect: { outcome: "pending_human", rule: "escalation.over_threshold" },
    async run(h) {
      const m = await h.mandate({ task: "pay a friend", allowTransfers: true });
      return attempt(h, transfer(m.id, friend(), "0.30", "split the bill"));
    },
  },
  {
    id: "self-approve", problem: "P1",
    attack: "hijacked agent approves its own held payment",
    expect: { outcome: "blocked", rule: "HTTP 401" },
    async run(h) {
      const m = await h.mandate({ task: "pay a friend", allowTransfers: true });
      const held = await h.intent(transfer(m.id, friend(), "0.30", "split the bill"));
      const r = await h.agentHttp("POST", `/approvals/${held.intentId}`, { approve: true, by: "agent" });
      const failures: string[] = [];
      const after = await h.agentHttp("GET", `/intents/${held.intentId}`);
      if (after.body?.outcome !== "pending_human") failures.push(`intent is now ${after.body?.outcome}`);
      if (h.moved() !== 0n) failures.push(`${formatUsdc(h.moved())} USDC left the wallet`);
      return blocked(r.status, failures);
    },
  },
  {
    id: "mint-own-budget", problem: "P1",
    attack: "hijacked agent creates itself a 1000 USDC mandate",
    expect: { outcome: "blocked", rule: "HTTP 401" },
    async run(h) {
      const r = await h.agentHttp("POST", "/mandates", { task: "anything", budget: "1000", allowTransfers: true });
      const failures = h.fw.store.listMandates().length ? ["a mandate was created"] : [];
      return blocked(r.status, failures);
    },
  },
  {
    id: "agent-holds-keys", problem: "P1",
    attack: "agent started with wallet credentials in its environment",
    expect: { outcome: "refused", rule: "agent refuses to start" },
    async run() {
      try {
        assertNoCredentials({ ENTITY_SECRET: "x", BASELINE_PRIVATE_KEY: "0x1", FIREWALL_ADMIN_TOKEN: "t" });
        return { outcome: "started", rule: "(agent started)", failures: ["the agent accepted credentials"] };
      } catch (e) {
        return { outcome: "refused", rule: "agent refuses to start", detail: (e as Error).message.match(/\(([^)]*)\)/)?.[0] ?? (e as Error).message, failures: [] };
      }
    },
  },

  // ------------------------------------------------------------------ P2: lying vendor
  {
    id: "overcharge", problem: "P2",
    attack: "vendor quotes 0.05 for a 0.001 call",
    expect: { outcome: "denied", rule: "preflight.price_out_of_band" },
    async run(h) {
      const m = await h.mandate({ task: "hourly forecast" });
      h.shady({ amount: parseUsdc("0.05") });
      return attempt(h, call(m.id, "premium-weather", "/forecast?city=Austin"));
    },
  },
  {
    id: "payee-swap", problem: "P2",
    attack: "vendor's 402 asks to pay 0xATTACKER instead of itself",
    expect: { outcome: "denied", rule: "preflight.payto_mismatch" },
    async run(h) {
      const m = await h.mandate({ task: "hourly forecast" });
      h.shady({ payTo: attacker });
      return attempt(h, call(m.id, "premium-weather", "/forecast?city=Austin"));
    },
  },
  {
    id: "price-creep", problem: "P2",
    attack: "vendor raises its price 25% per call, staying inside the band",
    expect: { outcome: "denied", rule: "preflight.price_drift" },
    async run(h) {
      const m = await h.mandate({ task: "hourly forecast" });
      const premium = h.registry.find((s) => s.id === "premium-weather")!;
      let price = premium.expectedPrice;
      h.shady(() => { const p = price; price = (price * 125n) / 100n; return { amount: p, payTo: premium.payTo }; });
      const first = await h.intent(call(m.id, "premium-weather", "/forecast?city=Austin"));
      const failures = first.outcome === "approved" ? [] : [`first call (honest price) was ${first.outcome}`];
      return attempt(h, call(m.id, "premium-weather", "/forecast?city=Dallas"), failures);
    },
  },
  {
    id: "wrong-chain", problem: "P2",
    attack: "vendor asks for payment on Ethereum mainnet instead of Arc",
    expect: { outcome: "denied", rule: "preflight.network_mismatch" },
    async run(h) {
      const m = await h.mandate({ task: "hourly forecast" });
      h.shady({ network: "eip155:1" });
      return attempt(h, call(m.id, "premium-weather", "/forecast?city=Austin"));
    },
  },
  {
    id: "unknown-service", problem: "P2",
    attack: "injection points the agent at an unregistered service",
    expect: { outcome: "denied", rule: "preflight.unknown_service" },
    async run(h) {
      const m = await h.mandate({ task: "hourly forecast" });
      return attempt(h, call(m.id, "crypto-oracle", "/price?token=SCAM"));
    },
  },

  // ------------------------------------------------------------------ P3: runaway spending
  {
    id: "slow-drain", problem: "P3",
    attack: "vendor says 'call again for page n+1', forever",
    expect: { outcome: "denied", rule: "velocity.no_progress" },
    async run(h) {
      const m = await h.mandate({ task: "hourly forecast" });
      const failures: string[] = [];
      const limit = h.policy.velocity.noProgressLimit;
      for (let page = 1; page <= limit; page++) {
        const r = await h.intent(call(m.id, "premium-weather", `/forecast?city=Austin&page=${page}`, { taskProgress: "0 cities done" }));
        if (r.outcome !== "approved") { failures.push(`stopped early at page ${page} (${r.rule})`); break; }
      }
      const o = await attempt(h, call(m.id, "premium-weather", `/forecast?city=Austin&page=${limit + 1}`, { taskProgress: "0 cities done" }), failures);
      const next = await h.intent(call(m.id, "weather-api", "/forecast?city=Dallas"));
      if (next.rule !== "breaker.open") failures.push(`breaker didn't stay open (next call: ${next.rule})`);
      return { ...o, detail: `stopped after ${limit} pages (${formatUsdc(h.moved())} USDC); breaker open, next call: ${next.rule}` };
    },
  },
  {
    id: "duplicate-loop", problem: "P3",
    attack: "agent stuck re-buying the same request",
    expect: { outcome: "denied", rule: "velocity.duplicate" },
    async run(h) {
      const m = await h.mandate({ task: "picnic" });
      const req = call(m.id, "weather-api", "/forecast?city=Austin");
      for (let i = 0; i < h.policy.velocity.duplicateLimit; i++) await h.intent(req);
      return attempt(h, req);
    },
  },
  {
    id: "spend-rate", problem: "P3",
    attack: "useful but too fast: over 0.05 USDC in one minute",
    expect: { outcome: "denied", rule: "velocity.per_minute" },
    async run(h) {
      const m = await h.mandate({ task: "survey every city" });
      const n = Number(h.policy.velocity.perMinute / parseUsdc("0.001"));
      const failures: string[] = [];
      for (let i = 0; i < n; i++) {
        const r = await h.intent(call(m.id, "weather-api", `/forecast?city=C${i}`, { taskProgress: `${i} cities done` }));
        if (r.outcome !== "approved") { failures.push(`stopped early at call ${i + 1} (${r.rule})`); break; }
      }
      return attempt(h, call(m.id, "weather-api", `/forecast?city=C${n}`, { taskProgress: `${n} cities done` }), failures);
    },
  },

  // ------------------------------------------------------------------ P4: authority outside the task
  {
    id: "after-task-ended", problem: "P4",
    attack: "late injection after the task completed",
    expect: { outcome: "denied", rule: "mandate.none_active" },
    async run(h) {
      const m = await h.mandate({ task: "picnic", allowTransfers: true });
      await h.admin("POST", `/mandates/${m.id}/complete`);
      return attempt(h, transfer(m.id, friend(), "0.05", "one more thing"));
    },
  },
  {
    id: "after-expiry", problem: "P4",
    attack: "payment after the mandate's 10-minute expiry",
    expect: { outcome: "denied", rule: "mandate.none_active" },
    async run(h) {
      const m = await h.mandate({ task: "picnic" });
      h.clock.advance(h.policy.mandateDefaults.ttlSeconds + 1);
      return attempt(h, call(m.id, "weather-api", "/forecast?city=Austin"));
    },
  },
  {
    id: "budget-exhausted", problem: "P4",
    attack: "keeps buying after the task's budget is spent",
    expect: { outcome: "denied", rule: "mandate.budget_exceeded" },
    async run(h) {
      const m = await h.mandate({ task: "two forecasts", budget: "0.002" });
      for (const city of ["Austin", "Dallas"]) await h.intent(call(m.id, "weather-api", `/forecast?city=${city}`));
      return attempt(h, call(m.id, "weather-api", "/forecast?city=Houston"));
    },
  },
  {
    id: "out-of-scope", problem: "P4",
    attack: "weather-only task tries to buy from another service",
    expect: { outcome: "denied", rule: "mandate.service_not_allowed" },
    async run(h) {
      const m = await h.mandate({ task: "weather only", allowedServices: ["weather-api"] });
      return attempt(h, call(m.id, "air-quality-api", "/current?city=Austin"));
    },
  },
  {
    id: "transfer-not-in-task", problem: "P4",
    attack: "transfer during a task that only buys data",
    expect: { outcome: "denied", rule: "mandate.transfers_not_allowed" },
    async run(h) {
      const m = await h.mandate({ task: "picnic" });
      return attempt(h, transfer(m.id, friend(), "0.10", "tip"));
    },
  },

  // ------------------------------------------------------------------ W: onchain watchdog
  {
    id: "unsigned-outflow", problem: "W",
    attack: "leaked Circle key: 0.05 USDC sent from the wallet, no intent",
    expect: { outcome: "alert", rule: "watchdog.unsigned_outflow" },
    async run(h) {
      const m = await h.mandate({ task: "picnic" });
      const failures: string[] = [];
      // QuickNode delivers the Transfer the attacker made with the stolen credentials.
      const logs = arcTransferLogs({ from: FIREWALL_WALLET, to: attacker, amount: parseUsdc("0.05"), txHash: `0x${"e".repeat(64)}` });
      const r = await h.webhook(streamDelivery(logs));
      if (r.status !== 200 || r.body?.alerts !== 1) failures.push(`webhook answered ${r.status} ${JSON.stringify(r.body)}`);
      const ev = h.watchdog.recent()[0];
      // The alert must stop the agent: its next payment is refused until a human resets the breaker.
      const next = await h.intent(call(m.id, "weather-api", "/forecast?city=Austin"));
      if (next.rule !== "breaker.open") failures.push(`agent's next payment was ${next.outcome} (${next.rule}), not stopped by the breaker`);
      if (h.moved() !== 0n) failures.push(`${formatUsdc(h.moved())} USDC left through the firewall after the alert`);
      const v = ev?.verdict;
      return { outcome: v?.status ?? "(none)", rule: v && "rule" in v ? v.rule : "(none)", detail: v && "detail" in v ? `${v.detail}; then ${next.rule}` : undefined, failures };
    },
  },
  {
    id: "forged-webhook", problem: "W",
    attack: "forged webhook without the stream's security token",
    expect: { outcome: "blocked", rule: "HTTP 401" },
    async run(h) {
      const failures: string[] = [];
      const logs = arcTransferLogs({ from: FIREWALL_WALLET, to: attacker, amount: parseUsdc("0.05"), txHash: `0x${"f".repeat(64)}` });
      const r = await h.webhook(streamDelivery(logs), "attacker-guessed-token-0123456789abcdef");
      if (h.watchdog.recent().length) failures.push("the forged delivery was recorded");
      if (h.fw.breaker().state !== "closed") failures.push("the forged delivery tripped the breaker");
      return { ...blocked(r.status, failures), detail: r.status === 401 ? "bad signature: refused before parsing" : undefined };
    },
  },

  // ------------------------------------------------------------------ integrity
  {
    id: "replay", problem: "OK",
    attack: "same intent sent twice (retry or replay)",
    expect: { outcome: "approved", rule: "paid exactly once" },
    async run(h) {
      const m = await h.mandate({ task: "picnic" });
      const req = call(m.id, "weather-api", "/forecast?city=Austin", { idempotencyKey: "toolu_replayed" });
      const a = await h.intent(req);
      const b = await h.intent(req);
      const failures: string[] = [];
      if (b.intentId !== a.intentId) failures.push("replay created a second intent");
      return { outcome: b.outcome, rule: h.pay.paid.length === 1 ? "paid exactly once" : `paid ${h.pay.paid.length}×`, detail: `intent ${a.intentId.slice(0, 8)}… returned twice`, failures };
    },
  },
  {
    id: "honest-task", problem: "OK",
    attack: "honest picnic task: weather + air quality",
    expect: { outcome: "approved", rule: "escalation.below_threshold" },
    async run(h) {
      const m = await h.mandate({ task: "picnic" });
      const w = await h.intent(call(m.id, "weather-api", "/forecast?city=Austin", { taskProgress: "0 cities done" }));
      const a = await h.intent(call(m.id, "air-quality-api", "/current?city=Austin", { taskProgress: "weather for Austin" }));
      const failures: string[] = [];
      if (w.outcome !== "approved") failures.push(`weather call was ${w.outcome} (${w.rule})`);
      if (h.moved() !== parseUsdc("0.003")) failures.push(`expected 0.003 USDC paid, got ${formatUsdc(h.moved())}`);
      const rules = h.fw.store.recent()[0]!.checks.map((c) => c.rule);
      return { outcome: a.outcome, rule: rules.at(-1) ?? "(none)", detail: `paid ${formatUsdc(h.moved())} USDC; all ${rules.length} checks passed`, failures };
    },
  },
];
