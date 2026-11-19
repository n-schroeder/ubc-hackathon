// One isolated firewall per scenario: the real policy and registry files, an in-memory ledger, fake payments
// (no network, no money), and the real HTTP API on a random local port. Attacks go through HTTP, the same
// surface the agent uses, so they get exactly what a hijacked agent would get.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { IntentRequest, IntentResponse, Policy } from "@asf/shared";
import type { MandateView } from "@asf/agent/firewall-client";
import { createApp } from "@asf/firewall/server";
import { gatewayOption, makeRig, type TestRig } from "@asf/firewall/testing";
import { Watchdog, signQuickNode } from "@asf/firewall/watchdog";
import { createWatchdogApp } from "@asf/firewall/watchdog-server";

/** The human's token. Attacks never send it: the agent process is never given it. */
const ADMIN_TOKEN = "redteam-admin-token";
/** The QuickNode stream's security token: only QuickNode (and this harness, playing QuickNode) has it. */
export const STREAM_TOKEN = "redteam-quicknode-stream-token-0123456789";
/** The firewall wallet the watchdog watches. */
export const FIREWALL_WALLET = "0x115ac8ffb8241e1750ca19c26881f2a498c944b2";

export type MandateInput = { task: string; budget?: string; ttlSeconds?: number; allowedServices?: string[]; allowTransfers?: boolean };
type Quote = Parameters<typeof gatewayOption>[0];

export type Harness = TestRig & {
  url: string;
  /** What the agent can do: POST /intents with no credentials. */
  intent(req: IntentRequest): Promise<IntentResponse>;
  /** A raw HTTP call as the agent (no admin token). Returns the status code and body. */
  agentHttp(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: any }>;
  /** What the human does: create, complete or revoke a mandate (admin token). */
  admin(method: "GET" | "POST", path: string, body?: unknown): Promise<any>;
  mandate(input: MandateInput): Promise<MandateView>;
  /** Make premium-weather (the shady vendor) quote something other than its honest price. */
  shady(quote: Partial<Quote> | (() => Quote)): void;
  watchdog: Watchdog;
  /** POST a delivery to the watchdog webhook, signed with `token` (QuickNode's by default). */
  webhook(payload: unknown, token?: string): Promise<{ status: number; body: any }>;
  /** USDC (base units) that actually left the wallet: paid x402 calls plus transfers. */
  moved(): bigint;
  close(): Promise<void>;
};

export async function openHarness(opts: { policy?: Policy } = {}): Promise<Harness> {
  const rig = makeRig({ policy: opts.policy });
  const server: Server = createApp(rig.fw, { adminToken: ADMIN_TOKEN }).listen(0, "127.0.0.1");
  await new Promise((ok) => server.once("listening", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const watchdog = new Watchdog(rig.fw, FIREWALL_WALLET);
  const hook: Server = createWatchdogApp(watchdog, { securityToken: STREAM_TOKEN, log: () => {} }).listen(0, "127.0.0.1");
  await new Promise((ok) => hook.once("listening", ok));
  const hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/quicknode`;
  const premium = rig.registry.find((s) => s.id === "premium-weather")!;

  const http = async (method: string, path: string, body: unknown, token?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["x-admin-token"] = token;
    const r = await fetch(url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const admin = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const r = await http(method, path, body, ADMIN_TOKEN);
    if (r.status >= 400) throw new Error(`admin ${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };

  return {
    ...rig,
    url,
    intent: async (req) => (await http("POST", "/intents", req)).body as IntentResponse,
    agentHttp: (method, path, body) => http(method, path, body),
    admin,
    mandate: (input) => admin("POST", "/mandates", input),
    shady: (q) => rig.pay.quote(`${premium.baseUrl}/`, typeof q === "function"
      ? () => gatewayOption(q())
      : gatewayOption({ amount: premium.expectedPrice, payTo: premium.payTo, ...q })),
    moved: () => rig.pay.paid.reduce((s, p) => s + BigInt(p.option.amount), 0n) + rig.pay.transfers.reduce((s, t) => s + t.amount, 0n),
    watchdog,
    webhook: async (payload, token = STREAM_TOKEN) => {
      const body = JSON.stringify(payload);
      const ts = String(Math.floor(Date.now() / 1000));
      const r = await fetch(hookUrl, {
        method: "POST", body,
        headers: { "content-type": "application/json", "x-qn-nonce": "redteam", "x-qn-timestamp": ts, "x-qn-signature": signQuickNode(token, "redteam", ts, body) },
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    close: async () => {
      watchdog.stop();
      await Promise.all([server, hook].map((s) => new Promise<void>((ok) => s.close(() => ok()))));
    },
  };
}
