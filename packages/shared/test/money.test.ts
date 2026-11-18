import { describe, expect, it } from "vitest";
import { formatUsdc, nativeToUsdc, parseBaseUnits, parseUsdc, usd, usdcToNative } from "../src/money.ts";

describe("money", () => {
  it("parses decimal USDC into 6-decimal base units", () => {
    expect(parseUsdc("1")).toBe(1_000_000n);
    expect(parseUsdc("0.001")).toBe(1_000n);
    expect(parseUsdc("$0.25")).toBe(250_000n);
    expect(parseUsdc(" 12.345678 ")).toBe(12_345_678n);
  });
  it("rejects anything that is not a plain non-negative decimal (fail closed)", () => {
    for (const bad of ["", "-1", "1e3", "0.0000001", "abc", "1,000", "NaN", "1.2.3"]) expect(() => parseUsdc(bad)).toThrow();
  });
  it("formats base units", () => {
    expect(formatUsdc(1_000n)).toBe("0.001");
    expect(formatUsdc(5_000_000n)).toBe("5.00");
    expect(formatUsdc(1_500_000n)).toBe("1.50");
    expect(formatUsdc(-250_000n)).toBe("-0.25");
    expect(usd(10_000n)).toBe("$0.01");
  });
  it("round-trips", () => {
    for (const s of ["0.000001", "0.01", "1.234567", "999999.99"]) expect(formatUsdc(parseUsdc(s))).toBe(s);
  });
  it("converts Arc's 18-decimal native balance without the 10^12 trap", () => {
    expect(nativeToUsdc(1_000_000_000_000_000_000n)).toBe(1_000_000n); // 1 USDC native → 1 USDC ERC-20
    expect(usdcToNative(1n)).toBe(1_000_000_000_000n);
  });
  it("parses x402 base-unit amounts strictly", () => {
    expect(parseBaseUnits("1000")).toBe(1000n);
    for (const bad of ["1.5", "-1", "0x10", ""]) expect(() => parseBaseUnits(bad)).toThrow();
  });
});
