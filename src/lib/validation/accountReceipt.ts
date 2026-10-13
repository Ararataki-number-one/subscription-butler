import { z } from "zod";

export const accountReceiptSchema = z.object({
  id: z.number().int().positive().optional(),
  spaceId: z.number().int().positive(),
  receivedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "请输入有效的收款日期。"),
  amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currencyCode: z.string().length(3),
  payer: z.string().trim().max(200).default(""),
  note: z.string().trim().max(1000).default(""),
});
