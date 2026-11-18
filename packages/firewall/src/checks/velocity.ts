// P3: death by a thousand nanopayments. Each call is tiny and passes every cap, so this check looks at
// the *pattern*. A deny here also trips the breaker (tripBreaker), which pauses all spending until a
// human resets it.
//
// Scope: x402 nanopayment streams only. Direct transfers are each capped, allowlisted and (above the
// threshold) human-approved; counting a $0.30 human-approved transfer against a $0.05/min rate would
// make every approved transfer trip the breaker.
//
// Every window starts no earlier than the last breaker reset (windowStart), so a human reset gives the
// agent a clean slate instead of re-tripping on the next call.
import type { Check, CheckResult } from "@asf/shared";
import { atMs, deny, pass, spentRows, sum, usd, windowStart } from "./util.ts";

const trip = (rule: string, detail: string, observed: string, limit: string): CheckResult =>
  deny(rule, detail, { tripBreaker: true, observed, limit });

export const velocityCheck: Check = {
  name: "velocity",
  run: (intent, ctx): CheckResult => {
    if (intent.kind !== "x402_call") return pass("velocity.not_applicable", "direct transfer: governed by caps and human approval");
    const v = ctx.policy.velocity;
    const amount = ctx.amount ?? 0n;
    const paid = spentRows(ctx).filter((r) => r.kind === "x402_call");
    const since = (seconds: number) => {
      const start = windowStart(ctx, seconds);
      return paid.filter((r) => atMs(r) > start);
    };

    // Same request over and over (a retry loop).
    const dupes = since(v.duplicateWindowSeconds).filter((r) => r.requestKey === ctx.requestKey).length;
    if (dupes >= v.duplicateLimit) {
      return trip("velocity.duplicate", `${dupes + 1} identical requests (${intent.service}${intent.path ?? ""}) within ${v.duplicateWindowSeconds}s; limit ${v.duplicateLimit}`, String(dupes + 1), String(v.duplicateLimit));
    }

    // Dollars per rolling minute across everything.
    const rate = sum(since(60)) + amount;
    if (rate > v.perMinute) {
      return trip("velocity.per_minute", `VELOCITY ${usd(rate)}/min > ${usd(v.perMinute)}/min, spending paused`, usd(rate), usd(v.perMinute));
    }

    // Calls to one service within one task.
    const task = since(24 * 3600).filter((r) => r.mandateId === intent.mandateId);
    const calls = task.filter((r) => r.service === intent.service).length;
    if (calls >= v.maxCallsPerServicePerTask) {
      return trip("velocity.calls_per_service", `${calls + 1} paid calls to ${intent.service} in this task; limit ${v.maxCallsPerServicePerTask}`, String(calls + 1), String(v.maxCallsPerServicePerTask));
    }

    // Paying without the task moving forward: the most recent paid calls in this task all reported
    // the same taskProgress as this one (an agent that reports nothing counts as making no progress).
    const progress = intent.taskProgress ?? "";
    let stuck = 0;
    for (let i = task.length - 1; i >= 0 && (task[i]!.taskProgress ?? "") === progress; i--) stuck++;
    if (stuck >= v.noProgressLimit) {
      return trip("velocity.no_progress", `${stuck + 1} paid calls with no task progress (still "${progress || "none reported"}"); limit ${v.noProgressLimit}`, String(stuck + 1), String(v.noProgressLimit));
    }

    return pass("velocity.ok", `${usd(rate)}/min of ${usd(v.perMinute)}/min; ${dupes + 1} identical in ${v.duplicateWindowSeconds}s; ${stuck + 1} without progress`);
  },
};
