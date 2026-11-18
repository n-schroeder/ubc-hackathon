// Test harness shared by firewall unit tests and the red-team suite: a firewall with an in-memory
// ledger and fake payments (no network, no money). Vendors are simulated by `quotes`.
import { ARC_NETWORK, GATEWAY_WALLET_ADDRESS, USDC_ADDRESS, loadPolicy, loadRegistry, type Address, type Policy, type RegistryEntry } from "@asf/shared";
import { Firewall, type Payments, type Pipeline } from "./firewall.ts";
import { Store } from "./store.ts";
import { toQuote, type PaidResult, type PaymentOption, type PaymentRequired, type QuoteResult } from "./x402.ts";
import { defaultPipeline } from "./checks/index.ts";

/** A Gateway-batched 402 option, as the honest vendor would send it. Override fields to simulate attacks. */
export function gatewayOption(o: { amount: bigint | string; payTo: Address | string } & Partial<Omit<PaymentOption, "amount" | "payTo">>): PaymentOption {
  const { amount, payTo, extra, ...rest } = o;
  return {
    scheme: "exact", network: ARC_NETWORK, asset: USDC_ADDRESS, amount: String(amount), payTo: String(payTo),
    maxTimeoutSeconds: 604900, ...rest,
    extra: { name: "GatewayWalletBatched", version: "2", verifyingContract: GATEWAY_WALLET_ADDRESS, ...extra },
  };
}

export class FakePayments implements Payments {
  /** url prefix → what the vendor answers when asked without payment */
  quotes = new Map<string, () => QuoteResult | Promise<QuoteResult>>();
  paid: { url: string; option: PaymentOption }[] = [];
  transfers: { to: Address; amount: bigint }[] = [];
  vendorStatus = 200;
  failTransfers = false;

  /** Make every URL under `prefix` quote `option` (the vendor answers 402). */
  quote(prefix: string, option: PaymentOption | (() => PaymentOption)) {
    this.quotes.set(prefix, () => {
      const opt = typeof option === "function" ? option() : option;
      const required: PaymentRequired = { x402Version: 2, resource: { url: prefix }, accepts: [opt] };
      return { kind: "quote", required, option: opt, quote: toQuote(opt, required.resource) };
    });
  }

  async requestQuote(url: string): Promise<QuoteResult> {
    const hit = [...this.quotes.entries()].filter(([p]) => url.startsWith(p)).sort((a, b) => b[0].length - a[0].length)[0];
    if (!hit) throw new Error(`no fake vendor for ${url}`);
    return hit[1]();
  }
  async payQuote(url: string, _r: PaymentRequired, option: PaymentOption): Promise<PaidResult> {
    this.paid.push({ url, option });
    return { status: this.vendorStatus, data: { ok: true, url }, gatewayTransferId: `fake-${this.paid.length}`, settled: true };
  }
  async transfer(to: Address, amount: bigint) {
    if (this.failTransfers) throw new Error("transfer reverted");
    this.transfers.push({ to, amount });
    return { txHash: `0x${String(this.transfers.length).padStart(64, "0")}` };
  }
}

export type TestRig = { fw: Firewall; pay: FakePayments; clock: { now: Date; advance(sec: number): void }; registry: RegistryEntry[]; policy: Policy };

/** A firewall wired to the real policy/registry files (unless overridden), fake payments, and a controllable clock.
 *  Honest quotes for every registry service are pre-installed. */
export function makeRig(opts: { pipeline?: Pipeline; policy?: Policy; registry?: RegistryEntry[] } = {}): TestRig {
  const policy = opts.policy ?? loadPolicy();
  const registry = opts.registry ?? loadRegistry();
  const clock = { now: new Date("2026-11-19T15:00:00Z"), advance(sec: number) { this.now = new Date(this.now.getTime() + sec * 1000); } };
  const pay = new FakePayments();
  for (const s of registry) pay.quote(`${s.baseUrl}/`, gatewayOption({ amount: s.expectedPrice, payTo: s.payTo }));
  // Services sharing a baseUrl need distinct prefixes: key by the service's conventional path too.
  const fw = new Firewall({ store: new Store(":memory:"), policy, registry, pipeline: opts.pipeline ?? defaultPipeline(), payments: pay, now: () => clock.now });
  return { fw, pay, clock, registry, policy };
}

// ------------------------------------------------------------------ onchain watchdog fixtures

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topic = (addr: string) => `0x${"0".repeat(24)}${addr.toLowerCase().slice(2)}`;
const hex = (n: bigint | number) => `0x${n.toString(16)}`;

/** The two Transfer logs Arc emits for one USDC movement: the ERC-20 one (6 decimals) and the native one
 *  (18 decimals), shaped like QuickNode's `logs` dataset. Pass `only` to emit just one of them. */
export function arcTransferLogs(o: { from: string; to: string; amount: bigint; txHash: string; block?: number; only?: "erc20" | "native" }) {
  const block = o.block ?? 72_000_000;
  const log = (address: string, value: bigint, logIndex: number) => ({
    address, topics: [TRANSFER_TOPIC, topic(o.from), topic(o.to)], data: `0x${value.toString(16).padStart(64, "0")}`,
    blockNumber: hex(block), blockHash: `0x${"ab".repeat(32)}`, transactionHash: o.txHash, transactionIndex: "0x0",
    logIndex: hex(logIndex), removed: false,
  });
  const logs = [];
  if (o.only !== "erc20") logs.push(log("0xfffffffffffffffffffffffffffffffffffffffe", o.amount * 10n ** 12n, 0));
  if (o.only !== "native") logs.push(log(USDC_ADDRESS.toLowerCase(), o.amount, 1));
  return logs;
}

/** Wrap logs the way a QuickNode Streams webhook delivers the `logs` dataset: data[block][receipt][log]. */
export function streamDelivery(logs: unknown[], network = "arc-testnet") {
  return { data: [[logs]], metadata: { dataset: "logs", network, stream_name: "asf-watchdog" } };
}
