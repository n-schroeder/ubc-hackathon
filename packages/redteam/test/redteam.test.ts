// The red-team suite also runs under `npm test`: one test per scenario, so a regression names the attack.
import { describe, expect, it } from "vitest";
import { PLAIN, SCENARIOS, render, runScenario, type Result } from "../src/index.ts";

describe("red-team suite (M8)", () => {
  const results: Result[] = [];

  it.each(SCENARIOS.map((s) => [s.id, s] as const))("%s", async (_id, s) => {
    const r = await runScenario(s);
    results.push(r);
    expect(r.observed.failures).toEqual([]);
    expect({ outcome: r.observed.outcome, rule: r.observed.rule }).toEqual(s.expect);
  });

  it("covers every attack the spec lists (F28)", () => {
    const rules = new Set(SCENARIOS.map((s) => s.expect.rule));
    for (const rule of [
      "policy.recipient_not_allowed", "policy.per_tx_cap", "preflight.price_out_of_band", "preflight.payto_mismatch",
      "preflight.price_drift", "velocity.no_progress", "velocity.duplicate", "mandate.none_active", "paid exactly once",
    ]) expect(rules, rule).toContain(rule);
  });

  it("scenario ids are unique", () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });

  it("renders a summary line", () => {
    const out = render(results, PLAIN);
    expect(out).toContain(`${results.length}/${results.length} scenarios pass`);
  });
});
