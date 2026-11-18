// npm run redteam [-- --details] [-- <scenario id or problem, e.g. P2>]
// Exit code 1 if any scenario fails.
import { parseArgs } from "node:util";
import { SCENARIOS } from "./scenarios.ts";
import { COLOR, PLAIN, render, runAll } from "./run.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { details: { type: "boolean", short: "d", default: false }, "no-color": { type: "boolean", default: false } },
});

const pick = positionals.length
  ? SCENARIOS.filter((s) => positionals.some((p) => p === s.id || p.toUpperCase() === s.problem))
  : SCENARIOS;
if (!pick.length) {
  console.error(`no scenario matches ${positionals.join(", ")}. Ids: ${SCENARIOS.map((s) => s.id).join(", ")}`);
  process.exit(2);
}

const results = await runAll(pick);
const color = process.stdout.isTTY && !values["no-color"] && !process.env.NO_COLOR;
console.log(render(results, color ? COLOR : PLAIN, { details: values.details }));
process.exitCode = results.every((r) => r.pass) ? 0 : 1;
