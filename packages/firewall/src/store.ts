// Persistent state: the append-only ledger, mandates (P4) and breaker state (P3), in SQLite.
// The ledger is the source of truth for spend windows and mandate spend; nothing is cached.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  SPENT_OUTCOMES, type BreakerState, type DecisionOutcome, type LedgerRow, type Mandate, type PaymentIntent,
} from "@asf/shared";
import type { WatchdogEvent } from "./watchdog.ts";

// bigint-safe JSON
const BIG = "__bigint:";
const enc = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? BIG + x.toString() : x));
const dec = <T>(s: string): T =>
  JSON.parse(s, (_k, x) => (typeof x === "string" && x.startsWith(BIG) ? BigInt(x.slice(BIG.length)) : x));

export type PendingIntent = { intent: PaymentIntent; row: LedgerRow };

export class Store {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS ledger (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        intent_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        at TEXT NOT NULL,
        mandate_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        intent TEXT NOT NULL,
        row TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_at ON ledger(at);
      CREATE TABLE IF NOT EXISTS mandates (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outflows (key TEXT PRIMARY KEY, seen_at TEXT NOT NULL, intent_id TEXT, json TEXT NOT NULL);
    `);
  }

  // ------------------------------------------------------------------ ledger

  /** Appends a decision. Returns the row with its sequence number. Throws on a duplicate key. */
  append(intent: PaymentIntent, row: Omit<LedgerRow, "seq">): LedgerRow {
    const r = this.db
      .prepare(
        `INSERT INTO ledger (intent_id, idempotency_key, at, mandate_id, outcome, intent, row)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.intentId, row.idempotencyKey, row.at, row.mandateId, row.outcome, enc(intent), "{}");
    const full: LedgerRow = { ...row, seq: Number(r.lastInsertRowid) };
    this.db.prepare(`UPDATE ledger SET row = ? WHERE seq = ?`).run(enc(full), full.seq);
    return full;
  }

  /** Rows change in place in two cases only: the approval flow (pending_human → human_approved |
   *  human_denied | failed), and settlement, which adds a nanopayment's batch txHash + explorerUrl. */
  update(row: LedgerRow): void {
    this.db.prepare(`UPDATE ledger SET outcome = ?, at = ?, row = ? WHERE seq = ?`).run(row.outcome, row.at, enc(row), row.seq);
  }

  byIntentId(id: string): PendingIntent | undefined {
    const r = this.db.prepare(`SELECT intent, row FROM ledger WHERE intent_id = ?`).get(id) as any;
    return r ? { intent: dec(r.intent), row: dec(r.row) } : undefined;
  }

  byIdempotencyKey(key: string): LedgerRow | undefined {
    const r = this.db.prepare(`SELECT row FROM ledger WHERE idempotency_key = ?`).get(key) as any;
    return r ? dec(r.row) : undefined;
  }

  /** Rows decided at or after `since`, oldest first. */
  since(since: Date): LedgerRow[] {
    return (this.db.prepare(`SELECT row FROM ledger WHERE at >= ? ORDER BY seq`).all(since.toISOString()) as any[]).map((r) =>
      dec<LedgerRow>(r.row),
    );
  }

  recent(limit = 200): LedgerRow[] {
    return (this.db.prepare(`SELECT row FROM ledger ORDER BY seq DESC LIMIT ?`).all(limit) as any[]).map((r) => dec<LedgerRow>(r.row));
  }

  pending(): PendingIntent[] {
    return (this.db.prepare(`SELECT intent, row FROM ledger WHERE outcome = 'pending_human' ORDER BY seq`).all() as any[]).map(
      (r) => ({ intent: dec(r.intent), row: dec(r.row) }),
    );
  }

  spentByMandate(mandateId: string): bigint {
    const rows = this.db
      .prepare(`SELECT row FROM ledger WHERE mandate_id = ? AND outcome IN (${SPENT_OUTCOMES.map(() => "?").join(",")})`)
      .all(mandateId, ...SPENT_OUTCOMES) as any[];
    return rows.reduce((sum, r) => sum + (dec<LedgerRow>(r.row).amount ?? 0n), 0n);
  }

  /** Transfers the firewall signed or tried to: everything that could have moved USDC out of the wallet. */
  transfers(): LedgerRow[] {
    return (this.db.prepare(`SELECT row FROM ledger WHERE outcome IN (${[...SPENT_OUTCOMES, "failed"].map(() => "?").join(",")}) ORDER BY seq`)
      .all(...SPENT_OUTCOMES, "failed") as any[])
      .map((r) => dec<LedgerRow>(r.row))
      .filter((r) => r.kind === "transfer");
  }

  // ------------------------------------------------------------------ onchain watchdog

  /** Records one observed outflow and its verdict. Keyed by tx:recipient:amount, so re-deliveries are no-ops. */
  recordOutflow(ev: WatchdogEvent): void {
    const intentId = "intentId" in ev.verdict ? ev.verdict.intentId : null;
    this.db.prepare(`INSERT OR IGNORE INTO outflows (key, seen_at, intent_id, json) VALUES (?, ?, ?, ?)`).run(ev.key, ev.seenAt, intentId, enc(ev));
  }

  getOutflow(key: string): WatchdogEvent | undefined {
    const r = this.db.prepare(`SELECT json FROM outflows WHERE key = ?`).get(key) as any;
    return r ? dec(r.json) : undefined;
  }

  outflows(limit = 100): WatchdogEvent[] {
    return (this.db.prepare(`SELECT json FROM outflows ORDER BY seen_at DESC, rowid DESC LIMIT ?`).all(limit) as any[]).map((r) => dec<WatchdogEvent>(r.json));
  }

  /** Intents an outflow has already been matched to (one outflow per intent). */
  matchedIntentIds(): string[] {
    return (this.db.prepare(`SELECT intent_id FROM outflows WHERE intent_id IS NOT NULL`).all() as any[]).map((r) => r.intent_id);
  }

  // ------------------------------------------------------------------ mandates (P4)

  createMandate(m: Omit<Mandate, "id" | "spent" | "status" | "createdAt"> & { id?: string }, now = new Date()): Mandate {
    const mandate: Mandate = {
      id: m.id ?? randomUUID(),
      task: m.task,
      budget: m.budget,
      spent: 0n,
      allowedServices: m.allowedServices,
      allowTransfers: m.allowTransfers,
      createdAt: now.toISOString(),
      expiresAt: m.expiresAt,
      status: "active",
    };
    this.db.prepare(`INSERT INTO mandates (id, created_at, json) VALUES (?, ?, ?)`).run(mandate.id, mandate.createdAt, enc(mandate));
    return mandate;
  }

  /** Reads a mandate with live `spent` and lazy expiry. */
  getMandate(id: string, now = new Date()): Mandate | undefined {
    const r = this.db.prepare(`SELECT json FROM mandates WHERE id = ?`).get(id) as any;
    if (!r) return undefined;
    const m = dec<Mandate>(r.json);
    m.spent = this.spentByMandate(id);
    if (m.status === "active" && new Date(m.expiresAt) <= now) m.status = "expired";
    return m;
  }

  listMandates(now = new Date()): Mandate[] {
    return (this.db.prepare(`SELECT id FROM mandates ORDER BY created_at DESC`).all() as any[]).map(
      (r) => this.getMandate(r.id, now)!,
    );
  }

  setMandateStatus(id: string, status: "completed" | "revoked"): Mandate | undefined {
    const m = this.getMandate(id);
    if (!m) return undefined;
    if (m.status === "active") m.status = status;
    this.db.prepare(`UPDATE mandates SET json = ? WHERE id = ?`).run(enc({ ...m, spent: 0n }), id);
    return this.getMandate(id);
  }

  // ------------------------------------------------------------------ breaker (P3)

  getBreaker(): BreakerState {
    const r = this.db.prepare(`SELECT v FROM kv WHERE k = 'breaker'`).get() as any;
    return r ? dec(r.v) : { state: "closed" };
  }

  setBreaker(b: BreakerState): void {
    this.db.prepare(`INSERT INTO kv (k, v) VALUES ('breaker', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(enc(b));
  }
}

export const isSpent = (o: DecisionOutcome) => SPENT_OUTCOMES.includes(o);
