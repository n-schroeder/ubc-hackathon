// Sets keys in a .env file in place, so setup scripts don't leave duplicate KEY= lines behind.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";

const keyOf = (line: string) => /^\s*(?:export\s+)?([\w.-]+)\s*=/.exec(line)?.[1];

/**
 * Returns `text` with each key in `values` set: the key's first `KEY=` line is rewritten (later duplicates of
 * it are dropped, since dotenv would let them win), and keys with no line yet are appended at the end under
 * `# --- <header> ---`. Comments, blank lines and every other key are left as they are.
 */
export function setEnvKeys(text: string, values: Record<string, string>, header?: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  if (lines.at(-1) === "") lines.pop(); // the file's trailing newline
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = keyOf(line);
    if (key === undefined || !(key in values)) { out.push(line); continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${key}=${values[key]}`);
  }
  const missing = Object.keys(values).filter((k) => !seen.has(k));
  if (missing.length) {
    if (out.length && out.at(-1)!.trim() !== "") out.push("");
    if (header) out.push(`# --- ${header} ---`);
    for (const k of missing) out.push(`${k}=${values[k]}`);
  }
  return out.length ? out.join(eol) + eol : "";
}

/** setEnvKeys on a file (following a symlink, as a worktree's .env may be one). */
export function updateEnvFile(path: string, values: Record<string, string>, header?: string): void {
  const real = realpathSync(path);
  writeFileSync(real, setEnvKeys(readFileSync(real, "utf8"), values, header));
}
