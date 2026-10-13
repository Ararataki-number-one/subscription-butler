import { describe, expect, it } from "vitest";
import { paymentFee, paymentCost } from "./payment-fees";

describe("percentage payment fees", () => {
  it("adds 2.5 percent to a 100.00 subscription without floating-point rounding", () => {
    expect(paymentFee(10000, "2.5")).toEqual({ feeAmountMinor: 250, totalAmountMinor: 10250 });
    expect(paymentCost({ amountMinor: 10000, baseAmountUsd: 2000, percent: "2.5", minorUnit: 2, rateUsed: "0.2" }))
      .toMatchObject({ feeAmountMinor: 250, amountUsd: 2050 });
  });
  it("rounds the fee in the original currency's minor units, including zero-decimal currencies", () => {
    expect(paymentFee(19, "2.5")).toEqual({ feeAmountMinor: 0, totalAmountMinor: 19 });
    expect(paymentFee(20, "2.5")).toEqual({ feeAmountMinor: 1, totalAmountMinor: 21 });
    expect(paymentCost({ amountMinor: 6000, baseAmountUsd: 3000, percent: "1.5", minorUnit: 0, rateUsed: "0.005" }).amountUsd).toBe(3045);
  });
  it("preserves unknown costs and exact saved USD amounts for a zero fee", () => {
    expect(paymentCost({ amountMinor: 10000, baseAmountUsd: null, percent: "5", minorUnit: 2, rateUsed: null }).amountUsd).toBeNull();
    expect(paymentCost({ amountMinor: 10000, baseAmountUsd: 1911, percent: "0", minorUnit: 2, rateUsed: null }).amountUsd).toBe(1911);
  });
  it("rejects unsafe totals, negative or excessively precise percentages", () => {
    for (const rate of ["-1", "100.01", "2.555", "NaN"]) expect(() => paymentFee(10000, rate)).toThrow();
    expect(() => paymentFee(Number.MAX_SAFE_INTEGER, "1")).toThrow();
    expect(paymentFee(10000, "0.01").feeAmountMinor).toBe(1);
  });
});
