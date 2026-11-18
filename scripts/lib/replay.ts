// Pure pieces of the static replay build (scripts/build-replay.ts): turn a recorded firewall ledger and its
// mandates into the timeline the replay page plays back, and check the built site for secrets.
import { formatUsdc, parseUsdc } from "@asf/shared";

type Json = Record<string, any>;
export type Pass = "dry" | "live";

export type SceneNote = {
  scene: number; step: string; short: string; mode: string;
  match: string; rule?: string;
  title: string; look: string; baseline?: string; liveNote?: string;
};
export type Notes = {
  repoUrl: string; videoUrl?: string;
  baselineTx?: Partial<Record<Pass, string>>;
  passes: Record<Pass, string>;
  scenes: SceneNote[];
};

export type Take = {
  id: string; pass: Pass; passLabel: string; scene?: number; step?: string; short: string; retake: number;
  title: string; look: string; note?: string; baseline?: string; baselineUrl?: string;
  mandateId: string; start: number; createdAt: number; closedAt?: number; mode: string;
  summary: { approved: number; denied: number; spent: string; rules: string[] };
};
export type BreakerEvent = { at: number; state: Json };
export type ReplayData = {
  meta: {
    startAt: number; endAt: number; explorerBase: string; repoUrl: string; videoUrl?: string;
    rows: number; approved: number; denied: number; spent: string; explorerLinks: number;
  };
  policy: Json;
  rows: Json[];
  mandates: Json[];
  breaker: BreakerEvent[];
  vendor: { at: number; mode: string }[];
  takes: Take[];
  /** Quiet stretches of the recording the player jumps over: [from, to] in ms. */
  skips: [number, number][];
};

const ROW_KEYS = [
  "intentId", "seq", "at", "kind", "mandateId", "service", "path", "recipient", "amount", "reason", "taskProgress",
  "outcome", "rule", "detail", "checks", "decidedBy", "requestKey", "vendorStatus", "txHash", "explorerUrl", "gatewayTransferId",
] as const;
const CHECK_KEYS = ["outcome", "rule", "detail", "observed", "limit", "tripBreaker"] as const;
const MANDATE_KEYS = ["id", "task", "budget", "spent", "allowedServices", "allowTransfers", "createdAt", "expiresAt", "status"] as const;
const SPENT = new Set(["approved", "human_approved"]);
const DENIED = new Set(["denied", "human_denied"]);
const TX = /^0x[0-9a-fA-F]{64}$/;

const pick = (o: Json, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null).map((k) => [k, o[k]]));
const ms = (iso: unknown) => {
  const t = Date.parse(String(iso));
  if (Number.isNaN(t)) throw new Error(`bad timestamp: ${String(iso)}`);
  return t;
};
const sum = (rows: Json[]) => formatUsdc(rows.filter((r) => SPENT.has(r.outcome) && r.amount).reduce((a, r) => a + parseUsdc(String(r.amount)), 0n));

/** Keep only the fields the dashboard renders; explorer links must point at the Arc explorer. */
export function sanitizeRow(r: Json, explorerBase: string): Json {
  const out = pick(r, ROW_KEYS);
  if (Array.isArray(r.checks)) out.checks = r.checks.map((c: Json) => pick(c, CHECK_KEYS));
  const tx = typeof r.txHash === "string" && TX.test(r.txHash) ? r.txHash : undefined;
  if (!tx) delete out.txHash;
  if (typeof out.explorerUrl !== "string" || !out.explorerUrl.startsWith(`${explorerBase}/tx/`)) {
    delete out.explorerUrl;
    if (tx) out.explorerUrl = `${explorerBase}/tx/${tx}`;
  }
  return out;
}

function passOf(rows: Json[]): Pass | undefined {
  const keys = rows.map((r) => String(r.idempotencyKey ?? ""));
  if (keys.some((k) => k.startsWith("toolu_dry"))) return "dry";
  if (keys.some((k) => k.startsWith("toolu_"))) return "live";
  return undefined;
}

export function deriveReplay(ledger: Json[], mandatesIn: Json[], policy: Json, notes: Notes, explorerBase: string): ReplayData {
  const raw = [...ledger].sort((a, b) => a.seq - b.seq);
  const rows = raw.map((r) => sanitizeRow(r, explorerBase));
  const mandates = [...mandatesIn].sort((a, b) => ms(a.createdAt) - ms(b.createdAt)).map((m) => pick(m, MANDATE_KEYS));
  const byMandate = new Map<string, Json[]>();
  for (const r of raw) byMandate.set(r.mandateId, [...(byMandate.get(r.mandateId) ?? []), r]);

  // ---------------------------------------------------------------- one take per mandate
  const takes: Take[] = [];
  const seen = new Map<string, number>();
  let pass: Pass = "dry";
  let prevClosed = -Infinity;
  mandates.forEach((m, i) => {
    const own = (byMandate.get(m.id) ?? []).sort((a, b) => ms(a.at) - ms(b.at));
    pass = passOf(own) ?? pass;
    const createdAt = ms(m.createdAt);
    const next = mandates[i + 1] ? ms(mandates[i + 1]!.createdAt) : undefined;

    // When the scene runner closed the mandate isn't recorded: estimate it from the rows around it.
    let closedAt: number | undefined;
    if (m.status !== "active") {
      const late = own.find((r) => r.rule === "mandate.none_active");
      const before = own.filter((r) => !late || ms(r.at) < ms(late.at));
      closedAt = Math.max(createdAt + 2000, (before.length ? ms(before.at(-1)!.at) : createdAt) + 1500);
      if (late) closedAt = Math.min(closedAt, ms(late.at) - 5);
      if (next !== undefined) closedAt = Math.min(closedAt, next - 1500);
      closedAt = Math.max(closedAt, createdAt + 1);
      m.closedAt = new Date(closedAt).toISOString();
    }

    const candidates = notes.scenes.filter((s) => String(m.task ?? "").startsWith(s.match));
    const rules = own.map((r) => String(r.rule ?? ""));
    const note = candidates.find((s) => s.rule && rules.some((r) => r.startsWith(s.rule!)))
      ?? candidates.find((s) => !seen.has(`${pass}/${s.scene}/${s.step}`))
      ?? candidates[0];
    const key = `${pass}/${note?.scene ?? "?"}/${note?.step ?? m.id}`;
    const retake = seen.get(key) ?? 0;
    seen.set(key, retake + 1);
    const short = (note?.short ?? "?") + "′".repeat(retake);
    const denied = own.filter((r) => DENIED.has(r.outcome));
    const baselineTx = note?.baseline ? notes.baselineTx?.[pass] : undefined;

    takes.push({
      id: `${pass}-${note?.short ?? m.id.slice(0, 8)}${retake ? `-r${retake}` : ""}`,
      pass, passLabel: notes.passes[pass], scene: note?.scene, step: note?.step, short, retake,
      title: note?.title ?? String(m.task ?? "Task"), look: note?.look ?? "",
      note: pass === "live" && note?.liveNote && !denied.some((r) => r.rule) ? note.liveNote : undefined,
      baseline: baselineTx && TX.test(baselineTx) ? note?.baseline : undefined,
      baselineUrl: baselineTx && TX.test(baselineTx) ? `${explorerBase}/tx/${baselineTx}` : undefined,
      mandateId: m.id, start: Math.max(createdAt - 1500, Math.min(createdAt, prevClosed + 1)), createdAt, closedAt,
      mode: note?.mode ?? "honest",
      summary: {
        approved: own.filter((r) => SPENT.has(r.outcome)).length,
        denied: denied.length,
        spent: sum(own),
        rules: [...new Set(denied.map((r) => String(r.rule ?? "")).filter(Boolean))],
      },
    });
    prevClosed = closedAt ?? createdAt;
  });

  // ---------------------------------------------------------------- breaker: trips from the ledger, resets by the next scene
  // (scripts/demo-scene.ts resets an open breaker when the next scene starts.)
  const breaker: BreakerEvent[] = [];
  for (const r of raw) {
    if (!DENIED.has(r.outcome) || !Array.isArray(r.checks) || !r.checks.some((c: Json) => c.tripBreaker)) continue;
    const at = ms(r.at);
    if (breaker.at(-1)?.state.state === "open") continue;
    breaker.push({ at, state: { state: "open", trippedAt: r.at, rule: r.rule, detail: r.detail } });
    const nextTake = takes.find((t) => t.createdAt > at);
    if (nextTake) {
      const resetAt = Math.max(at + 1, nextTake.createdAt - 1000);
      breaker.push({ at: resetAt, state: { state: "closed", resetAt: new Date(resetAt).toISOString() } });
    }
  }

  // ---------------------------------------------------------------- shady vendor mode per take
  const vendor: { at: number; mode: string }[] = [];
  for (const t of takes) {
    if (t.mode === "honest") continue;
    vendor.push({ at: t.createdAt - 1200, mode: t.mode });
    vendor.push({ at: (t.closedAt ?? t.createdAt) + 300, mode: "honest" });
  }

  // ---------------------------------------------------------------- timeline bounds and the quiet stretches to skip
  const times = [
    ...rows.map((r) => ms(r.at)), ...takes.flatMap((t) => [t.start, t.createdAt, t.closedAt ?? t.createdAt]),
    ...breaker.map((b) => b.at), ...vendor.map((v) => v.at),
  ].sort((a, b) => a - b);
  if (!times.length) throw new Error("the recording is empty: no mandates and no ledger rows");
  const startAt = Math.min(times[0]!, ...takes.map((t) => t.start));
  const endAt = times.at(-1)! + 2000;
  const skips: [number, number][] = [];
  for (let i = 1; i < times.length; i++) {
    const a = times[i - 1]!, b = times[i]!;
    if (b - a > 6000) skips.push([a + 2000, b - 1500]);
  }

  return {
    meta: {
      startAt, endAt, explorerBase, repoUrl: notes.repoUrl, videoUrl: notes.videoUrl || undefined,
      rows: rows.length,
      approved: rows.filter((r) => SPENT.has(r.outcome)).length,
      denied: rows.filter((r) => DENIED.has(r.outcome)).length,
      spent: sum(rows),
      explorerLinks: rows.filter((r) => r.explorerUrl).length,
    },
    policy, rows, mandates, breaker, vendor, takes, skips,
  };
}

// ------------------------------------------------------------------ secret scan

/** Env names whose values are public by design (addresses, ports, modes, paths, URLs). */
const PUBLIC_ENV = /(_ADDRESS|_PORT|_MODE|_DB|_URL)$/;

/** The .env values that must never appear in the published site, plus their parts (TEST_API_KEY:<id>:<secret>). */
export function secretNeedles(env: Record<string, string>): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const [name, raw] of Object.entries(env)) {
    const value = raw.trim();
    if (PUBLIC_ENV.test(name) || value.length < 8) continue;
    out.push({ name, value });
    for (const part of value.split(":")) if (part !== value && part.length >= 12) out.push({ name: `${name} (part)`, value: part });
    if (/^0x[0-9a-f]+$/i.test(value)) out.push({ name: `${name} (no 0x)`, value: value.slice(2) });
  }
  return out;
}

const PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/, "an Anthropic API key"],
  [/(TEST|LIVE)_API_KEY:[A-Za-z0-9]/, "a Circle API key"],
  [/[#?&]token=[A-Za-z0-9_-]{8,}/, "an admin token in a URL"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a PEM private key"],
];

/** What in `text` looks like a secret: the env names (never the values) and the pattern labels it matched. */
export function findLeaks(text: string, needles: { name: string; value: string }[]): string[] {
  const lower = text.toLowerCase();
  const hits = needles.filter((n) => lower.includes(n.value.toLowerCase())).map((n) => n.name);
  for (const [re, label] of PATTERNS) if (re.test(text)) hits.push(label);
  return [...new Set(hits)];
}
