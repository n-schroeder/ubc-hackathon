// P2: x402 clients sign whatever the server asks for. Pre-flight compares the vendor's 402 quote with
// what we pinned for that service in config/registry.json before anything is signed.
import { GATEWAY_WALLET_ADDRESS, type Check, type CheckResult } from "@asf/shared";
import { GATEWAY_BATCHED } from "../x402.ts";
import { deny, pass, sameAddr, short, spentRows, usd } from "./util.ts";

export const preflightCheck: Check = {
  name: "preflight",
  run: (intent, ctx): CheckResult => {
    if (intent.kind !== "x402_call") return pass("preflight.not_applicable", "direct transfer: no vendor quote to verify");
    const s = ctx.service;
    if (!s) return deny("preflight.unknown_service", `"${intent.service}" is not a known service; unknown services are denied`);
    const q = ctx.quote;
    if (!q) return deny("preflight.no_quote", `no payment quote from ${s.id}`); // fail closed

    // What we'd be signing must be a Gateway batched authorization. Anything else (e.g. a plain
    // EIP-3009 transferWithAuthorization against the USDC contract) could move funds directly.
    if (q.scheme !== "exact" || q.extraName !== GATEWAY_BATCHED) {
      return deny("preflight.scheme_mismatch", `${s.id} asked for ${q.scheme}/${q.extraName ?? "?"}, expected exact/${GATEWAY_BATCHED}`);
    }
    if (q.network !== s.network) return deny("preflight.network_mismatch", `network ${q.network} ≠ ${s.network} for ${s.id}`, { observed: q.network, limit: s.network });
    if (!sameAddr(q.asset, s.asset)) return deny("preflight.asset_mismatch", `asset ${short(q.asset)} ≠ USDC ${short(s.asset)} for ${s.id}`, { observed: q.asset, limit: s.asset });
    if (!sameAddr(q.verifyingContract, GATEWAY_WALLET_ADDRESS)) {
      return deny("preflight.verifying_contract", `signature would be for ${short(q.verifyingContract)}, not the Gateway Wallet ${short(GATEWAY_WALLET_ADDRESS)}`, { observed: q.verifyingContract ?? "none", limit: GATEWAY_WALLET_ADDRESS });
    }
    if (!sameAddr(q.payTo, s.payTo)) {
      return deny("preflight.payto_mismatch", `payTo ${short(q.payTo)} ≠ pinned ${short(s.payTo)} for ${s.id}`, { observed: q.payTo, limit: s.payTo });
    }

    const max = (s.expectedPrice * BigInt(100 + s.priceTolerancePct)) / 100n;
    if (q.amount > max) {
      return deny("preflight.price_out_of_band", `price ${usd(q.amount)} exceeds the +${s.priceTolerancePct}% band for ${s.id} (expected ${usd(s.expectedPrice)}, max ${usd(max)})`, { observed: usd(q.amount), limit: usd(max) });
    }

    // Upward drift: compared with the last price we actually paid this service.
    const last = spentRows(ctx).filter((r) => r.kind === "x402_call" && r.service === s.id && r.amount !== undefined).at(-1);
    const drift = ctx.policy.preflight.maxDriftPct;
    if (last?.amount !== undefined && q.amount * 100n > last.amount * BigInt(100 + drift)) {
      return deny("preflight.price_drift", `price ${usd(q.amount)} is more than +${drift}% over the last paid ${usd(last.amount)} for ${s.id}`, { observed: usd(q.amount), limit: usd((last.amount * BigInt(100 + drift)) / 100n) });
    }
    return pass("preflight.ok", `quote matches ${s.id}: payTo pinned, ${usd(q.amount)} within band`);
  },
};
