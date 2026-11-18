// Agent CLI.
//   npm run agent -- --mandate <id>                  the real product: every payment goes through the firewall
//   npm run agent -- --unsafe --task "<task text>"   baseline: the agent holds a key and pays directly (F22)
//   add --dry <playbook>                             scripted model instead of Claude (no API key, no credit);
//                                                     payments and firewall decisions stay real (see dry.ts)
//
// Usually started by `npm run task`, which creates the mandate and launches this with a clean environment.
import { parseArgs } from "node:util";
import { formatUsdc } from "@asf/shared";
import { DEFAULT_MODEL, anthropicMessages, runAgent, type Effort } from "./agent.ts";
import { FirewallBackend, type PaymentBackend } from "./backend.ts";
import { PLAYBOOKS, dryMessages } from "./dry.ts";
import { assertNoCredentials, loadAgentEnv, readEnvFileValue } from "./env.ts";
import { FirewallClient } from "./firewall-client.ts";
import { UnsafeBackend } from "./unsafe.ts";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

async function main() {
  const { values } = parseArgs({
    options: { mandate: { type: "string" }, unsafe: { type: "boolean", default: false }, task: { type: "string" }, dry: { type: "string" } },
  });

  // The agent must never see the firewall's credentials (engineering rule 10.1).
  assertNoCredentials();
  const env = loadAgentEnv();
  const dry = values.dry;
  if (dry !== undefined && !PLAYBOOKS[dry]) throw new Error(`--dry takes a playbook: ${Object.keys(PLAYBOOKS).join(", ")}`);
  if (dry === undefined && !env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (put it in .env, or run with --dry <playbook>)");
  const effort = (env.AGENT_EFFORT ?? "medium") as Effort;
  if (!EFFORTS.includes(effort)) throw new Error(`AGENT_EFFORT must be one of ${EFFORTS.join(", ")}`);
  const maxTurns = Number(env.AGENT_MAX_TURNS ?? 25);
  const model = env.AGENT_MODEL ?? DEFAULT_MODEL;

  let backend: PaymentBackend;
  let header: string;
  if (values.unsafe) {
    if (!values.task) throw new Error("--unsafe needs --task \"<task text>\" (there is no firewall to hold a mandate)");
    const key = readEnvFileValue("BASELINE_PRIVATE_KEY");
    if (!key) throw new Error("BASELINE_PRIVATE_KEY is missing from .env (run npm run wallets:setup)");
    const b = new UnsafeBackend(key, values.task);
    backend = b;
    header = `UNSAFE BASELINE: the agent holds wallet ${b.address} and pays directly. No firewall.\ntask: ${values.task}`;
  } else {
    if (!values.mandate) throw new Error("usage: npm run agent -- --mandate <id>   (or start a task with npm run task)");
    const fw = new FirewallClient(env.FIREWALL_URL ?? "http://localhost:4020");
    const m = await fw.getMandate(values.mandate);
    if (m.status !== "active") throw new Error(`mandate ${m.id} is ${m.status}`);
    backend = new FirewallBackend(fw, m.id);
    header = `mandate ${m.id}: budget ${m.budget} USDC, expires ${m.expiresAt}\ntask: ${m.task}`;
  }

  console.log(dry !== undefined
    ? `${header}\nmodel: SCRIPTED (--dry ${dry}). The agent's choices are scripted; every payment and firewall decision is real.`
    : `${header}\nmodel ${model} (effort ${effort}, server-side refusal fallbacks on), up to ${maxTurns} turns`);
  const messages = dry !== undefined ? dryMessages(dry) : anthropicMessages(env.ANTHROPIC_API_KEY!);
  const result = await runAgent({ messages, backend, model, effort, maxTurns });

  const u = result.usage;
  console.log(`\n— ${result.stop} after ${result.turns} turns, ${result.toolCalls} tool calls. ` +
    (dry !== undefined ? "no tokens (scripted)" : `tokens: ${u.input} in (+${u.cacheRead} cached, ${u.cacheWrite} cache-write), ${u.output} out`));
  if (backend instanceof UnsafeBackend) console.log(`— the baseline wallet spent ${formatUsdc(backend.spent)} USDC with no checks`);
  if (result.stop !== "done") process.exitCode = 2;
}

main().catch((e) => {
  console.error(`agent: ${(e as Error).message}`);
  process.exit(1);
});
