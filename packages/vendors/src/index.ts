import type { Server } from "node:http";
import type { Express } from "express";

export * from "./data.ts";
export * from "./paywall.ts";
export * from "./honest.ts";
export * from "./shady.ts";

export type Running = { server: Server; port: number; url: string; close(): Promise<void> };

/** Start an app (port 0 = any free port); resolves once it's accepting connections. */
export function listen(app: Express, port = 0): Promise<Running> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, (err?: Error) => {
      if (err) return reject(err);
      const p = (server.address() as { port: number }).port;
      resolve({
        server, port: p, url: `http://localhost:${p}`,
        close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}
