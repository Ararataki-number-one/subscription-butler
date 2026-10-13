// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
import { z } from "zod";
import { SEAT_USAGE_STATUSES } from "@/lib/seat-usage";

export const seatTypeSchema = z.enum(["codex", "chatgpt"]);
export const billingPeriodUnitSchema = z.enum(["month", "quarter", "year"]);

export const rentalDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "请输入有效的加入日期。")
  .refine(value => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }, "请输入有效的加入日期。");

export const childAccountFormSchema = z
  .object({
    seatType: seatTypeSchema,
    usageStatus: z.enum(SEAT_USAGE_STATUSES).optional(),
    email: z.string().trim().min(1, "请输入子账号邮箱/登录名。"),
    contact: z.string().trim(),
    label: z.string().trim(),
    joinedDate: rentalDateSchema,
    monthlyAmountMinor: z.number().int().nonnegative("请输入有效的订阅金额。"),
    monthlyCurrencyCode: z.string().length(3, "请选择有效的订阅币种。"),
    monthlyPaymentDay: z
      .number()
      .int("付款日必须是整数。")
      .min(1, "付款日必须在 1 到 31 之间。")
      .max(31, "付款日必须在 1 到 31 之间。"),
    billingPeriodUnit: billingPeriodUnitSchema,
    billingPeriodCount: z.number().int().positive(),
  })
  .refine(value => value.usageStatus !== "rented" || value.monthlyAmountMinor > 0,
    { message: "出租状态请输入正数约定收入。", path: ["monthlyAmountMinor"] })
  .refine(
    (value) =>
      (value.billingPeriodUnit === "month" &&
        [1, 6].includes(value.billingPeriodCount)) ||
      (value.billingPeriodUnit === "quarter" &&
        value.billingPeriodCount === 1) ||
      (value.billingPeriodUnit === "year" && value.billingPeriodCount === 1),
    { message: "请选择有效的订阅周期。", path: ["billingPeriodCount"] },
  );

export type SeatType = z.infer<typeof seatTypeSchema>;
export type ChildAccountFormInput = z.infer<typeof childAccountFormSchema>;

export const childAccountIdSchema = z.object({
  id: z.number().int().positive(),
});
