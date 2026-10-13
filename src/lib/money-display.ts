import { convertUsdMinorToCurrencyMinor, formatMinor } from "./money";

export type CnyDisplayRate = { minorUnit: number; rateToUsd: string };

export function usdText(value: number | null): string | null {
  return value === null ? null : (value < 0 ? "-$" : "$") + formatMinor(Math.abs(value), 2);
}
export function cnyText(value: number | null, rate: CnyDisplayRate | null): string | null {
  if (value === null || !rate) return null;
  try {
    const amount = convertUsdMinorToCurrencyMinor(value, rate.minorUnit, rate.rateToUsd);
    if (!Number.isSafeInteger(amount)) return null;
    return (amount < 0 ? "-¥" : "¥") + formatMinor(Math.abs(amount), rate.minorUnit);
  } catch { return null; }
}
export function dualMoneyText(value: number | null, rate: CnyDisplayRate | null): string {
  if (value === null) return "待计算";
  return (cnyText(value, rate) ?? "人民币待换算") + "（" + usdText(value) + " USD）";
}
