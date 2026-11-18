// Regenerates the safety-limits tables in README.md from config/policy.json and config/registry.json.
//
//   npm run docs:limits            rewrite README.md
//   npm run docs:limits -- --check exit 1 if README.md is out of date
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "@asf/shared";
import { withLimits } from "./lib/limits-table.ts";

const path = resolve(REPO_ROOT, "README.md");
const before = readFileSync(path, "utf8");
const after = withLimits(before);

if (process.argv.includes("--check")) {
  if (before !== after) {
    console.error("README.md safety limits are out of date: run `npm run docs:limits`");
    process.exit(1);
  }
  console.log("README.md safety limits match config/");
} else if (before === after) {
  console.log("README.md safety limits already up to date");
} else {
  writeFileSync(path, after);
  console.log("README.md safety limits updated from config/");
}
