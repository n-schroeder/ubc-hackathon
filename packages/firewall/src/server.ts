// Firewall HTTP API.
//
// Agent-facing (no token; this is the agent's entire spending surface):
//   POST /intents            submit a payment intent → decision (+ paid API data)
//   GET  /intents/:id        decision status (poll escalated intents)
//   GET  /services           sanitized registry (P5 piece: our descriptions, no addresses)
//   GET  /mandates/:id       one mandate (remaining budget, expiry)
//
// Human/admin (require x-admin-token, which the agent process never gets):
//   GET/POST /mandates, POST /mandates/:id/complete|revoke
//   GET /approvals, POST /approvals/:id {approve: boolean}
//   GET /breaker, POST /breaker/reset
//   GET /ledger, GET /events (SSE), GET /policy
import express, { type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { formatUsdc, toListing, type LedgerRow, type Mandate, type Policy } from "@asf/shared";
import type { Firewall } from "./firewall.ts";

// bigint → decimal USDC string for every JSON response
const jsonReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? formatUsdc(v) : v);

export const mandateView = (m: Mandate) => ({ ...m, remaining: m.budget - m.spent });
export const rowView = (r: LedgerRow) => r;
export const policyView = (p: Policy) => p;

export type ServerOptions = { adminToken: string; staticDir?: string };

export function createApp(fw: Firewall, opts: ServerOptions) {
  const app = express();
  app.set("json replacer", jsonReplacer);
  app.use(express.json({ limit: "64kb" }));

  const admin = (req: Request, res: Response, next: NextFunction) => {
    const got = Buffer.from(String(req.header("x-admin-token") ?? req.query.token ?? ""));
    const want = Buffer.from(opts.adminToken);
    if (got.length === want.length && timingSafeEqual(got, want)) return next();
    res.status(401).json({ error: "admin token required" });
  };
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response) =>
    Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: (e as Error).message }));

  // ---------------------------------------------------------------- agent-facing
  app.post("/intents", wrap(async (req, res) => res.json(await fw.submit(req.body ?? {}))));
  app.get("/intents/:id", (req, res) => {
    const r = fw.getIntent(String(req.params.id));
    r ? res.json(r) : res.status(404).json({ error: "unknown intent" });
  });
  app.get("/services", (_req, res) => res.json(fw.registry.map(toListing)));
  app.get("/mandates/:id", (req, res) => {
    const m = fw.store.getMandate(String(req.params.id));
    m ? res.json(mandateView(m)) : res.status(404).json({ error: "unknown mandate" });
  });

  // ---------------------------------------------------------------- human/admin
  app.get("/mandates", admin, (_req, res) => res.json(fw.store.listMandates().map(mandateView)));
  app.post("/mandates", admin, wrap((req, res) => res.json(mandateView(fw.createMandate(req.body ?? {})))));
  app.post("/mandates/:id/:action", admin, (req, res) => {
    const action = req.params.action;
    if (action !== "complete" && action !== "revoke") return void res.status(404).json({ error: "unknown action" });
    const m = fw.setMandateStatus(String(req.params.id), action === "complete" ? "completed" : "revoked");
    m ? res.json(mandateView(m)) : res.status(404).json({ error: "unknown mandate" });
  });

  app.get("/approvals", admin, (_req, res) => res.json(fw.pendingApprovals()));
  app.post("/approvals/:id", admin, wrap(async (req, res) => {
    const r = await fw.resolveApproval(req.params.id as string, req.body?.approve === true, String(req.body?.by ?? "human"));
    r ? res.json(r) : res.status(404).json({ error: "no pending approval with that id" });
  }));

  app.get("/breaker", admin, (_req, res) => res.json(fw.breaker()));
  app.post("/breaker/reset", admin, (_req, res) => res.json(fw.resetBreaker()));
  app.get("/policy", admin, (_req, res) => res.json(policyView(fw.policy)));
  app.get("/ledger", admin, (req, res) => res.json(fw.store.recent(Math.min(Number(req.query.limit) || 200, 1000))));

  app.get("/events", admin, (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data, jsonReplacer)}\n\n`);
    const onDecision = (r: LedgerRow) => send("decision", r);
    const onBreaker = (b: unknown) => send("breaker", b);
    const onMandate = (m: Mandate) => send("mandate", mandateView(m));
    fw.on("decision", onDecision);
    fw.on("breaker", onBreaker);
    fw.on("mandate", onMandate);
    send("hello", { breaker: fw.breaker() });
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      clearInterval(ping);
      fw.off("decision", onDecision);
      fw.off("breaker", onBreaker);
      fw.off("mandate", onMandate);
    });
  });

  if (opts.staticDir) app.use("/", express.static(opts.staticDir));
  return app;
}
