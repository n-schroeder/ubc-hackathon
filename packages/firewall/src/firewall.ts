// The firewall: turns an agent's request into a logged decision, and pays only when every check passes.
// See docs/SPEC.md §3.4 for the decision loop this implements.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { getAddress, isAddress } from "viem";
import {
  SPENT_OUTCOMES, formatUsdc, parseUsdc, txUrl,
  type Address, type BreakerState, type Check, type CheckContext, type CheckResult, type IntentRequest,
  type IntentResponse, type LedgerRow, type Mandate, type PaymentIntent, type Policy, type RegistryEntry,
} from "@asf/shared";
import { joinResults, runChecks, type PipelineResult } from "./pipeline.ts";
import { Store } from "./store.ts";
import { payQuote, requestQuote, type PaidResult, type PaymentOption, type PaymentRequired, type QuoteResult } from "./x402.ts";
import type { Signer } from "./signer.ts";

/** Everything that touches the network or money. Swapped for a fake in unit tests. */
export interface Payments {
  requestQuote(url: string): Promise<QuoteResult>;
  payQuote(url: string, required: PaymentRequired, option: PaymentOption): Promise<PaidResult>;
  transfer(to: Address, amount: bigint, idempotencyKey: string): Promise<{ txHash: string }>;
}

export class LivePayments implements Payments {
  constructor(private signer: Signer) {}
  requestQuote = (url: string) => requestQuote(url);
  payQuote = (url: string, required: PaymentRequired, option: PaymentOption) => payQuote(url, required, option, this.signer);
  transfer = (to: Address, amount: bigint, key: string) => this.signer.transfer(to, amount, key);
}

/** Stage 1 runs before we contact the vendor (breaker, mandate); stage 2 runs on the quote. */
export type Pipeline = { beforeQuote: Check[]; afterQuote: Check[] };

export type FirewallDeps = {
  store: Store;
  policy: Policy;
  registry: RegistryEntry[];
  pipeline: Pipeline;
  payments: Payments;
  now?: () => Date;
};

export type FirewallEvents = {
  decision: [LedgerRow];
  breaker: [BreakerState];
  mandate: [Mandate];
  /** About to sign a USDC transfer (the onchain watchdog expects to see it). */
  signing: [{ intentId: string; to: Address; amount: bigint }];
};

const DAY_MS = 24 * 3600 * 1000;

export class Firewall extends EventEmitter<FirewallEvents> {
  readonly store: Store;
  readonly policy: Policy;
  readonly registry: RegistryEntry[];
  private pipeline: Pipeline;
  private payments: Payments;
  private now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(d: FirewallDeps) {
    super();
    this.store = d.store;
    this.policy = d.policy;
    this.registry = d.registry;
    this.pipeline = d.pipeline;
    this.payments = d.payments;
    this.now = d.now ?? (() => new Date());
  }

  /** Decisions run one at a time, so two concurrent intents can't both spend the same budget. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ------------------------------------------------------------------ intents

  submit(req: IntentRequest): Promise<IntentResponse> {
    return this.serial(async () => {
      const key = typeof req.idempotencyKey === "string" && req.idempotencyKey ? req.idempotencyKey : randomUUID();
      const seen = this.store.byIdempotencyKey(key);
      if (seen) return { ...toResponse(seen), detail: `duplicate idempotency key; original decision: ${seen.detail ?? seen.outcome}` };

      const parsed = parseIntent(req, key, this.now());
      if ("error" in parsed) {
        const row = this.record(parsed.intent, base(parsed.intent), {
          outcome: "denied", rule: "intent.invalid", detail: parsed.error, checks: [],
        });
        return toResponse(row);
      }
      const { row, data } = await this.decide(parsed.intent, false);
      const saved = this.record(parsed.intent, row);
      return { ...toResponse(saved), data };
    });
  }

  getIntent(id: string): IntentResponse | undefined {
    const p = this.store.byIntentId(id);
    return p && toResponse(p.row);
  }

  // ------------------------------------------------------------------ approvals (P1)

  pendingApprovals() {
    return this.store.pending().map((p) => p.row);
  }

  resolveApproval(intentId: string, approve: boolean, by = "human"): Promise<IntentResponse | undefined> {
    return this.serial(async () => {
      const p = this.store.byIntentId(intentId);
      if (!p || p.row.outcome !== "pending_human") return undefined;
      if (!approve) {
        const row: LedgerRow = { ...p.row, outcome: "human_denied", rule: "escalation.human_denied", detail: `denied by ${by}`, decidedBy: by, at: this.now().toISOString() };
        this.store.update(row);
        this.emitDecision(row);
        return toResponse(row);
      }
      // Re-run every check against fresh state (the quote, the breaker, budgets may have changed).
      const { row: fresh, data } = await this.decide(p.intent, true);
      const row: LedgerRow = {
        ...fresh, seq: p.row.seq, decidedBy: by,
        outcome: fresh.outcome === "approved" ? "human_approved" : fresh.outcome,
      };
      this.store.update(row);
      this.emitDecision(row);
      return { ...toResponse(row), data };
    });
  }

  // ------------------------------------------------------------------ settlement (F6/F23)

  /** Gateway batched a paid nanopayment onchain: attach its tx hash and explorer link to the row.
   *  Besides approvals this is the only in-place ledger update, and it touches only those two fields. */
  recordSettlement(intentId: string, txHash: string): LedgerRow | undefined {
    const p = this.store.byIntentId(intentId);
    if (!p || p.row.txHash || !p.row.gatewayTransferId || !SPENT_OUTCOMES.includes(p.row.outcome)) return undefined;
    const row: LedgerRow = { ...p.row, txHash, explorerUrl: txUrl(txHash) };
    this.store.update(row);
    this.emit("decision", row);
    return row;
  }

  // ------------------------------------------------------------------ breaker (P3)

  breaker(): BreakerState {
    return this.store.getBreaker();
  }

  /** Open the breaker from outside the pipeline (the onchain watchdog). Spending stops until a human resets it. */
  tripBreaker(rule: string, detail: string): BreakerState {
    const b: BreakerState = { state: "open", trippedAt: this.now().toISOString(), rule, detail, resetAt: this.store.getBreaker().resetAt };
    this.store.setBreaker(b);
    this.emit("breaker", b);
    return b;
  }

  clock(): Date {
    return this.now();
  }

  resetBreaker(): BreakerState {
    // resetAt bounds the velocity windows, so spend from before the reset can't re-trip it at once.
    const b: BreakerState = { state: "closed", resetAt: this.now().toISOString() };
    this.store.setBreaker(b);
    this.emit("breaker", b);
    return b;
  }

  // ------------------------------------------------------------------ mandates (P4)

  createMandate(input: { task: string; budget?: string; ttlSeconds?: number; allowedServices?: string[]; allowTransfers?: boolean }): Mandate {
    if (!input.task || typeof input.task !== "string") throw new Error("task is required");
    const budget = input.budget ? parseUsdc(input.budget) : this.policy.mandateDefaults.budget;
    const ttl = input.ttlSeconds ?? this.policy.mandateDefaults.ttlSeconds;
    if (!(ttl > 0)) throw new Error("ttlSeconds must be positive");
    const services = input.allowedServices ?? this.registry.map((r) => r.id);
    const now = this.now();
    const m = this.store.createMandate(
      { task: input.task, budget, allowedServices: services, allowTransfers: input.allowTransfers ?? false, expiresAt: new Date(now.getTime() + ttl * 1000).toISOString() },
      now,
    );
    this.emit("mandate", m);
    return m;
  }

  setMandateStatus(id: string, status: "completed" | "revoked"): Mandate | undefined {
    const m = this.store.setMandateStatus(id, status, this.now());
    if (m) this.emit("mandate", m);
    return m;
  }

  // ------------------------------------------------------------------ the decision loop

  private async decide(intent: PaymentIntent, humanApproved: boolean): Promise<{ row: Omit<LedgerRow, "seq">; data?: unknown }> {
    const now = this.now();
    const service = intent.service ? this.registry.find((r) => r.id === intent.service) : undefined;
    const ctx: CheckContext = {
      now,
      policy: this.policy,
      breaker: this.store.getBreaker(),
      mandate: this.store.getMandate(intent.mandateId, now),
      service,
      history: this.store.since(new Date(now.getTime() - DAY_MS)).filter((r) => r.intentId !== intent.id),
      requestKey: requestKey(intent),
      humanApproved,
    };
    if (intent.kind === "transfer") ctx.amount = intent.amount;
    const row = base(intent);
    row.requestKey = ctx.requestKey;

    // Stage 1: breaker, mandate. Nothing leaves the firewall if these deny.
    const s1 = runChecks(this.pipeline.beforeQuote, intent, ctx);
    if (s1.outcome === "deny") return { row: this.finish(row, s1) };

    // Fetch the vendor's quote (x402 only). Failure to get a clean quote is a denial.
    let quoted: Extract<QuoteResult, { kind: "quote" }> | undefined;
    let url: string | undefined;
    if (intent.kind === "x402_call" && service) {
      url = serviceUrl(service, intent.path ?? "/");
      if (!url) return { row: this.finish(row, deny(s1, "intent.bad_path", `path must be a path on ${service.id}, got "${intent.path}"`)) };
      let q: QuoteResult;
      try {
        q = await this.payments.requestQuote(url);
      } catch (e) {
        return { row: this.finish(row, deny(s1, "preflight.quote_unavailable", `could not read a valid 402 quote: ${(e as Error).message}`)) };
      }
      if (q.kind === "free") {
        return { row: { ...this.finish(row, s1), amount: 0n, outcome: "approved", detail: "service answered without asking for payment" }, data: q.data };
      }
      quoted = q;
      ctx.quote = q.quote;
      ctx.amount = q.quote.amount;
    }
    row.amount = ctx.amount;

    // Stage 2: preflight, policy, velocity, escalation.
    const all = joinResults(s1, runChecks(this.pipeline.afterQuote, intent, ctx));
    const trip = all.results.find((r) => r.tripBreaker && r.outcome === "deny");
    if (trip) {
      const b: BreakerState = { state: "open", trippedAt: now.toISOString(), rule: trip.rule, detail: trip.detail, resetAt: ctx.breaker.resetAt };
      this.store.setBreaker(b);
      this.emit("breaker", b);
    }
    if (all.outcome === "deny") return { row: this.finish(row, all) };
    if (all.outcome === "escalate" && !humanApproved) return { row: this.finish(row, all, "pending_human") };

    // Every check passed: sign and pay.
    try {
      if (intent.kind === "transfer") {
        this.emit("signing", { intentId: intent.id, to: intent.recipient!, amount: intent.amount! });
        const { txHash } = await this.payments.transfer(intent.recipient!, intent.amount!, intent.id);
        return { row: { ...this.finish(row, all, "approved"), txHash, explorerUrl: txUrl(txHash) } };
      }
      const paid = await this.payments.payQuote(url!, quoted!.required, quoted!.option);
      // Once a signed authorization has left the firewall, count it as spent even if the vendor errors.
      const ok = paid.status >= 200 && paid.status < 300;
      return {
        row: {
          ...this.finish(row, all, "approved"),
          gatewayTransferId: paid.gatewayTransferId,
          vendorStatus: paid.status,
          detail: ok ? `paid ${formatUsdc(ctx.amount!)} USDC` : `paid, but vendor returned HTTP ${paid.status}`,
        },
        data: paid.data,
      };
    } catch (e) {
      return { row: { ...this.finish(row, all, "failed"), rule: "payment.failed", detail: `payment failed: ${(e as Error).message}` } };
    }
  }

  private finish(row: Omit<LedgerRow, "seq">, p: PipelineResult, ok?: "approved" | "pending_human" | "failed"): Omit<LedgerRow, "seq"> {
    const outcome = p.outcome === "deny" ? "denied" : ok ?? "approved";
    return { ...row, at: this.now().toISOString(), outcome, checks: p.results, rule: p.deciding?.rule, detail: p.deciding?.detail };
  }

  private record(intent: PaymentIntent, row: Omit<LedgerRow, "seq">, patch: Partial<LedgerRow> = {}): LedgerRow {
    const saved = this.store.append(intent, { ...row, ...patch });
    this.emitDecision(saved);
    return saved;
  }

  /** Every decision goes out on the event stream; spending ones also push the mandate's new `spent`. */
  private emitDecision(row: LedgerRow) {
    this.emit("decision", row);
    if (SPENT_OUTCOMES.includes(row.outcome)) {
      const m = this.store.getMandate(row.mandateId, this.now());
      if (m) this.emit("mandate", m);
    }
  }
}

// ------------------------------------------------------------------ helpers

function deny(prev: PipelineResult, rule: string, detail: string): PipelineResult {
  const r: CheckResult = { outcome: "deny", rule, detail };
  return { outcome: "deny", results: [...prev.results, r], deciding: r };
}

function base(intent: PaymentIntent): Omit<LedgerRow, "seq"> {
  return {
    intentId: intent.id, idempotencyKey: intent.idempotencyKey, at: intent.createdAt, kind: intent.kind,
    mandateId: intent.mandateId, service: intent.service, path: intent.path, recipient: intent.recipient,
    amount: intent.amount, reason: intent.reason, taskProgress: intent.taskProgress, outcome: "denied", checks: [],
    decidedBy: "firewall",
  };
}

export function requestKey(i: PaymentIntent): string {
  return i.kind === "x402_call" ? `x402|${i.service}|${i.path ?? "/"}` : `transfer|${i.recipient}|${i.amount}`;
}

/** Resolve a path against the service's base URL; refuse anything that escapes its origin. */
export function serviceUrl(s: RegistryEntry, path: string): string | undefined {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return undefined;
  try {
    const base = new URL(s.baseUrl);
    const prefix = base.pathname.replace(/\/$/, "");
    const u = new URL(prefix + path, base);
    const inside = u.pathname === prefix || u.pathname.startsWith(prefix + "/");
    return u.origin === base.origin && inside ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function parseIntent(req: IntentRequest, key: string, now: Date): { intent: PaymentIntent } | { intent: PaymentIntent; error: string } {
  const intent: PaymentIntent = {
    id: randomUUID(),
    idempotencyKey: key,
    kind: req?.kind === "transfer" ? "transfer" : "x402_call",
    mandateId: typeof req?.mandateId === "string" ? req.mandateId : "",
    reason: typeof req?.reason === "string" ? req.reason.slice(0, 2000) : "",
    taskProgress: typeof req?.taskProgress === "string" ? req.taskProgress.slice(0, 500) : undefined,
    createdAt: now.toISOString(),
  };
  const fail = (error: string) => ({ intent, error });
  if (req?.kind !== "x402_call" && req?.kind !== "transfer") return fail(`kind must be "x402_call" or "transfer"`);
  if (!intent.mandateId) return fail("mandateId is required");
  if (!intent.reason) return fail("reason is required");
  if (req.kind === "x402_call") {
    if (typeof req.service !== "string" || !req.service) return fail("service is required for x402_call");
    intent.service = req.service;
    intent.path = typeof req.path === "string" ? req.path : "/";
  } else {
    if (typeof req.recipient !== "string" || !isAddress(req.recipient)) return fail("recipient must be a 0x address");
    intent.recipient = getAddress(req.recipient) as Address;
    try {
      intent.amount = parseUsdc(String(req.amount ?? ""));
    } catch {
      return fail(`amount must be a decimal USDC string, got "${req.amount}"`);
    }
    if (intent.amount <= 0n) return fail("amount must be positive");
  }
  return { intent };
}

export function toResponse(r: LedgerRow): IntentResponse {
  return {
    intentId: r.intentId, outcome: r.outcome, rule: r.rule, detail: r.detail,
    amount: r.amount === undefined ? undefined : formatUsdc(r.amount),
    txHash: r.txHash, explorerUrl: r.explorerUrl, gatewayTransferId: r.gatewayTransferId,
  };
}
