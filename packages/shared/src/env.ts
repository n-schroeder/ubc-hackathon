// Loads the repo-root .env (it may be a symlink into the main checkout).
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

let loaded = false;
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const p = resolve(REPO_ROOT, ".env");
  if (existsSync(p)) config({ path: realpathSync(p), quiet: true });
}

export function requireEnv(name: string): string {
  loadEnv();
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env (see .env.example)`);
  return v;
}

export function optionalEnv(name: string, fallback?: string): string | undefined {
  loadEnv();
  return process.env[name] || fallback;
}
