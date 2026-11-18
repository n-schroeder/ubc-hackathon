// Onchain watchdog: an independent check that the chain agrees with the ledger.
//
// Every other check in this project runs *inside* the firewall, before it signs. This one runs *after the
// fact*, on data the firewall doesn't produce: a QuickNode Stream on Arc testnet pushes every USDC Transfer
// log that leaves the firewall's wallet to a webhook here (docs: README "Watchdog (QuickNode Streams)").
// Each outflow must match something the firewall knowingly did:
//
//   - a transfer the firewall signed: a ledger row with the same tx hash, recipient and amount, or a
//     transfer it is signing right now (the log can arrive before the ledger row is written);
//   - a deposit into the firewall's own Circle Gateway balance (the Gateway Wallet contract), which is
//     how nanopayments are funded. That money stays the firewall's; only its signatures can spend it.
//
// Anything else means USDC left the wallet without the firewall deciding to send it: a leaked Circle API
// key and entity secret, a script run by hand, a bug. That's an alert, and it trips the circuit breaker so
// the agent can't spend another cent until a human looks. The watchdog can't undo the transfer (whoever
// moved the money holds the credentials); its job is to make sure nobody finds out a week later.
//
// Nanopayments never appear here: Gateway settles them in batches from its own contract, not from the
// firewall's wallet. Gas doesn't either: Arc charges it in native USDC without a Transfer log.
//
// Arc quirk (verified on testnet, tx 0x833a…7f0d): each USDC movement emits TWO Transfer logs with the
// same tx hash, one from the USDC ERC-20 (0x3600…0000, 6 decimals) and one from the native-balance
// pseudo-address 0xffff…fffe (18 decimals). Both are accepted, so a movement that only shows up in one
// of them is still caught, and they are merged into one outflow per (tx, recipient, amount).
import { createHmac, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { getAddress, isAddress } from "viem";
import {
  GATEWAY_WALLET_ADDRESS, USDC_ADDRESS, formatUsdc, nativeToUsdc, txUrl,
  type Address, type LedgerRow,
} from "@asf/shared";
import type { Firewall } from "./firewall.ts";

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** Arc's native-USDC event emitter: Transfer logs from here carry 18-decimal values. */
export const NATIVE_USDC_EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe";

export type Outflow = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  to: Address;
  amount: bigint; // USDC base units (6 decimals), whichever log it came from
  source: "erc20" | "native";
};

export type Verdict =
  | { status: "matched_intent"; intentId: string }
  | { status: "matched_in_flight"; intentId: string }
  | { status: "gateway_deposit" }
  | { status: "alert"; rule: "watchdog.unsigned_outflow" | "watchdog.mismatch"; detail: string };

export type WatchdogEvent = Outflow & {
  key: string;          // txHash:to:amount, the dedupe key
  seenAt: string;
  verdict: Verdict;
  explorerUrl: string;
};

// ------------------------------------------------------------------ parsing (pure)

const lower = (s: unknown) => (typeof s === "string" ? s.toLowerCase() : "");
const hexNum = (v: unknown) => (typeof v === "string" && /^0x[0-9a-f]+$/i.test(v) ? Number(BigInt(v)) : typeof v === "number" ? v : 0);
const topicAddress = (t: unknown) => {
  const s = lower(t);
  return /^0x0{24}[0-9a-f]{40}$/.test(s) ? `0x${s.slice(26)}` : undefined;
};

/** Every log-shaped object anywhere in the payload. QuickNode nests logs by block and by receipt
 *  (data[block][receipt][log]), receipts carry `logs` arrays, and a filter can return any shape, so
 *  this walks the whole thing rather than trusting one layout. */
export function findLogs(payload: unknown, out: any[] = [], depth = 0): any[] {
  if (depth > 8 || payload === null || typeof payload !== "object") return out;
  if (Array.isArray(payload)) {
    for (const x of payload) findLogs(x, out, depth + 1);
    return out;
  }
  const o = payload as Record<string, unknown>;
  if (Array.isArray(o.topics) && typeof o.address === "string") {
    out.push(o);
    return out;
  }
  for (const k of ["data", "logs", "receipts", "matches", "outflows"]) if (k in o) findLogs(o[k], out, depth + 1);
  return out;
}

/** USDC outflows from `wallet`, one per (tx, recipient, amount). Reorged-out logs (`removed`) are dropped. */
export function extractOutflows(payload: unknown, wallet: string): Outflow[] {
  const from = lower(wallet);
  const byKey = new Map<string, Outflow>();
  for (const log of findLogs(payload)) {
    if (log.removed === true) continue;
    const t = log.topics as unknown[];
    if (lower(t[0]) !== TRANSFER_TOPIC || topicAddress(t[1]) !== from) continue;
    const emitter = lower(log.address);
    const source = emitter === lower(USDC_ADDRESS) ? "erc20" : emitter === NATIVE_USDC_EMITTER ? "native" : undefined;
    const to = topicAddress(t[2]);
    const txHash = lower(log.transactionHash);
    if (!source || !to || !/^0x[0-9a-f]{64}$/.test(txHash) || !/^0x[0-9a-f]*$/i.test(String(log.data))) continue;
    const raw = String(log.data) === "0x" ? 0n : BigInt(String(log.data));
    const amount = source === "native" ? nativeToUsdc(raw) : raw;
    const key = outflowKey(txHash, to, amount);
    const prev = byKey.get(key);
    if (prev && prev.source === "erc20") continue; // prefer the ERC-20 log of the pair
    byKey.set(key, {
      txHash, to: getAddress(to) as Address, amount, source,
      logIndex: hexNum(log.logIndex), blockNumber: hexNum(log.blockNumber),
    });
  }
  return [...byKey.values()];
}

export const outflowKey = (txHash: string, to: string, amount: bigint) => `${lower(txHash)}:${lower(to)}:${amount}`;

// ------------------------------------------------------------------ webhook signature

/** QuickNode Streams signs each webhook: hex HMAC-SHA256 of nonce + timestamp + body, keyed with the
 *  stream's security token (headers X-QN-Nonce, X-QN-Timestamp, X-QN-Signature). The body is the
 *  decoded JSON text, after any gzip. */
export function signQuickNode(token: string, nonce: string, timestamp: string, body: string): string {
  return createHmac("sha256", Buffer.from(token)).update(nonce + timestamp + body).digest("hex");
}

export function verifyQuickNode(token: string, h: { nonce?: string; timestamp?: string; signature?: string }, body: string): boolean {
  if (!token || !h.nonce || !h.timestamp || !h.signature) return false;
  const want = Buffer.from(signQuickNode(token, h.nonce, h.timestamp, body));
  const got = Buffer.from(h.signature.toLowerCase());
  return got.length === want.length && timingSafeEqual(got, want);
}

// ------------------------------------------------------------------ the watchdog

const IN_FLIGHT_MS = 60 * 60 * 1000;

export class Watchdog extends EventEmitter<{ outflow: [WatchdogEvent] }> {
  readonly wallet: Address;
  /** Transfers the firewall has decided to sign but may not have recorded yet: intentId → recipient/amount. */
  private inFlight = new Map<string, { to: string; amount: bigint; at: number }>();
  private onSigning = (s: { intentId: string; to: Address; amount: bigint }) =>
    this.inFlight.set(s.intentId, { to: lower(s.to), amount: s.amount, at: Date.now() });
  // Once the decision is recorded, the ledger row (tx hash, or a "failed" row) is what outflows match.
  private onDecision = (r: LedgerRow) => {
    if (r.outcome !== "pending_human") this.inFlight.delete(r.intentId);
  };

  constructor(private fw: Firewall, wallet: string) {
    super();
    if (!isAddress(wallet)) throw new Error(`watchdog: wallet must be an address, got "${wallet}"`);
    this.wallet = getAddress(wallet) as Address;
    fw.on("signing", this.onSigning);
    fw.on("decision", this.onDecision);
  }

  stop() {
    this.fw.off("signing", this.onSigning);
    this.fw.off("decision", this.onDecision);
  }

  recent(limit = 100): WatchdogEvent[] {
    return this.fw.store.outflows(limit);
  }

  /** Handle one webhook delivery. Idempotent: QuickNode retries, and reorgs re-deliver blocks. */
  ingest(payload: unknown): WatchdogEvent[] {
    const fresh: WatchdogEvent[] = [];
    for (const o of extractOutflows(payload, this.wallet)) {
      const key = outflowKey(o.txHash, o.to, o.amount);
      if (this.fw.store.getOutflow(key)) continue;
      const ev: WatchdogEvent = { ...o, key, seenAt: this.fw.clock().toISOString(), verdict: this.judge(o), explorerUrl: txUrl(o.txHash) };
      this.fw.store.recordOutflow(ev);
      if (ev.verdict.status === "alert") this.fw.tripBreaker(ev.verdict.rule, ev.verdict.detail);
      this.emit("outflow", ev);
      fresh.push(ev);
    }
    return fresh;
  }

  /** Match one outflow against what the firewall knowingly did. */
  judge(o: Outflow): Verdict {
    const to = lower(o.to);
    if (to === lower(GATEWAY_WALLET_ADDRESS)) return { status: "gateway_deposit" };

    const transfers = this.fw.store.transfers();
    const byHash = transfers.find((r) => lower(r.txHash) === o.txHash);
    if (byHash) {
      if (lower(byHash.recipient) === to && byHash.amount === o.amount) return { status: "matched_intent", intentId: byHash.intentId };
      return {
        status: "alert", rule: "watchdog.mismatch",
        detail: `tx ${short(o.txHash)} sent ${formatUsdc(o.amount)} USDC to ${short(o.to)}, but the firewall signed ` +
          `${formatUsdc(byHash.amount ?? 0n)} USDC to ${short(byHash.recipient ?? "?")} (intent ${byHash.intentId.slice(0, 8)}…)`,
      };
    }

    // Signed but not yet recorded, or recorded as failed (e.g. a confirmation timeout after broadcast).
    const claimed = new Set(this.fw.store.matchedIntentIds());
    const now = Date.now();
    for (const [id, f] of this.inFlight) {
      if (now - f.at > IN_FLIGHT_MS) { this.inFlight.delete(id); continue; }
      if (f.to === to && f.amount === o.amount && !claimed.has(id)) {
        this.inFlight.delete(id);
        return { status: "matched_in_flight", intentId: id };
      }
    }
    const failed = transfers.find((r) => r.outcome === "failed" && !r.txHash && lower(r.recipient) === to && r.amount === o.amount && !claimed.has(r.intentId));
    if (failed) return { status: "matched_in_flight", intentId: failed.intentId };

    return {
      status: "alert", rule: "watchdog.unsigned_outflow",
      detail: `${formatUsdc(o.amount)} USDC left the firewall wallet to ${short(o.to)} in tx ${short(o.txHash)}, ` +
        `and the firewall never signed it`,
    };
  }
}

const short = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);
