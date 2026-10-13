// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { z } from "zod";
import { recalculateChannelCosts } from "@/db/paymentFees";
import { channelSchema, channelIdSchema } from "@/lib/validation/channel";
import {
  insertChannel,
  getChannel,
  updateChannelRow,
  setChannelActive,
  findActiveByName,
} from "@/db/channels";

/**
 * REF-01 — payment-channel Server Actions (the walking skeleton's real write).
 *
 * Security (T-03-INPUT / T-03-MASS / T-03-SQLI / T-03-DEL):
 * - Every action re-parses its input with Zod server-side — Server Actions are
 *   public endpoints, so client RHF validation is never trusted here.
 * - Only the known `name` / `id` fields are parsed (no mass-assignment).
 * - All DB access goes through parameterized Drizzle helpers; there is NO
 *   hard-delete path — removal is a uniform soft-delete (D-06).
 */

const CHANNELS_PATH = "/reference-data/channels";
function revalidateChannels() {
  revalidatePath(CHANNELS_PATH);
  revalidatePath("/spaces");
  revalidatePath("/spaces/[id]", "page");
  revalidatePath("/");
}

export type ChannelActionResult = { ok: true } | { ok: false; error: string };

export async function addChannel(input: unknown): Promise<ChannelActionResult> {
  const parsed = channelSchema.safeParse(typeof input === "string" ? { name: input } : input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "请输入渠道名称。" };
  }
  if (findActiveByName(db, parsed.data.name)) {
    return { ok: false, error: "已存在同名的有效渠道。" };
  }
  insertChannel(db, parsed.data.name, parsed.data);
  revalidateChannels();
  return { ok: true };
}

export async function renameChannel(
  id: number,
  name: string,
): Promise<ChannelActionResult> {
  return updateChannel(id, { name });
}

export async function updateChannel(id: number, input: unknown): Promise<ChannelActionResult> {
  const parsedId = channelIdSchema.safeParse({ id });
  if (!parsedId.success) {
    return { ok: false, error: "无效的渠道。" };
  }
  const current = getChannel(db, parsedId.data.id);
  if (!current) return { ok: false, error: "渠道不存在，请刷新页面。" };
  const parsedName = channelSchema.safeParse(input);
  if (!parsedName.success) {
    return {
      ok: false,
      error: parsedName.error.issues[0]?.message ?? "请输入渠道名称。",
    };
  }
  const duplicate = findActiveByName(db, parsedName.data.name);
  if (current.isActive && duplicate && duplicate.id !== parsedId.data.id) {
    return { ok: false, error: "已存在同名的有效渠道。" };
  }
  try {
    db.transaction(tx => {
      updateChannelRow(tx, parsedId.data.id, parsedName.data);
      if (parsedName.data.feePercent !== undefined && parsedName.data.feePercent !== current.feePercent) {
        recalculateChannelCosts(tx, current.id, parsedName.data.feePercent);
      }
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "手续费计算失败，修改未保存。" };
  }
  revalidateChannels();
  return { ok: true };
}

export async function archiveChannel(id: number): Promise<ChannelActionResult> {
  const parsedId = channelIdSchema.safeParse({ id });
  if (!parsedId.success) {
    return { ok: false, error: "无效的渠道。" };
  }
  // Soft-delete only (D-06): flip is_active; the row is preserved.
  if (!getChannel(db, parsedId.data.id)) return { ok: false, error: "渠道不存在，请刷新页面。" };
  setChannelActive(db, parsedId.data.id, false);
  revalidateChannels();
  return { ok: true };
}

export async function reactivateChannel(
  id: number,
): Promise<ChannelActionResult> {
  const parsedId = channelIdSchema.safeParse({ id });
  if (!parsedId.success) {
    return { ok: false, error: "无效的渠道。" };
  }
  const current = getChannel(db, parsedId.data.id);
  if (!current) return { ok: false, error: "渠道不存在，请刷新页面。" };
  const duplicate = findActiveByName(db, current.name);
  if (duplicate && duplicate.id !== current.id) {
    return { ok: false, error: "已有同名的可用渠道，请先编辑此渠道名称再恢复。" };
  }
  setChannelActive(db, parsedId.data.id, true);
  revalidateChannels();
  return { ok: true };
}

export async function setChannelFavorite(id: number, favorite: unknown): Promise<ChannelActionResult> {
  const parsed = z.object({ id: z.number().int().positive(), favorite: z.boolean() }).safeParse({ id, favorite });
  if (!parsed.success) return { ok: false, error: "无效的渠道设置。" };
  const current = getChannel(db, parsed.data.id);
  if (!current) return { ok: false, error: "渠道不存在，请刷新页面。" };
  if (!current.isActive) return { ok: false, error: "请先恢复渠道，再设置常用。" };
  updateChannelRow(db, current.id, { isFavorite: parsed.data.favorite });
  revalidateChannels();
  return { ok: true };
}
