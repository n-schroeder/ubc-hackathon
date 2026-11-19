// P1: anything over the human-approval threshold waits in the approval queue. When a human approves,
// the firewall re-runs every check with ctx.humanApproved set, and this one passes.
import { usd, type Check } from "@asf/shared";
import { pass } from "./util.ts";

export const escalationCheck: Check = {
  name: "escalation",
  run: (_intent, ctx) => {
    const amount = ctx.amount ?? 0n;
    const limit = ctx.policy.humanApprovalAbove;
    if (amount <= limit) return pass("escalation.below_threshold", `${usd(amount)} is at or under the ${usd(limit)} approval threshold`);
    if (ctx.humanApproved) return pass("escalation.human_approved", `${usd(amount)} approved by a human`);
    return { outcome: "escalate", rule: "escalation.over_threshold", detail: `${usd(amount)} is over the ${usd(limit)} human-approval threshold`, observed: usd(amount), limit: usd(limit) };
  },
};
