// The static replay build (scripts/lib/replay.ts): how a recorded ledger + mandates become takes, breaker
// events and sanitized rows, and the secret scan that guards the published site.
import { describe, expect, it } from "vitest";
import { deriveReplay, findLeaks, sanitizeRow, secretNeedles, type Notes } from "../../../scripts/lib/replay.ts";

const EXPLORER = "https://testnet.arcscan.app";
const TX = `0x${"ab".repeat(32)}`;
const t = (s: number) => new Date(Date.UTC(2026, 10, 18, 20, 0, s)).toISOString();

const notes: Notes = {
  repoUrl: "https://example.com/repo",
  baselineTx: { dry: TX },
  passes: { dry: "Scripted", live: "Live" },
  scenes: [
    { scene: 2, step: "picnic", short: "2", mode: "honest", match: "Picnic", title: "Happy path", look: "pays" },
    { scene: 3, step: "inject", short: "3", mode: "inject", match: "Premium", title: "Injection", look: "denied", baseline: "Without it:" },
    { scene: 4, step: "swap", short: "4a", mode: "payee_swap", match: "Cities", rule: "preflight.payto", title: "Swap", look: "a" },
    { scene: 4, step: "drift", short: "4b", mode: "drift", match: "Cities", rule: "preflight.price", title: "Drift", look: "b" },
  ],
};

const mandate = (id: string, task: string, at: number) => ({ id, task, createdAt: t(at), status: "completed", budget: "1", spent: "0", secretField: "x" });
let seq = 0;
const row = (mandateId: string, at: number, key: string, extra: Record<string, unknown> = {}) =>
  ({ seq: ++seq, at: t(at), kind: "x402_call", mandateId, amount: "0.001", outcome: "approved", idempotencyKey: key, ...extra });

function recording() {
  seq = 0;
  const mandates = [
    mandate("m1", "Picnic in 3 cities", 0),
    mandate("m2", "Premium forecast", 10),
    mandate("m3", "Cities forecast", 20),
    mandate("m4", "Cities forecast", 30),
    mandate("m5", "Picnic in 3 cities", 100),
    mandate("m6", "Picnic in 3 cities", 110), // no rows: inherits the previous take's pass
    mandate("m7", "Cities forecast", 120),
  ];
  const ledger = [
    row("m1", 1, "toolu_dry_1"), row("m1", 2, "toolu_dry_2"),
    row("m2", 11, "toolu_dry_3", { kind: "transfer", amount: "0.05", outcome: "denied", rule: "policy.recipient_not_allowed" }),
    row("m3", 21, "toolu_dry_4", { outcome: "denied", rule: "preflight.payto_mismatch", checks: [{ outcome: "deny", rule: "preflight.payto_mismatch", tripBreaker: true, junk: 1 }] }),
    row("m4", 31, "toolu_dry_5", { outcome: "denied", rule: "preflight.price_drift" }),
    row("m5", 101, "toolu_01live", { txHash: TX }),
    row("m7", 121, "toolu_02live", { outcome: "denied", rule: "preflight.payto_mismatch" }),
  ];
  return deriveReplay(ledger, mandates, { budget: "5" }, notes, EXPLORER);
}

describe("deriveReplay", () => {
  it("makes one take per mandate with its pass, scene and retake number", () => {
    const r = recording();
    expect(r.takes.map((x) => x.id)).toEqual(["dry-2", "dry-3", "dry-4a", "dry-4b", "live-2", "live-2-r1", "live-4a"]);
    expect(r.takes.map((x) => x.short)).toEqual(["2", "3", "4a", "4b", "2", "2′", "4a"]);
    expect(r.takes[5]!.pass).toBe("live"); // no rows of its own: inherited from m5
    expect(r.takes[2]!.mode).toBe("payee_swap");
  });

  it("tells same-task scenes apart by the rule prefix they were denied with", () => {
    const r = recording();
    expect(r.takes[2]).toMatchObject({ scene: 4, step: "swap", summary: { denied: 1, rules: ["preflight.payto_mismatch"] } });
    expect(r.takes[3]).toMatchObject({ scene: 4, step: "drift", summary: { denied: 1, rules: ["preflight.price_drift"] } });
  });

  it("summarizes spend and links the baseline only for the pass that recorded one", () => {
    const r = recording();
    expect(r.takes[0]!.summary).toMatchObject({ approved: 2, denied: 0, spent: "0.002" });
    expect(r.takes[1]!.baselineUrl).toBe(`${EXPLORER}/tx/${TX}`);
    expect(r.meta).toMatchObject({ rows: 7, approved: 3, denied: 4, spent: "0.003", explorerLinks: 1 });
  });

  it("trips the breaker on a tripBreaker check and resets it 1 s before the next take's mandate", () => {
    const r = recording();
    expect(r.breaker).toHaveLength(2);
    expect(r.breaker[0]).toMatchObject({ at: Date.parse(t(21)), state: { state: "open", rule: "preflight.payto_mismatch" } });
    expect(r.breaker[1]).toMatchObject({ at: Date.parse(t(30)) - 1000, state: { state: "closed" } });
  });

  it("closes each mandate before the next one starts and skips the quiet gap", () => {
    const r = recording();
    for (let i = 0; i + 1 < r.takes.length; i++) expect(r.takes[i]!.closedAt!).toBeLessThan(r.takes[i + 1]!.createdAt);
    expect(r.skips.some(([a, b]) => a < Date.parse(t(60)) && b > Date.parse(t(60)))).toBe(true);
    expect(r.mandates[0]).not.toHaveProperty("secretField");
  });

  it("uses a recorded closedAt instead of estimating one", () => {
    const at = t(5);
    const r = deriveReplay([], [{ ...mandate("m1", "Picnic in 3 cities", 0), closedAt: at }], { budget: "5" }, notes, EXPLORER);
    expect(r.takes[0]!.closedAt).toBe(Date.parse(at));
    expect(r.mandates[0]).toMatchObject({ closedAt: at });
  });

  it("sets the vendor's mode for each non-honest take and puts it back afterwards", () => {
    const r = recording();
    expect(r.vendor.filter((v) => v.mode !== "honest").map((v) => v.mode)).toEqual(["inject", "payee_swap", "drift", "payee_swap"]);
    expect(r.vendor.filter((v) => v.mode === "honest")).toHaveLength(4);
  });
});

describe("sanitizeRow", () => {
  it("drops fields the dashboard doesn't render, including idempotencyKey", () => {
    const out = sanitizeRow({ seq: 1, idempotencyKey: "toolu_x", apiKey: "nope", checks: [{ rule: "a", secret: 1 }] }, EXPLORER);
    expect(out).toEqual({ seq: 1, checks: [{ rule: "a" }] });
  });

  it("only keeps explorer links on the Arc explorer, rebuilding them from a valid tx hash", () => {
    expect(sanitizeRow({ txHash: TX, explorerUrl: "https://evil.example/tx/1" }, EXPLORER).explorerUrl).toBe(`${EXPLORER}/tx/${TX}`);
    expect(sanitizeRow({ explorerUrl: "javascript:alert(1)" }, EXPLORER)).not.toHaveProperty("explorerUrl");
    expect(sanitizeRow({ txHash: "0xshort" }, EXPLORER)).toEqual({});
    expect(sanitizeRow({ explorerUrl: `${EXPLORER}/tx/${TX}` }, EXPLORER).explorerUrl).toBe(`${EXPLORER}/tx/${TX}`);
  });
});

describe("secret scan", () => {
  const key = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
  const env = {
    CIRCLE_API_KEY: `TEST_API_KEY:0123456789abcdef:${key}`,
    PRIVATE_KEY: `0x${"5e".repeat(32)}`,
    SELLER_ADDRESS: `0x${"11".repeat(20)}`,
    FIREWALL_PORT: "8787",
    SHORT: "abc",
  };
  const needles = secretNeedles(env);

  it("skips public-by-design and short values and never puts values in the names", () => {
    expect(needles.map((n) => n.name)).not.toContain("SELLER_ADDRESS");
    expect(needles.map((n) => n.name)).not.toContain("SHORT");
    expect(findLeaks(`pay ${env.SELLER_ADDRESS} on 8787`, needles)).toEqual([]);
  });

  it("catches an env value, a part of it, and a hex value without 0x (any case)", () => {
    expect(findLeaks(`x ${env.CIRCLE_API_KEY} y`, needles)).toContain("CIRCLE_API_KEY");
    expect(findLeaks(`only the secret part: ${key}`, needles)).toEqual(["CIRCLE_API_KEY (part)"]);
    expect(findLeaks(`"${"5E".repeat(32)}"`, needles)).toEqual(["PRIVATE_KEY (no 0x)"]);
    for (const hit of findLeaks(env.CIRCLE_API_KEY + env.PRIVATE_KEY, needles)) expect(hit).not.toContain(key);
  });

  it("catches key-shaped strings even when they aren't in .env", () => {
    expect(findLeaks("sk-ant-api03-abcdefgh", [])).toEqual(["an Anthropic API key"]);
    expect(findLeaks("/?token=abcdefgh123", [])).toEqual(["an admin token in a URL"]);
    expect(findLeaks("-----BEGIN EC PRIVATE KEY-----", [])).toEqual(["a PEM private key"]);
    expect(findLeaks("LIVE_API_KEY:x", [])).toEqual(["a Circle API key"]);
  });
});
