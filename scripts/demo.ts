// One-command demo (F31): the firewall (which also serves the dashboard) and both vendors, in one terminal.
//
//   npm run demo
//
// Each process's output is prefixed with its name. When everything answers, the dashboard URL (admin token
// included) is printed. Ctrl-C stops all of them; if one of them dies, the others are stopped too.
// Stage the §8 scenes from a second terminal with `npm run demo:scene -- <n>`.
//
// Credentials stay where they were: the firewall loads .env itself, as `npm run firewall` does. This script
// reads .env only for the admin token and ports, and the vendors (stand-ins for third parties) get only their
// own VENDOR_* settings, never the wallet credentials.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parse } from "dotenv";
import { REPO_ROOT } from "@asf/shared";
import { FORBIDDEN_ENV } from "@asf/agent/env";

const envPath = resolve(REPO_ROOT, ".env");
const file = existsSync(envPath) ? parse(readFileSync(realpathSync(envPath))) : {};
const setting = (name: string, fallback?: string) => process.env[name] || file[name] || fallback;

const firewallPort = Number(setting("FIREWALL_PORT", "4020"));
const shadyPort = Number(setting("VENDOR_SHADY_PORT", "4022"));
const honestPort = Number(setting("VENDOR_HONEST_PORT", "4021"));

let adminToken = setting("FIREWALL_ADMIN_TOKEN");
const tokenGenerated = !adminToken;
adminToken ??= randomBytes(16).toString("hex");

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => paint(1, s);
const dim = (s: string) => paint(2, s);

type Proc = { name: string; tint: number; script: string; env: NodeJS.ProcessEnv };

const vendorEnv: NodeJS.ProcessEnv = { ...process.env };
for (const k of [...FORBIDDEN_ENV, "CIRCLE_FIREWALL_WALLET_ADDRESS", "ANTHROPIC_API_KEY"]) delete vendorEnv[k];
for (const [k, v] of Object.entries(file)) if (k.startsWith("VENDOR_") && !vendorEnv[k]) vendorEnv[k] = v;

const procs: Proc[] = [
  { name: "firewall", tint: 36, script: "packages/firewall/src/main.ts", env: { ...process.env, FIREWALL_ADMIN_TOKEN: adminToken } },
  { name: "vendors", tint: 35, script: "packages/vendors/src/main.ts", env: vendorEnv },
];
const width = Math.max(...procs.map((p) => p.name.length));

const children: ChildProcess[] = [];
let stopping = false;

function say(line: string) {
  console.log(`${paint(33, "demo".padEnd(width))} │ ${line}`);
}

function start(p: Proc): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", resolve(REPO_ROOT, p.script)], {
    cwd: REPO_ROOT, env: { ...p.env, FORCE_COLOR: color ? "1" : "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const tag = `${paint(p.tint, p.name.padEnd(width))} │ `;
  for (const stream of [child.stdout!, child.stderr!]) {
    createInterface({ input: stream }).on("line", (line) => {
      // The firewall prints its own dashboard line; ours (below) carries the vendor URL too, so hide the duplicate.
      if (p.name === "firewall" && line.startsWith("dashboard: ")) return;
      console.log(tag + line);
    });
  }
  child.on("exit", (code, sig) => {
    if (stopping) return;
    // Ctrl-C in the terminal signals every process in the group, so a child can exit before our handler runs.
    if (sig === "SIGINT" || code === 130) { void stop(0); return; }
    say(paint(31, `${p.name} exited (${sig ?? `code ${code}`}); stopping the demo`));
    void stop(1);
  });
  return child;
}

async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  const alive = children.filter((c) => c.exitCode === null && c.signalCode === null);
  await Promise.all(alive.map((c) => new Promise<void>((ok) => {
    const kill = setTimeout(() => c.kill("SIGKILL"), 4000);
    c.once("exit", () => { clearTimeout(kill); ok(); });
    c.kill("SIGTERM");
  })));
  process.exit(code);
}

process.on("SIGINT", () => { if (!stopping) { console.log(); say("stopping…"); } void stop(0); });
process.on("SIGTERM", () => void stop(0));

async function up(url: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopping) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return true;
    } catch { /* not yet */ }
    await new Promise((ok) => setTimeout(ok, 300));
  }
  return false;
}

say(`starting ${procs.map((p) => p.name).join(" and ")}…`);
for (const p of procs) children.push(start(p));

const checks = [
  ["firewall", `http://127.0.0.1:${firewallPort}/services`],
  ["honest vendor", `http://127.0.0.1:${honestPort}/health`],
  ["shady vendor", `http://127.0.0.1:${shadyPort}/health`],
] as const;
const results = await Promise.all(checks.map(([, url]) => up(url)));
if (stopping) await new Promise(() => {}); // a child died; stop() is exiting
const down = checks.filter((_, i) => !results[i]).map(([name]) => name);
if (down.length) {
  say(paint(31, `${down.join(", ")} did not come up within 30 s`));
  await stop(1);
}

const vendorParam = `&vendor=${encodeURIComponent(`http://127.0.0.1:${shadyPort}`)}`;
const dashboard = `http://127.0.0.1:${firewallPort}/#token=${adminToken}${shadyPort === 4022 ? "" : vendorParam}`;
const lines = [
  "",
  bold("Agent Spending Firewall demo is up."),
  `  dashboard  ${paint(4, dashboard)}`,
  `  scenes     ${bold("npm run demo:scene -- <n>")} in another terminal ${dim("(add --dry to script the model: no Anthropic credit)")}`,
  `             2 happy path · 3 prompt injection · 4 lying vendor · 5 runaway loop · 6 task ended`,
  `  stop       Ctrl-C`,
];
if (tokenGenerated) {
  lines.push("", paint(33, "FIREWALL_ADMIN_TOKEN is not set, so this run uses a random one. demo:scene and npm run task need"),
    paint(33, "the same token: add FIREWALL_ADMIN_TOKEN to .env (any random string) and restart."));
}
for (const l of lines) say(l);
