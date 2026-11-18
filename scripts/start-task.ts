// Start one task (F17, F18):
//   npm run task -- "<task>" [--budget 0.50] [--ttl 600] [--allow-transfers] [--dry <playbook>]
//   npm run task -- --unsafe "<task>"        same task, no firewall (baseline for the demo)
//
// Creates the mandate, runs the agent with a clean environment, and closes the mandate when it exits
// (scripts/lib/task.ts). --dry swaps Claude for a scripted playbook (packages/agent/src/dry.ts).
import { parseArgs } from "node:util";
import { runTask } from "./lib/task.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    budget: { type: "string" },
    ttl: { type: "string" },
    "allow-transfers": { type: "boolean", default: false },
    unsafe: { type: "boolean", default: false },
    dry: { type: "string" },
  },
});
const task = positionals.join(" ").trim();
if (!task) {
  console.error('usage: npm run task -- "<task>" [--budget 0.50] [--ttl 600] [--allow-transfers] [--unsafe] [--dry <playbook>]');
  process.exit(1);
}

const { code } = await runTask({
  task,
  budget: values.budget,
  ttlSeconds: values.ttl ? Number(values.ttl) : undefined,
  allowTransfers: values["allow-transfers"],
  unsafe: values.unsafe,
  dry: values.dry,
});
process.exitCode = code;
