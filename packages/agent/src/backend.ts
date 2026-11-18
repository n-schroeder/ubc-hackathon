// What the agent's tools do with money. Two implementations:
//   FirewallBackend: every payment is an intent the firewall checks (the real product).
//   UnsafeBackend (unsafe.ts): signs directly with a throwaway key, for the "without firewall" demo shot only.
import type { IntentResponse } from "@asf/shared";
import type { FirewallClient } from "./firewall-client.ts";
import { ProgressTracker } from "./progress.ts";

/** Every tool returns a JSON-able object; the loop serializes it for the model. */
export type ToolOutput = Record<string, unknown>;

export interface PaymentBackend {
  readonly label: string;
  listServices(): Promise<ToolOutput>;
  callPaidApi(service: string, path: string, reason: string, key: string): Promise<ToolOutput>;
  sendPayment(recipient: string, amount: string, reason: string, key: string): Promise<ToolOutput>;
  checkPayment(intentId: string): Promise<ToolOutput>;
  getMandate(): Promise<ToolOutput>;
}

export type FirewallBackendOptions = {
  pollMs?: number;      // check_payment polling interval
  waitMs?: number;      // how long check_payment waits for a human before returning "still pending"
};

/** Tell the model plainly what happened. A denial is a normal result, not an error (SPEC §3.4). */
export function describe(r: IntentResponse): ToolOutput {
  const base = { outcome: r.outcome, intentId: r.intentId, amount: r.amount, rule: r.rule, detail: r.detail };
  switch (r.outcome) {
    case "approved":
    case "human_approved":
      return { ...base, paid: true, explorerUrl: r.explorerUrl, gatewayTransferId: r.gatewayTransferId, txHash: r.txHash };
    case "pending_human":
      return { ...base, paid: false, note: "Waiting for a human to approve. Call check_payment with this intentId to wait for the decision." };
    case "denied":
    case "human_denied":
      return { ...base, paid: false, note: "The spending firewall blocked this payment. Nothing was paid." };
    default:
      return { ...base, paid: false, note: "The payment failed. Nothing was paid." };
  }
}

export class FirewallBackend implements PaymentBackend {
  readonly label = "firewall";
  readonly progress = new ProgressTracker();
  private pollMs: number;
  private waitMs: number;

  constructor(private fw: FirewallClient, private mandateId: string, opts: FirewallBackendOptions = {}) {
    this.pollMs = opts.pollMs ?? 2000;
    this.waitMs = opts.waitMs ?? 45_000;
  }

  async listServices(): Promise<ToolOutput> {
    return { services: await this.fw.listServices() };
  }

  async callPaidApi(service: string, path: string, reason: string, key: string): Promise<ToolOutput> {
    const r = await this.fw.submit({
      kind: "x402_call", mandateId: this.mandateId, service, path, reason,
      idempotencyKey: key, taskProgress: this.progress.summary(),
    });
    const out = describe(r);
    if (r.outcome === "approved" || r.outcome === "human_approved") {
      this.progress.record(service, path);
      out.data = r.data;
    }
    return out;
  }

  async sendPayment(recipient: string, amount: string, reason: string, key: string): Promise<ToolOutput> {
    const r = await this.fw.submit({
      kind: "transfer", mandateId: this.mandateId, recipient, amount, reason,
      idempotencyKey: key, taskProgress: this.progress.summary(),
    });
    return describe(r);
  }

  async checkPayment(intentId: string): Promise<ToolOutput> {
    const deadline = Date.now() + this.waitMs;
    for (;;) {
      const r = await this.fw.getIntent(intentId);
      if (r.outcome !== "pending_human" || Date.now() >= deadline) return describe(r);
      await new Promise((ok) => setTimeout(ok, this.pollMs));
    }
  }

  async getMandate(): Promise<ToolOutput> {
    const m = await this.fw.getMandate(this.mandateId);
    return {
      task: m.task, status: m.status, budget: m.budget, spent: m.spent, remaining: m.remaining,
      expiresAt: m.expiresAt, allowedServices: m.allowedServices, allowTransfers: m.allowTransfers,
    };
  }
}
