// The check pipeline runner. Checks are pure functions; the order is the array order.
// First deny wins and stops the pipeline. An escalate is remembered and the rest still run.
// A check that throws is a deny (fail closed).
import type { Check, CheckContext, CheckResult, PaymentIntent } from "@asf/shared";

export type PipelineResult = {
  outcome: "pass" | "deny" | "escalate";
  results: CheckResult[];
  deciding?: CheckResult; // the first deny, else the first escalate
};

export function runChecks(checks: Check[], intent: PaymentIntent, ctx: CheckContext): PipelineResult {
  const results: CheckResult[] = [];
  let escalation: CheckResult | undefined;
  for (const check of checks) {
    let out: CheckResult[];
    try {
      const r = check.run(intent, ctx);
      out = Array.isArray(r) ? r : [r];
    } catch (e) {
      out = [{ outcome: "deny", rule: `${check.name}.error`, detail: `check threw: ${(e as Error).message}` }];
    }
    for (const r of out) {
      results.push(r);
      if (r.outcome === "deny") return { outcome: "deny", results, deciding: r };
      if (r.outcome === "escalate" && !escalation) escalation = r;
    }
  }
  return escalation ? { outcome: "escalate", results, deciding: escalation } : { outcome: "pass", results };
}

/** Joins two stage results (stage 2 only runs when stage 1 did not deny). */
export function joinResults(a: PipelineResult, b: PipelineResult): PipelineResult {
  const results = [...a.results, ...b.results];
  if (b.outcome === "deny") return { outcome: "deny", results, deciding: b.deciding };
  const esc = a.outcome === "escalate" ? a.deciding : b.outcome === "escalate" ? b.deciding : undefined;
  return esc ? { outcome: "escalate", results, deciding: esc } : { outcome: "pass", results };
}
