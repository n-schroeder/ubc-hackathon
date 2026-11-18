// Firewall-driven x402 handshake (M0 decision: hand-rolled, so we can check before signing).
//
//   GET url (no payment) → 402 + base64 JSON PAYMENT-REQUIRED header
//   → pick one option → [firewall checks the quote] → sign exactly that option
//   → GET url with base64 JSON Payment-Signature header → PAYMENT-RESPONSE header
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { getAddress } from "viem";
import { ARC_NETWORK, parseBaseUnits, type Address, type X402Quote } from "@asf/shared";
import type { Signer } from "./signer.ts";

export const GATEWAY_BATCHED = "GatewayWalletBatched";
const TIMEOUT_MS = 15_000;

export type PaymentOption = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
};
export type PaymentRequired = { x402Version?: number; resource?: unknown; accepts: PaymentOption[] };

export type QuoteResult =
  | { kind: "free"; status: number; data: unknown }
  | { kind: "quote"; required: PaymentRequired; option: PaymentOption; quote: X402Quote };

const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

async function body(res: Response): Promise<unknown> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

/** Prefer Gateway-batched options on Arc testnet, highest batching version first. Never filters
 *  everything out: if nothing matches we still return an option so pre-flight can deny it by rule. */
export function selectOption(accepts: PaymentOption[]): PaymentOption {
  if (!Array.isArray(accepts) || accepts.length === 0) throw new Error("402 has no payment options");
  const score = (o: PaymentOption) =>
    (o.extra?.name === GATEWAY_BATCHED ? 100 : 0) + (o.network === ARC_NETWORK ? 10 : 0) + Number(o.extra?.version ?? 0);
  return [...accepts].sort((a, b) => score(b) - score(a))[0]!;
}

export function toQuote(o: PaymentOption, resource?: unknown): X402Quote {
  const vc = o.extra?.verifyingContract;
  return {
    scheme: String(o.scheme),
    network: String(o.network),
    asset: getAddress(String(o.asset)) as Address,
    amount: parseBaseUnits(o.amount),
    payTo: getAddress(String(o.payTo)) as Address,
    extraName: o.extra?.name === undefined ? undefined : String(o.extra.name),
    extraVersion: o.extra?.version === undefined ? undefined : String(o.extra.version),
    verifyingContract: typeof vc === "string" ? (getAddress(vc) as Address) : undefined,
    resource: typeof resource === "object" && resource && "url" in resource ? String((resource as any).url) : undefined,
  };
}

/** Step 1: ask without paying. Any malformed 402 throws (the caller denies: fail closed). */
export async function requestQuote(url: string, fetchImpl: typeof fetch = fetch): Promise<QuoteResult> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status !== 402) {
    if (res.ok) return { kind: "free", status: res.status, data: await body(res) };
    throw new Error(`service returned HTTP ${res.status} before payment`);
  }
  const header = res.headers.get("PAYMENT-REQUIRED");
  if (!header) throw new Error("402 without PAYMENT-REQUIRED header");
  const required = b64json(header) as PaymentRequired;
  const option = selectOption(required.accepts);
  return { kind: "quote", required, option, quote: toQuote(option, required.resource) };
}

export type PaidResult = { status: number; data: unknown; gatewayTransferId?: string; settled: boolean };

/** Step 2 (only after every check passed): sign exactly the option we checked and retry. */
export async function payQuote(
  url: string, required: PaymentRequired, option: PaymentOption, signer: Signer, fetchImpl: typeof fetch = fetch,
): Promise<PaidResult> {
  const scheme = new BatchEvmScheme(signer as any);
  const payload = await scheme.createPaymentPayload(required.x402Version ?? 2, option as any);
  const res = await fetchImpl(url, {
    headers: { "Payment-Signature": b64({ ...payload, resource: required.resource, accepted: option }) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const pr = res.headers.get("PAYMENT-RESPONSE");
  let settle: any;
  try { settle = pr ? b64json(pr) : undefined; } catch { settle = undefined; }
  return { status: res.status, data: await body(res), gatewayTransferId: settle?.transaction, settled: settle?.success === true };
}
