// Loads config/policy.json and config/registry.json into typed, bigint-based objects.
// Any malformed value throws at startup (fail closed).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress } from "viem";
import { REPO_ROOT, optionalEnv } from "./env.ts";
import { parseUsdc } from "./money.ts";
import type { Address, Policy, RegistryEntry, ServiceListing } from "./types.ts";
import { formatUsdc } from "./money.ts";

const CONFIG_DIR = resolve(REPO_ROOT, "config");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const addr = (s: string): Address => getAddress(s) as Address;

export function parsePolicy(raw: any): Policy {
  return {
    perCallMax: parseUsdc(raw.perCallMax),
    perTransferCap: parseUsdc(raw.perTransferCap),
    humanApprovalAbove: parseUsdc(raw.humanApprovalAbove),
    dailyBudget: parseUsdc(raw.dailyBudget),
    recipientAllowlist: (raw.recipientAllowlist as string[]).map(addr),
    mandateDefaults: { budget: parseUsdc(raw.mandateDefaults.budget), ttlSeconds: Number(raw.mandateDefaults.ttlSeconds) },
    preflight: { maxDriftPct: Number(raw.preflight.maxDriftPct) },
    velocity: {
      perMinute: parseUsdc(raw.velocity.perMinute),
      maxCallsPerServicePerTask: Number(raw.velocity.maxCallsPerServicePerTask),
      duplicateLimit: Number(raw.velocity.duplicateLimit),
      duplicateWindowSeconds: Number(raw.velocity.duplicateWindowSeconds),
      noProgressLimit: Number(raw.velocity.noProgressLimit),
    },
  };
}

export function parseRegistry(raw: any): RegistryEntry[] {
  return (raw.services as any[]).map((s) => ({
    id: String(s.id),
    baseUrl: String(s.baseUrl).replace(/\/$/, ""),
    category: String(s.category),
    description: String(s.description),
    expectedPrice: parseUsdc(s.expectedPrice),
    priceTolerancePct: Number(s.priceTolerancePct),
    payTo: addr(s.payTo),
    asset: addr(s.asset),
    network: String(s.network),
    status: "pinned" as const,
  }));
}

export const loadPolicy = (path = resolve(CONFIG_DIR, "policy.json")): Policy => parsePolicy(readJson(path));
/** registry.json points the demo vendors at their default ports; these settings move them (packages/vendors). */
export const VENDOR_PORT_ENV = { "4021": "VENDOR_HONEST_PORT", "4022": "VENDOR_SHADY_PORT" } as const;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Re-points local service URLs from one port to another ({ "4021": 5021 }). Remote URLs are left alone. */
export function remapLocalPorts(entries: RegistryEntry[], ports: Record<string, string | number>): RegistryEntry[] {
  return entries.map((e) => {
    const u = new URL(e.baseUrl);
    const to = ports[u.port];
    if (!LOCAL_HOSTS.has(u.hostname) || to === undefined || String(to) === u.port) return e;
    const n = Number(to);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Bad port ${JSON.stringify(to)} for ${e.id}`);
    u.port = String(n);
    return { ...e, baseUrl: u.toString().replace(/\/$/, "") };
  });
}

/** The VENDOR_*_PORT settings in force, keyed by the default port they replace. */
export const vendorPortOverrides = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(VENDOR_PORT_ENV).flatMap(([port, name]) => {
      const v = optionalEnv(name);
      return v ? [[port, v]] : [];
    }),
  );

/** Loads the registry, with the demo vendors' URLs following VENDOR_HONEST_PORT / VENDOR_SHADY_PORT if set. */
export const loadRegistry = (
  path = resolve(CONFIG_DIR, "registry.json"),
  ports: Record<string, string | number> = vendorPortOverrides(),
): RegistryEntry[] => remapLocalPorts(parseRegistry(readJson(path)), ports);
export const loadDemoAddresses = (path = resolve(CONFIG_DIR, "registry.json")): Record<string, Address> =>
  Object.fromEntries(Object.entries(readJson(path).demoAddresses ?? {}).map(([k, v]) => [k, addr(v as string)]));

/** The sanitized view the agent gets (P5 piece): our descriptions, no addresses, no vendor text. */
export const toListing = (e: RegistryEntry): ServiceListing => ({
  id: e.id, category: e.category, description: e.description, expectedPrice: formatUsdc(e.expectedPrice),
});
