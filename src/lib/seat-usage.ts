export const SEAT_USAGE_STATUSES = ["vacant", "self", "rented", "disabled"] as const;
export type SeatUsageStatus = (typeof SEAT_USAGE_STATUSES)[number];
export type EffectiveSeatUsageStatus = SeatUsageStatus | "unmarked";
export const SEAT_USAGE_LABELS: Record<EffectiveSeatUsageStatus, string> = {
  vacant: "空闲", self: "自用", rented: "出租", disabled: "停用", unmarked: "待标记",
};
export function childUsageStatus(row: {
  usageStatus?: SeatUsageStatus | null;
  monthlyRateSource: string;
  monthlyAmountMinor?: number;
}): SeatUsageStatus {
  return row.usageStatus ?? (row.monthlyRateSource === "self-use" || row.monthlyAmountMinor === 0 ? "self" : "rented");
}
/** Round once to cents; all monetary inputs stay safe integer minor units. */
export function monthlyEquivalent(amount: number, unit: string | null, count: number | null): number {
  const months = (unit === "year" ? 12 : unit === "quarter" ? 3 : 1) * (count ?? 1);
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(months) || months <= 0) throw new Error("Invalid monthly amount");
  const numerator = BigInt(Math.abs(amount));
  const divisor = BigInt(months);
  const rounded = (numerator * BigInt(2) + divisor) / (divisor * BigInt(2));
  return (amount < 0 ? -1 : 1) * Number(rounded);
}
