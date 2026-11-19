import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "dotenv";
import { describe, expect, it } from "vitest";
import { setEnvKeys, updateEnvFile } from "../lib/env-file.ts";

const keys = (text: string) => text.split("\n").map((l) => /^(\w+)=/.exec(l)?.[1]).filter(Boolean);

describe("setEnvKeys", () => {
  it("fills existing empty lines in place and appends only missing keys", () => {
    const before = "# comment\nTEST_API_KEY=abc\nCIRCLE_FIREWALL_WALLET_ID=\nFIREWALL_ADMIN_TOKEN=\n";
    const after = setEnvKeys(before, { CIRCLE_FIREWALL_WALLET_ID: "w1", FIREWALL_ADMIN_TOKEN: "t", NEW_KEY: "n" }, "added by x");
    expect(after).toBe("# comment\nTEST_API_KEY=abc\nCIRCLE_FIREWALL_WALLET_ID=w1\nFIREWALL_ADMIN_TOKEN=t\n\n# --- added by x ---\nNEW_KEY=n\n");
  });

  it("collapses duplicates left by the old append-only setup", () => {
    const before = "A=\nB=keep\n\n# --- added by scripts/setup-wallets.ts ---\nA=old\n";
    const after = setEnvKeys(before, { A: "new" });
    expect(after).toBe("A=new\nB=keep\n\n# --- added by scripts/setup-wallets.ts ---\n");
    expect(parse(after)).toEqual({ A: "new", B: "keep" });
  });

  it("leaves commented-out keys alone and handles export, CRLF and an empty file", () => {
    expect(setEnvKeys("# A=1\nexport A=2\n", { A: "3" })).toBe("# A=1\nA=3\n");
    expect(setEnvKeys("A=\r\nB=1\r\n", { A: "x" })).toBe("A=x\r\nB=1\r\n");
    expect(setEnvKeys("", { A: "x" })).toBe("A=x\n");
    expect(setEnvKeys("B=1", { A: "x" }, "h")).toBe("B=1\n\n# --- h ---\nA=x\n");
  });

  it("gives .env.example + setup values with no duplicate keys", () => {
    const example = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
    const after = setEnvKeys(example, {
      CIRCLE_WALLET_SET_ID: "s", CIRCLE_FIREWALL_WALLET_ID: "w", CIRCLE_FIREWALL_WALLET_ADDRESS: "0xa",
      BASELINE_PRIVATE_KEY: "0xk", BASELINE_ADDRESS: "0xb", FIREWALL_ADMIN_TOKEN: "t",
    }, "added by scripts/setup-wallets.ts");
    const k = keys(after);
    expect(new Set(k).size).toBe(k.length);
    expect(keys(example)).toEqual(k); // every key already had a line: nothing appended
    expect(parse(after).FIREWALL_ADMIN_TOKEN).toBe("t");
  });
});

describe("updateEnvFile", () => {
  it("writes through a symlinked .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-file-"));
    writeFileSync(join(dir, "real.env"), "A=\n");
    symlinkSync(join(dir, "real.env"), join(dir, ".env"));
    updateEnvFile(join(dir, ".env"), { A: "1" });
    expect(readFileSync(join(dir, "real.env"), "utf8")).toBe("A=1\n");
  });
});
