// The README's safety-limits tables must match config/ (the track requires the README to document the
// safety limits; this keeps it honest). Fix a failure with `npm run docs:limits`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "@asf/shared";
import { renderLimits, withLimits } from "../lib/limits-table.ts";

describe("README safety limits", () => {
  it("match config/policy.json and config/registry.json", () => {
    const readme = readFileSync(resolve(REPO_ROOT, "README.md"), "utf8");
    expect(withLimits(readme)).toBe(readme);
  });

  it("show the enforced numbers", () => {
    const t = renderLimits();
    expect(t).toContain("| Per paid API call (x402) | $0.01 |");
    expect(t).toContain("`premium-weather` | $0.001 | +50% → max $0.0015 |");
  });
});
