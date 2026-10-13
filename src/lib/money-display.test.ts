import { describe, expect, it } from "vitest";
import { cnyText, dualMoneyText, usdText } from "./money-display";

describe("CNY-first money display", () => {
  const rate = { minorUnit: 2, rateToUsd: "0.2" };
  it("converts USD minor units to the reciprocal CNY rate", () => {
    expect(cnyText(10000, rate)).toBe("¥500.00");
    expect(dualMoneyText(10000, rate)).toBe("¥500.00（$100.00 USD）");
    expect(usdText(10000)).toBe("$100.00");
  });
  it("preserves a negative profit sign in both currencies", () => {
    expect(dualMoneyText(-939, rate)).toBe("-¥46.95（-$9.39 USD）");
    expect(cnyText(-1, { minorUnit: 2, rateToUsd: "0.15" })).toBe("-¥0.07");
  });
  it("rounds to the currency minor unit rather than exposing floating point noise", () => {
    expect(cnyText(1, { minorUnit: 2, rateToUsd: "0.15" })).toBe("¥0.07");
    expect(cnyText(300, { minorUnit: 2, rateToUsd: "0.3" })).toBe("¥10.00");
    expect(cnyText(0, rate)).toBe("¥0.00");
  });
  it("keeps USD visible when no trustworthy CNY rate is available", () => {
    expect(dualMoneyText(100, null)).toBe("人民币待换算（$1.00 USD）");
    expect(cnyText(100, { minorUnit: 2, rateToUsd: "0" })).toBeNull();
    expect(cnyText(100, { minorUnit: 2, rateToUsd: "invalid" })).toBeNull();
  });
  it("does not turn unknown amounts into zero", () => {
    expect(dualMoneyText(null, rate)).toBe("待计算");
    expect(cnyText(null, rate)).toBeNull();
    expect(usdText(null)).toBeNull();
  });
});
