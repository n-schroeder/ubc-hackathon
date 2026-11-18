// Settlement watcher (F6/F23): turns a nanopayment's Gateway transfer id into the onchain batch tx hash.
//
// Gateway settles x402 nanopayments in batches, so at payment time the ledger only has the transfer id.
// `GET /v1/x402/transfers/:id` returns `txHash: null` until Circle batches the transfer onchain (the first
// 44 testnet transfers took 2–16 minutes, median ~8.5). This polls each unsettled paid row with backoff, and when the hash
// arrives the firewall writes `txHash` + `explorerUrl` onto the row and re-emits it, so the dashboard's
// log gets its explorer link live.
//
// Only the real firewall process (main.ts) runs this. The red-team suite and dev rigs use fake transfer ids.
import { GATEWAY_API_TESTNET, SPENT_OUTCOMES, type LedgerRow } from "@asf/shared";
import type { Firewall } from "./firewall.ts";

/** What we read from Gateway: `status` is received | batched | confirmed | completed | failed. */
export type TransferStatus = { status?: string; txHash?: string };
export type LookupTransfer = (id: string) => Promise<TransferStatus>;

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export function gatewayTransferLookup(fetchImpl: typeof fetch = fetch, base: string = GATEWAY_API_TESTNET): LookupTransfer {
  return async (id) => {
    const res = await fetchImpl(`${base}/x402/transfers/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Gateway transfer lookup: HTTP ${res.status}`);
    const j: any = await res.json();
    return {
      status: typeof j?.status === "string" ? j.status : undefined,
      // Gateway is outside our trust boundary: only a well-formed hash becomes an explorer link.
      txHash: typeof j?.txHash === "string" && TX_HASH.test(j.txHash) ? j.txHash : undefined,
    };
  };
}

export type WatcherOptions = {
  firstDelayMs?: number;   // first lookup this long after payment
  maxDelayMs?: number;     // backoff cap
  factor?: number;         // backoff multiplier
  maxTries?: number;       // give up after this many lookups (the row keeps its transfer id)
  resumeWindowMs?: number; // on start, pick up unsettled rows paid this recently
  log?: (msg: string) => void;
};

const DEFAULTS: Required<Omit<WatcherOptions, "log">> = {
  firstDelayMs: 20_000,
  maxDelayMs: 120_000,
  factor: 1.5,
  maxTries: 45, // 20 s, 30 s, 45 s, … then every 2 min: about 1.5 hours in all
  resumeWindowMs: 24 * 3600 * 1000,
};

export const needsSettlement = (r: LedgerRow) =>
  r.kind === "x402_call" && !!r.gatewayTransferId && !r.txHash && SPENT_OUTCOMES.includes(r.outcome);

export class SettlementWatcher {
  private o: Required<Omit<WatcherOptions, "log">>;
  private log: (msg: string) => void;
  private timers = new Map<string, ReturnType<typeof setTimeout>>(); // intentId → next lookup
  private onDecision = (r: LedgerRow) => this.watch(r);
  private started = false;

  constructor(private fw: Firewall, private lookup: LookupTransfer, opts: WatcherOptions = {}) {
    const { log, ...rest } = opts;
    this.o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) };
    this.log = log ?? ((m) => console.log(m));
  }

  /** Watch every new paid nanopayment, and resume rows left unsettled by a previous run. */
  start(): this {
    if (this.started) return this;
    this.started = true;
    this.fw.on("decision", this.onDecision);
    const since = new Date(Date.now() - this.o.resumeWindowMs);
    for (const r of this.fw.store.since(since)) this.watch(r);
    return this;
  }

  stop(): void {
    this.started = false;
    this.fw.off("decision", this.onDecision);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Rows being polled right now (intent ids). */
  pending(): string[] {
    return [...this.timers.keys()];
  }

  watch(row: LedgerRow): void {
    if (!needsSettlement(row) || this.timers.has(row.intentId)) return;
    this.schedule(row.intentId, row.gatewayTransferId!, 1, this.o.firstDelayMs);
  }

  private schedule(intentId: string, transferId: string, attempt: number, delay: number) {
    const t = setTimeout(() => void this.poll(intentId, transferId, attempt, delay), delay);
    t.unref?.();
    this.timers.set(intentId, t);
  }

  private async poll(intentId: string, transferId: string, attempt: number, delay: number) {
    let s: TransferStatus | undefined;
    try {
      s = await this.lookup(transferId);
    } catch (e) {
      this.log(`settlement: lookup of Gateway transfer ${transferId} failed (try ${attempt}): ${(e as Error).message}`);
    }
    if (!this.timers.has(intentId)) return; // stopped meanwhile

    if (s?.txHash) {
      this.timers.delete(intentId);
      if (this.fw.recordSettlement(intentId, s.txHash)) this.log(`settlement: Gateway transfer ${transferId} settled in tx ${s.txHash}`);
      return;
    }
    if (s?.status === "failed") {
      this.timers.delete(intentId);
      this.log(`settlement: Gateway reports transfer ${transferId} failed; no tx hash to link`);
      return;
    }
    if (attempt >= this.o.maxTries) {
      this.timers.delete(intentId);
      this.log(`settlement: gave up on Gateway transfer ${transferId} after ${attempt} lookups (status ${s?.status ?? "unknown"})`);
      return;
    }
    this.schedule(intentId, transferId, attempt + 1, Math.min(Math.round(delay * this.o.factor), this.o.maxDelayMs));
  }
}
