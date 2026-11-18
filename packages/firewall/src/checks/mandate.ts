// P4: every payment needs active, task-scoped authority. Runs before the firewall contacts the vendor,
// so a payment with no authority never even produces a quote request.
import type { Check } from "@asf/shared";
import { deny, pass, usd } from "./util.ts";

export const mandateCheck: Check = {
  name: "mandate",
  run: (intent, ctx) => {
    const m = ctx.mandate;
    // Unknown, expired, completed and revoked all mean the same thing to the agent: zero authority.
    if (!m) return deny("mandate.none_active", `no mandate "${intent.mandateId}": zero spending authority`);
    if (m.status !== "active") return deny("mandate.none_active", `mandate ${m.id} is ${m.status}: zero spending authority`, { observed: m.status });

    if (intent.kind === "transfer" && !m.allowTransfers) {
      return deny("mandate.transfers_not_allowed", "this task's mandate does not allow direct transfers");
    }
    // An x402 service that isn't in the registry at all is pre-flight's call (preflight.unknown_service).
    if (intent.kind === "x402_call" && ctx.service && !m.allowedServices.includes(ctx.service.id)) {
      return deny("mandate.service_not_allowed", `${ctx.service.id} is not one of this task's services (${m.allowedServices.join(", ") || "none"})`);
    }
    const left = m.budget - m.spent;
    if (left <= 0n) return deny("mandate.budget_exceeded", `task budget ${usd(m.budget)} is used up`, { observed: usd(m.spent), limit: usd(m.budget) });
    return pass("mandate.active", `mandate active: ${usd(left)} of ${usd(m.budget)} left, expires ${m.expiresAt}`);
  },
};

/** After the quote: does this amount fit in what's left of the task budget? */
export const mandateBudgetCheck: Check = {
  name: "mandate_budget",
  run: (_intent, ctx) => {
    const m = ctx.mandate;
    if (!m) return deny("mandate.none_active", "no mandate: zero spending authority");
    const amount = ctx.amount ?? 0n;
    const left = m.budget - m.spent;
    if (amount > left) {
      return deny("mandate.budget_exceeded", `${usd(amount)} exceeds the ${usd(left)} left of this task's ${usd(m.budget)} budget`, { observed: usd(amount), limit: usd(left) });
    }
    return pass("mandate.budget_ok", `${usd(amount)} of ${usd(left)} left in the task budget`);
  },
};
