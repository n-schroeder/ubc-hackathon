// Stage server: serves the recording stage page and runs real commands in a pty, streaming output over SSE.
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.REPO;
const env = Object.fromEntries(readFileSync(resolve(REPO, ".env"), "utf8").split("\n")
  .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const TOKEN = env.FIREWALL_ADMIN_TOKEN;
const LOG = resolve(here, "runs.jsonl");

const clients = new Set();
let running = null; // { id, cmd, start, exit }
let lastRun = null;
const send = (ev, data) => { for (const c of clients) c.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); };

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".mjs": "text/javascript" };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/config") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ dash: `http://127.0.0.1:4020/#theme=dark&token=${TOKEN}` }));
  }
  if (url.pathname === "/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    clients.add(res); req.on("close", () => clients.delete(res));
    return;
  }
  if (url.pathname === "/run" && req.method === "POST") {
    let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
      const { cmd, cols = 100, rows = 40, show } = JSON.parse(body);
      const id = Date.now();
      running = { id, cmd, start: Date.now(), exit: null };
      send("cmd", { show: show ?? cmd });
      appendFileSync(LOG, JSON.stringify({ t: Date.now(), id, ev: "start", cmd }) + "\n");
      const child = spawn("python3", [resolve(here, "ptyrun.py"), String(cols), String(rows), cmd], {
        cwd: REPO, env: { ...process.env, FORCE_COLOR: "1", TERM: "xterm-256color" },
      });
      const out = (d) => {
        const s = String(d);
        send("out", s);
        appendFileSync(LOG, JSON.stringify({ t: Date.now(), id, ev: "out", s }) + "\n");
      };
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", out); child.stderr.on("data", out);
      child.on("exit", (code) => {
        running.exit = code; lastRun = running; running = null;
        appendFileSync(LOG, JSON.stringify({ t: Date.now(), id, ev: "exit", code }) + "\n");
        send("exit", { code });
      });
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id }));
    });
    return;
  }
  if (url.pathname === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ running: !!running, last: lastRun }));
  }
  let p = url.pathname === "/" ? "/stage.html" : url.pathname;
  const f = p.startsWith("/xterm/") ? resolve(here, "node_modules/@xterm", p.slice(7)) : resolve(here, "." + p);
  if (!f.startsWith(here) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" });
  res.end(readFileSync(f));
}).listen(4030, "127.0.0.1", () => console.log("stage on http://127.0.0.1:4030"));
