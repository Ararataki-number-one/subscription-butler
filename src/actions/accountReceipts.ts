"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { accountReceipt, space } from "@/db/schema";
import { getCurrencyMinorUnit } from "@/db/currencies";
import { getRate } from "@/db/fxRates";
import { ensureFreshRates } from "@/lib/fx/frankfurter";
import { freezeUsdMinor } from "@/lib/money";
import { accountReceiptSchema } from "@/lib/validation/accountReceipt";

type Result = { ok: true } | { ok: false; error: string };
function revalidate(spaceId: number) {
  revalidatePath("/");
  revalidatePath("/spaces");
  revalidatePath(`/spaces/${spaceId}`);
}

export async function saveAccountReceipt(input: unknown): Promise<Result> {
  const parsed = accountReceiptSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "收款信息无效。" };
  const data = parsed.data;
  const owner = db.select().from(space).where(eq(space.id, data.spaceId)).get();
  if (!owner || owner.planType === "team") return { ok: false, error: "请选择有效的独立账号。" };
  const existing = data.id
    ? db.select().from(accountReceipt).where(eq(accountReceipt.id, data.id)).get() : undefined;
  if (data.id && (!existing || existing.spaceId !== data.spaceId)) {
    return { ok: false, error: "收款记录不存在或不属于当前账号。" };
  }
  const minorUnit = getCurrencyMinorUnit(db, data.currencyCode);
  if (minorUnit === undefined) return { ok: false, error: "请选择有效币种。" };
  let snapshot = existing && {
    rateUsed: existing.rateUsed, rateAsOf: existing.rateAsOf,
    rateSource: existing.rateSource, amountUsd: existing.amountUsd,
  };
  if (!existing || existing.amountMinor !== data.amountMinor || existing.currencyCode !== data.currencyCode) {
    await ensureFreshRates();
    const rate = getRate(db, data.currencyCode);
    if (!rate) return { ok: false, error: "该币种暂无汇率，请先刷新汇率。" };
    const amountUsd = freezeUsdMinor(data.amountMinor, minorUnit, rate.rateToUsd);
    if (!Number.isSafeInteger(amountUsd)) return { ok: false, error: "金额过大。" };
    snapshot = {
      rateUsed: rate.rateToUsd, rateAsOf: rate.quoteDate ?? rate.fetchedAt,
      rateSource: rate.source, amountUsd,
    };
  }
  if (!snapshot) return { ok: false, error: "无法计算收款金额。" };
  const values = {
    spaceId: data.spaceId, receivedDate: data.receivedDate, amountMinor: data.amountMinor,
    currencyCode: data.currencyCode, payer: data.payer, note: data.note, ...snapshot,
  };
  const result = db.transaction((tx): Result => {
    const current = tx.select().from(space).where(eq(space.id, data.spaceId)).get();
    if (!current || current.planType === "team") return { ok: false, error: "账号类型已变化，请刷新页面。" };
    if (data.id) {
      const updated = tx.update(accountReceipt).set(values).where(eq(accountReceipt.id, data.id)).returning().get();
      if (!updated) return { ok: false, error: "收款记录已不存在。" };
    } else tx.insert(accountReceipt).values(values).run();
    return { ok: true };
  });
  if (result.ok) revalidate(data.spaceId);
  return result;
}

export async function deleteAccountReceipt(input: unknown): Promise<Result> {
  const parsed = z.number().int().positive().safeParse(input);
  if (!parsed.success) return { ok: false, error: "无效的收款记录。" };
  const row = db.delete(accountReceipt).where(eq(accountReceipt.id, parsed.data)).returning().get();
  if (!row) return { ok: false, error: "收款记录不存在。" };
  revalidate(row.spaceId);
  return { ok: true };
}
