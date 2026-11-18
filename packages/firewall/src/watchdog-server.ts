// The QuickNode Streams webhook. It runs on its own port (WATCHDOG_PORT, default 4023), separate from the
// firewall API, so the tunnel that makes it reachable from the internet exposes exactly one route: this one.
// The agent API (/intents) and the admin API stay on 127.0.0.1:4020 and are never tunnelled.
//
//   POST /quicknode   a signed Streams delivery → 200 { outflows, alerts } | 401 bad signature | 400 bad JSON
//
// Only deliveries signed with the stream's security token are read; anything else is refused before parsing.
import express from "express";
import { verifyQuickNode, type Watchdog } from "./watchdog.ts";

export type WatchdogServerOptions = { securityToken: string; log?: (msg: string) => void };

export function createWatchdogApp(wd: Watchdog, opts: WatchdogServerOptions) {
  if (!opts.securityToken) throw new Error("watchdog: a QuickNode security token is required");
  const log = opts.log ?? ((m) => console.log(m));
  const app = express();
  app.disable("x-powered-by");
  // Raw text, so the signature is checked over exactly the bytes QuickNode signed. `inflate` (on by
  // default) undoes Content-Encoding: gzip first; QuickNode signs the decoded body.
  app.use(express.text({ type: () => true, limit: "10mb" }));

  app.post("/quicknode", (req, res) => {
    const body = typeof req.body === "string" ? req.body : "";
    const ok = verifyQuickNode(opts.securityToken, {
      nonce: req.header("x-qn-nonce"), timestamp: req.header("x-qn-timestamp"), signature: req.header("x-qn-signature"),
    }, body);
    if (!ok) {
      log(`watchdog: refused an unsigned or mis-signed webhook from ${req.ip}`);
      return void res.status(401).json({ error: "bad signature" });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return void res.status(400).json({ error: "body is not JSON" });
    }
    const events = wd.ingest(payload);
    for (const e of events) {
      const v = e.verdict;
      log(v.status === "alert" ? `watchdog ALERT ${v.rule}: ${v.detail}` : `watchdog: ${e.txHash} → ${v.status}`);
    }
    res.json({ outflows: events.length, alerts: events.filter((e) => e.verdict.status === "alert").length });
  });

  app.use((_req, res) => void res.status(404).json({ error: "not found" }));
  return app;
}
