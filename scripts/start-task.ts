// The human side of a task (F17, F18):
//   npm run task -- "<task>" [--budget 0.50] [--ttl 600] [--allow-transfers]
//   npm run task -- --unsafe "<task>"        same task, no firewall (baseline for the demo)
//
// 1. Creates a mandate on the firewall with the admin token (the agent never gets this token).
// 2. Launches the agent as a child process whose environment holds only PATH, HOME and the agent's own
//    variables, so none of the firewall's credentials can leak into it.
// 3. Marks the mandate completed when the agent exits, so nothing can spend against it afterwards.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT, optionalEnv, requireEnv } from "@asf/shared";
import { loadAgentEnv } from "../packages/agent/src/env.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    budget: { type: "string" },
    ttl: { type: "string" },
    "allow-transfers": { type: "boolean", default: false },
    unsafe: { type: "boolean", default: false },
  },
});
const task = positionals.join(" ").trim();
if (!task) {
  console.error('usage: npm run task -- "<task>" [--budget 0.50] [--ttl 600] [--allow-transfers] [--unsafe]');
  process.exit(1);
}

const firewallUrl = (optionalEnv("FIREWALL_URL") ?? "http://localhost:4020").replace(/\/+$/, "");

async function admin(path: string, body: unknown) {
  const res = await fetch(firewallUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": requireEnv("FIREWALL_ADMIN_TOKEN") },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`firewall POST ${path} → HTTP ${res.status}: ${json.error ?? "error"}`);
  return json;
}

function runAgent(args: string[]): Promise<number> {
  // Only what the agent may see. loadAgentEnv keeps just the AGENT_ENV names.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TERM: process.env.TERM, ...loadAgentEnv() };
  if (!args.includes("--unsafe")) env.FIREWALL_URL = firewallUrl;
  const child = spawn(process.execPath, ["--import", "tsx", resolve(REPO_ROOT, "packages/agent/src/main.ts"), ...args], {
    cwd: REPO_ROOT, env, stdio: "inherit",
  });
  const forward = (sig: NodeJS.Signals) => child.kill(sig);
  process.on("SIGINT", forward).on("SIGTERM", forward);
  return new Promise((ok) => child.on("exit", (code, sig) => ok(code ?? (sig ? 130 : 1))));
}

if (values.unsafe) {
  process.exitCode = await runAgent(["--unsafe", "--task", task]);
} else {
  const m = await admin("/mandates", {
    task,
    budget: values.budget,
    ttlSeconds: values.ttl ? Number(values.ttl) : undefined,
    allowTransfers: values["allow-transfers"],
  });
  console.log(`mandate ${m.id} created: ${m.budget} USDC until ${m.expiresAt}${m.allowTransfers ? ", transfers allowed" : ""}`);
  let code = 1;
  try {
    code = await runAgent(["--mandate", m.id]);
  } finally {
    const done = await admin(`/mandates/${m.id}/complete`, {}).catch((e) => ({ error: (e as Error).message }));
    console.log(done.error ? `could not close mandate ${m.id}: ${done.error}` : `mandate ${m.id} closed (spent ${done.spent} of ${done.budget} USDC)`);
  }
  process.exitCode = code;
}
