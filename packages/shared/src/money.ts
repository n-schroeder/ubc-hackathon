// USDC money helpers. ALL amounts in this project are bigint USDC base units (6 decimals).
//
// Arc trap: the chain's *native* balance (gas) is the same USDC but reported with 18 decimals,
// while the USDC ERC-20 interface uses 6. Never mix them; convert with nativeToUsdc / usdcToNative.

export const USDC_DECIMALS = 6;
export const NATIVE_DECIMALS = 18;
const SCALE = 10n ** BigInt(USDC_DECIMALS);
const NATIVE_FACTOR = 10n ** BigInt(NATIVE_DECIMALS - USDC_DECIMALS); // 10^12

/** "0.001" | "$0.001" | "1" -> base units. Throws on anything else (fail closed). */
export function parseUsdc(input: string): bigint {
  const s = input.trim().replace(/^\$/, "");
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new Error(`Invalid USDC amount: "${input}"`);
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? "").padEnd(USDC_DECIMALS, "0"));
  return whole * SCALE + frac;
}

/** base units -> "0.001" (trailing zeros trimmed, at least 2 decimals). */
export function formatUsdc(units: bigint): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const whole = abs / SCALE;
  let frac = (abs % SCALE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** base units -> "$0.001" */
export const usd = (units: bigint) => `$${formatUsdc(units)}`;

/** Native 18-decimal balance -> 6-decimal USDC base units (truncates dust below 1e-6). */
export const nativeToUsdc = (native: bigint) => native / NATIVE_FACTOR;
export const usdcToNative = (units: bigint) => units * NATIVE_FACTOR;

/** Parse an amount that arrived as a base-unit integer string (e.g. x402 `amount`). */
export function parseBaseUnits(input: string | number | bigint): bigint {
  const s = String(input).trim();
  if (!/^\d+$/.test(s)) throw new Error(`Invalid base-unit amount: "${s}"`);
  return BigInt(s);
}
