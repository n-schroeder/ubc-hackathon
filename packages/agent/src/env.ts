// The agent's environment. Engineering rule 10.1: the agent process never loads wallet credentials.
//
// The repo's .env also holds the firewall's Circle credentials and admin token, so the agent does NOT use
// @asf/shared's loadEnv() (which copies the whole file into process.env). It parses .env itself and keeps
// only the names on AGENT_ENV, and it refuses to start if a forbidden name is already in its environment.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { REPO_ROOT } from "@asf/shared";

/** Everything the agent may read. Only FIREWALL_URL relates to payments (SPEC §3.5). */
export const AGENT_ENV = ["ANTHROPIC_API_KEY", "FIREWALL_URL", "AGENT_MODEL", "AGENT_EFFORT", "AGENT_MAX_TURNS"] as const;
export type AgentEnv = Partial<Record<(typeof AGENT_ENV)[number], string>>;

/** Credentials that only the firewall (or the unsafe baseline) may hold. */
export const FORBIDDEN_ENV = [
  "TEST_API_KEY", "ENTITY_SECRET", "CIRCLE_WALLET_SET_ID", "CIRCLE_FIREWALL_WALLET_ID", "FIREWALL_ADMIN_TOKEN",
  "BASELINE_PRIVATE_KEY",
  // The watchdog's QuickNode credentials: with the API key an agent could pause the stream that watches it.
  "QUICKNODE_API_KEY", "QUICKNODE_STREAM_TOKEN",
] as const;

export function assertNoCredentials(env: NodeJS.ProcessEnv = process.env): void {
  const leaked = FORBIDDEN_ENV.filter((k) => env[k]);
  if (leaked.length) {
    throw new Error(`refusing to start: the agent's environment contains firewall credentials (${leaked.join(", ")}). ` +
      "Launch it with `npm run task` or `npm run agent`, which pass only the agent's own variables.");
  }
}

/** process.env wins over .env, but only for allowed names. */
export function loadAgentEnv(envFile = resolve(REPO_ROOT, ".env"), env: NodeJS.ProcessEnv = process.env): AgentEnv {
  const file = existsSync(envFile) ? parse(readFileSync(realpathSync(envFile))) : {};
  const out: AgentEnv = {};
  for (const k of AGENT_ENV) {
    const v = env[k] || file[k];
    if (v) out[k] = v;
  }
  return out;
}

/** Read a variable from .env without exposing the rest (used for BASELINE_PRIVATE_KEY in --unsafe only). */
export function readEnvFileValue(name: string, envFile = resolve(REPO_ROOT, ".env")): string | undefined {
  if (!existsSync(envFile)) return undefined;
  return parse(readFileSync(realpathSync(envFile)))[name] || undefined;
}
