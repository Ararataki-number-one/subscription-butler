// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
import { z } from "zod";
import { CHANNEL_TYPES } from "@/lib/payment-channels";
import { parseToMinor } from "@/lib/money";

/**
 * REF-01 — shared channel-name validation (T-03-INPUT / T-03-MASS).
 *
 * Used by BOTH the client form (RHF `zodResolver`) and the Server Actions,
 * which re-parse server-side because Server Actions are public endpoints — the
 * client validation is convenience only, never a trust boundary (ASVS V5).
 * Parsing only the known `name` field also blocks mass-assignment.
 */
export const channelSchema = z.object({
  name: z.string().trim().min(1, "请输入渠道名称。").max(80, "渠道名称不能超过 80 字。"),
  channelType: z.enum(CHANNEL_TYPES).optional(),
  provider: z.string().trim().max(80, "平台名称不能超过 80 字。").optional(),
  identifier: z.string().trim().max(80, "辨认标记不能超过 80 字。").optional(),
  note: z.string().trim().max(1000, "备注不能超过 1000 字。").optional(),
  isFavorite: z.boolean().optional(),
  feePercent: z.string().trim()
    .regex(/^\d+(?:\.\d{1,2})?$/, "手续费百分比最多两位小数，例如 2.5。")
    .refine(value => {
      try { const rate = parseToMinor(value, 2); return Number.isSafeInteger(rate) && rate >= 0 && rate <= 10000; }
      catch { return false; }
    }, "请输入 0–100 之间的手续费百分比。").optional(),
});

export type ChannelInput = z.infer<typeof channelSchema>;

/** Surrogate-id schema for rename / archive / reactivate (D-05). */
export const channelIdSchema = z.object({
  id: z.number().int().positive(),
});
