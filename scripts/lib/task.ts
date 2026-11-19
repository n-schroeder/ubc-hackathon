// The human side of a task, shared by `npm run task` and the demo scene runner (F17, F18, F31).
//
// 1. Creates a mandate on the firewall with the admin token (the agent never gets this token).
// 2. Launches the agent as a child process whose environment holds only PATH, HOME, TERM and the agent's own
//    variables, so none of the firewall's credentials can leak into it.
// 3. Marks the mandate completed when the agent exits, so nothing can spend against it afterwards.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { REPO_ROOT, optionalEnv, requireEnv } from "@asf/shared";
import { loadAgentEnv } from "@asf/agent/env";

export const firewallUrl = () => (optionalEnv("FIREWALL_URL") ?? `http://127.0.0.1:${optionalEnv("FIREWALL_PORT", "4020")}`).replace(/\/+$/, "");

/** An admin call to the firewall (x-admin-token from FIREWALL_ADMIN_TOKEN). */
export async function admin<T = any>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const res = await fetch(firewallUrl() + path, {
    method,
    headers: { "content-type": "application/json", "x-admin-token": requireEnv("FIREWALL_ADMIN_TOKEN") },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`firewall ${method} ${path} → HTTP ${res.status}: ${json.error ?? "error"}`);
  return json as T;
}

/** Run the agent CLI in a child process with a clean environment. Resolves with its exit code. */
export function runAgentProcess(args: string[]): Promise<number> {
  // Only what the agent may see. loadAgentEnv keeps just the AGENT_ENV names.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TERM: process.env.TERM, ...loadAgentEnv() };
  if (!args.includes("--unsafe")) env.FIREWALL_URL = firewallUrl();
  if (process.env.FORCE_COLOR) env.FORCE_COLOR = process.env.FORCE_COLOR;
  const child = spawn(process.execPath, ["--import", "tsx", resolve(REPO_ROOT, "packages/agent/src/main.ts"), ...args], {
    cwd: REPO_ROOT, env, stdio: "inherit",
  });
  // Ctrl-C reaches the child through the terminal; keep this process alive until it exits so cleanup runs.
  const forward = (sig: NodeJS.Signals) => { if (child.exitCode === null) child.kill(sig); };
  process.on("SIGINT", forward).on("SIGTERM", forward);
  return new Promise((ok) => child.on("exit", (code, sig) => {
    process.off("SIGINT", forward).off("SIGTERM", forward);
    ok(code ?? (sig ? 130 : 1));
  }));
}

export type TaskOptions = {
  task: string;
  budget?: string;
  ttlSeconds?: number;
  allowTransfers?: boolean;
  /** No firewall: the baseline agent pays directly from BASELINE_PRIVATE_KEY (F22). */
  unsafe?: boolean;
  /** Scripted model playbook instead of Claude (packages/agent/src/dry.ts). */
  dry?: string;
};

export type TaskRun = { code: number; mandateId?: string };

export async function runTask(o: TaskOptions): Promise<TaskRun> {
  const extra = o.dry ? ["--dry", o.dry] : [];
  if (o.unsafe) return { code: await runAgentProcess(["--unsafe", "--task", o.task, ...extra]) };

  const m = await admin("/mandates", { task: o.task, budget: o.budget, ttlSeconds: o.ttlSeconds, allowTransfers: o.allowTransfers ?? false });
  console.log(`mandate ${m.id} created: ${m.budget} USDC until ${m.expiresAt}${m.allowTransfers ? ", transfers allowed" : ""}`);
  let code = 1;
  try {
    code = await runAgentProcess(["--mandate", m.id, ...extra]);
  } finally {
    const done = await admin(`/mandates/${m.id}/complete`, {}).catch((e) => ({ error: (e as Error).message }));
    console.log(done.error ? `could not close mandate ${m.id}: ${done.error}` : `mandate ${m.id} closed (spent ${done.spent} of ${done.budget} USDC)`);
  }
  return { code, mandateId: m.id };
}
