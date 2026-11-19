// P1: hard caps from config/policy.json: per-call max, per-transfer cap, recipient allowlist, daily budget.
import { short, usd, type Check, type CheckResult } from "@asf/shared";
import { deny, pass, sameAddr, spentRows, sum } from "./util.ts";

export const policyCheck: Check = {
  name: "policy",
  run: (intent, ctx): CheckResult => {
    const p = ctx.policy;
    const amount = ctx.amount ?? 0n;

    if (intent.kind === "transfer") {
      // Report every violation in the detail (the demo shows both), but decide on the first.
      const problems: { rule: string; detail: string }[] = [];
      if (!p.recipientAllowlist.some((a) => sameAddr(a, intent.recipient))) {
        problems.push({ rule: "policy.recipient_not_allowed", detail: `recipient ${short(intent.recipient)} is not on the allowlist` });
      }
      if (amount > p.perTransferCap) {
        problems.push({ rule: "policy.per_tx_cap", detail: `${usd(amount)} exceeds the ${usd(p.perTransferCap)} per-transfer cap` });
      }
      if (problems.length) return deny(problems[0]!.rule, problems.map((x) => x.detail).join("; "));
    } else if (amount > p.perCallMax) {
      return deny("policy.per_call_max", `${usd(amount)} exceeds the ${usd(p.perCallMax)} per-call max`, { observed: usd(amount), limit: usd(p.perCallMax) });
    }

    const today = sum(spentRows(ctx)); // history is the last 24h
    if (today + amount > p.dailyBudget) {
      return deny("policy.daily_budget", `${usd(amount)} would take 24h spend to ${usd(today + amount)}, over the ${usd(p.dailyBudget)} daily budget`, { observed: usd(today + amount), limit: usd(p.dailyBudget) });
    }
    return pass("policy.ok", `within caps; ${usd(today + amount)} of ${usd(p.dailyBudget)} daily budget`);
  },
};
