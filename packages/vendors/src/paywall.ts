// x402 paywall on Circle Gateway's seller middleware, with the price and payee decided per request
// (the shady vendor changes both at runtime).
import type { Request, RequestHandler } from "express";
import { createGatewayMiddleware, type GatewayMiddleware } from "@circle-fin/x402-batching/server";
import { ARC_NETWORK, formatUsdc, type Address, type RegistryEntry } from "@asf/shared";

/** Must be passed explicitly: the SDK's default facilitator is mainnet. */
export const TESTNET_FACILITATOR = "https://gateway-api-testnet.circle.com";

export type Quote = { price: bigint; payTo: Address };

/** Returns `paywall(quote)`: an express middleware that answers 402 with `quote(req)` unless the request
 *  carries a valid Gateway payment for exactly that quote. One SDK middleware per payee, because each
 *  instance caches the facilitator's supported networks. */
export function createPaywall(facilitatorUrl = TESTNET_FACILITATOR) {
  const byPayee = new Map<string, GatewayMiddleware>();
  const gateway = (payTo: Address) => {
    let gw = byPayee.get(payTo);
    if (!gw) byPayee.set(payTo, (gw = createGatewayMiddleware({ sellerAddress: payTo, networks: ARC_NETWORK, facilitatorUrl })));
    return gw;
  };
  return (quote: (req: Request) => Quote): RequestHandler => (req, res, next) => {
    const q = quote(req);
    return gateway(q.payTo).require(`$${formatUsdc(q.price)}`)(req, res, next);
  };
}

export function registryEntry(registry: RegistryEntry[], id: string): RegistryEntry {
  const e = registry.find((r) => r.id === id);
  if (!e) throw new Error(`registry has no service "${id}"`);
  return e;
}

/** Reject a bad ?city= before the paywall, so nobody is charged for a request we can't answer. */
export const requireCity: RequestHandler = (req, res, next) => {
  const city = req.query.city;
  if (typeof city !== "string" || !city.trim() || city.length > 80) {
    res.status(400).json({ error: "query parameter city is required (max 80 chars)" });
    return;
  }
  next();
};

export const cityOf = (req: Request) => String(req.query.city).trim();
