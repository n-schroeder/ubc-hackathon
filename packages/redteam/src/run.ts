// Runs scenarios, each against its own fresh firewall, and renders the results table.
import { openHarness } from "./harness.ts";
import { PROBLEMS, type Observed, type Problem, type Scenario } from "./scenarios.ts";

export type Result = Scenario & { observed: Observed; pass: boolean; ms: number };

export async function runScenario(s: Scenario): Promise<Result> {
  const t0 = performance.now();
  const h = await openHarness({ policy: s.policy?.() });
  let observed: Observed;
  try {
    observed = await s.run(h);
  } catch (e) {
    observed = { outcome: "error", rule: "(threw)", detail: (e as Error).message, failures: [(e as Error).message] };
  } finally {
    await h.close();
  }
  const pass = observed.outcome === s.expect.outcome && observed.rule === s.expect.rule && observed.failures.length === 0;
  return { ...s, observed, pass, ms: performance.now() - t0 };
}

export async function runAll(scenarios: Scenario[]): Promise<Result[]> {
  const out: Result[] = [];
  for (const s of scenarios) out.push(await runScenario(s));
  return out;
}

// ------------------------------------------------------------------ rendering

const ansi = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
export type Style = { bold(s: string): string; dim(s: string): string; green(s: string): string; red(s: string): string; cyan(s: string): string };
export const COLOR: Style = { bold: ansi("1"), dim: ansi("2"), green: ansi("32"), red: ansi("31"), cyan: ansi("36") };
export const PLAIN: Style = { bold: (s) => s, dim: (s) => s, green: (s) => s, red: (s) => s, cyan: (s) => s };

const width = (s: string) => [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - width(s)));
const clip = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s);

export function render(results: Result[], st: Style = PLAIN, opts: { details?: boolean } = {}): string {
  const lines: string[] = [];
  const A = Math.min(64, Math.max(...results.map((r) => width(r.attack))));
  const R = Math.max(...results.map((r) => width(r.expect.rule)), 8);
  const groups = [...new Set(results.map((r) => r.problem))] as Problem[];

  lines.push(st.bold("Agent Spending Firewall · red-team suite"));
  lines.push(st.dim("Each attack runs against a fresh firewall over its HTTP API (real policy + registry, fake payments, no LLM)."));
  for (const p of groups) {
    lines.push("");
    lines.push(st.cyan(st.bold(`${p === "OK" ? "" : `${p} · `}${PROBLEMS[p]}`)));
    for (const r of results.filter((x) => x.problem === p)) {
      const mark = r.pass ? st.green("✔") : st.red("✘");
      const got = r.observed.rule === r.expect.rule ? st.green(r.observed.rule) : st.red(r.observed.rule);
      lines.push(`  ${mark} ${pad(clip(r.attack, A), A)}  ${st.dim("→")} ${got}`);
      if (!r.pass) {
        lines.push(st.red(`      expected ${r.expect.outcome} / ${r.expect.rule}, got ${r.observed.outcome} / ${r.observed.rule}`));
        for (const f of r.observed.failures) lines.push(st.red(`      ${f}`));
      }
      if (opts.details && r.observed.detail) lines.push(st.dim(`      ${clip(r.observed.detail, A + R)}`));
    }
  }
  const passed = results.filter((r) => r.pass).length;
  const attacks = results.filter((r) => r.problem !== "OK");
  const stopped = attacks.filter((r) => r.pass).length;
  const ms = results.reduce((s, r) => s + r.ms, 0);
  lines.push("");
  const summary = `${passed}/${results.length} scenarios pass · ${stopped}/${attacks.length} attacks stopped with the expected rule · ${Math.round(ms)} ms`;
  lines.push(passed === results.length ? st.green(st.bold(summary)) : st.red(st.bold(summary)));
  return lines.join("\n");
}
