// Small helpers shared by the checks. Checks are pure: they read the intent and the context, nothing else.
import { SPENT_OUTCOMES, formatUsdc, type CheckContext, type CheckResult, type LedgerRow } from "@asf/shared";

export const pass = (rule: string, detail: string): CheckResult => ({ outcome: "pass", rule, detail });
export const deny = (rule: string, detail: string, extra: Partial<CheckResult> = {}): CheckResult => ({ outcome: "deny", rule, detail, ...extra });

export const usd = (units: bigint) => `$${formatUsdc(units)}`;
export const short = (a?: string) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a ?? "?"));
export const sameAddr = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export const isSpent = (r: LedgerRow) => SPENT_OUTCOMES.includes(r.outcome);
export const atMs = (r: LedgerRow) => Date.parse(r.at);

/** Rows that moved money, oldest first (ctx.history is already the last 24h, oldest first). */
export const spentRows = (ctx: CheckContext) => ctx.history.filter(isSpent);

export const sum = (rows: LedgerRow[]) => rows.reduce((s, r) => s + (r.amount ?? 0n), 0n);

/** Start of a velocity window: `seconds` ago, but never before the last breaker reset. Without the
 *  reset bound, a human reset would re-trip on the very next call, because the spend that tripped the
 *  breaker is still inside the window. */
export function windowStart(ctx: CheckContext, seconds: number): number {
  const start = ctx.now.getTime() - seconds * 1000;
  const reset = ctx.breaker.resetAt ? Date.parse(ctx.breaker.resetAt) : NaN;
  return Number.isFinite(reset) ? Math.max(start, reset) : start;
}
