import { freezeUsdMinor, parseToMinor } from "./money";

export function paymentFee(amountMinor: number, percent: string) {
  const basisPoints = parseToMinor(percent, 2);
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 ||
    !Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000) {
    throw new Error("请输入 0–100 之间的手续费百分比，最多两位小数。");
  }
  const fee = (BigInt(amountMinor) * BigInt(basisPoints) + BigInt(5000)) / BigInt(10000);
  const total = BigInt(amountMinor) + fee;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("含手续费金额过大。");
  return { feeAmountMinor: Number(fee), totalAmountMinor: Number(total) };
}

export function paymentCost(input: {
  amountMinor: number; baseAmountUsd: number | null; percent: string;
  minorUnit: number; rateUsed: string | null;
}) {
  const fee = paymentFee(input.amountMinor, input.percent);
  const amountUsd = input.baseAmountUsd === null ? null : fee.feeAmountMinor === 0 ? input.baseAmountUsd
    : input.rateUsed ? freezeUsdMinor(fee.totalAmountMinor, input.minorUnit, input.rateUsed) : null;
  if (amountUsd !== null && !Number.isSafeInteger(amountUsd)) throw new Error("含手续费金额过大。");
  return { ...fee, amountUsd, feePercent: input.percent, baseAmountUsd: input.baseAmountUsd };
}
