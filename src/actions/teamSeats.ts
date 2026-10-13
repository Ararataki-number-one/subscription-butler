"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { motherAccount, childAccount } from "@/db/schema";
import { getSpaceDetail } from "@/db/spaces";
import { getCurrencyMinorUnit } from "@/db/currencies";
import { getRate } from "@/db/fxRates";
import { freezeUsdMinor } from "@/lib/money";
import { ensureFreshRates } from "@/lib/fx/frankfurter";
import { SEAT_USAGE_STATUSES } from "@/lib/seat-usage";
import { nextPaymentDueDate, renewPaymentDueDate, type PeriodUnit } from "@/lib/expiry";
import { rentalDateSchema } from "@/lib/validation/childAccount";
import { syncMotherRecord } from "@/db/accountRoles";
import { isProPlan, supportsMembers } from "@/lib/space-plans";

const schema = z.object({
  spaceId: z.number().int().positive(), role: z.enum(["mother", "child"]), id: z.number().int().positive(),
  usageStatus: z.enum(SEAT_USAGE_STATUSES),
  amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  currencyCode: z.string().length(3),
  billingPeriodUnit: z.enum(["month", "quarter", "year"]),
  billingPeriodCount: z.number().int().positive().max(120),
  email: z.string().trim().min(1, "请输入账号邮箱或登录名。").max(200).optional(),
  seatType: z.enum(["codex", "chatgpt"]).optional(),
  canChangeSeatType: z.boolean().optional(),
  contact: z.string().trim().max(200).optional(),
  label: z.string().trim().max(500).optional(),
  joinedDate: rentalDateSchema.nullable().optional(),
  monthlyPaymentDay: z.number().int().min(1).max(31).nullable().optional(),
}).refine(data => data.usageStatus !== "rented" || data.amountMinor > 0, "出租状态请输入正数约定收入。")
  .refine(data => data.billingPeriodUnit === "month" ? [1, 6].includes(data.billingPeriodCount)
    : data.billingPeriodCount === 1, "请选择有效的计费周期。");

export async function updateTeamSeat(input: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "席位信息无效。" };
  const data = parsed.data;
  const owner = getSpaceDetail(db, data.spaceId);
  if (!owner || (owner.space.planType !== "team" && !isProPlan(owner.space.planType))) return { ok: false, error: "请选择有效的 Business 或 Pro。" };
  if (data.role === "mother" && isProPlan(owner.space.planType)) return { ok: false, error: "Pro 只管理拼车成员。" };
  if (data.role === "child" && !supportsMembers(owner.space.planType, owner.space.sharingMode)) {
    return { ok: false, error: "当前 Pro 为单人使用，请先开启多人拼车。" };
  }
  const mother = data.role === "mother" ? owner.motherAccount : undefined;
  const child = data.role === "child" ? db.select().from(childAccount).where(eq(childAccount.id, data.id)).get() : undefined;
  if ((mother && mother.id !== data.id) || (!mother && (!child || child.spaceId !== data.spaceId))) {
    return { ok: false, error: "账号不属于当前订阅。" };
  }
  if (child?.isMotherAccount) return { ok: false, error: "该记录已归入母号，请编辑母号资料。" };
  const existing = mother ?? child!;
  const contact = data.contact ?? existing.contact;
  const joinedDate = data.joinedDate === undefined ? existing.joinedDate : data.joinedDate;
  const paymentDay = data.monthlyPaymentDay === undefined ? existing.monthlyPaymentDay : data.monthlyPaymentDay;
  if (data.usageStatus === "rented" && !contact) return { ok: false, error: "出租账号请输入联系方式。" };
  if ((joinedDate === null) !== (paymentDay === null) || (data.usageStatus === "rented" && (!joinedDate || !paymentDay))) {
    return { ok: false, error: "请填写加入日期和付款日。" };
  }
  if (child && (!joinedDate || !paymentDay)) return { ok: false, error: "请填写加入日期和付款日。" };
  const scheduleChanged = joinedDate !== existing.joinedDate || paymentDay !== existing.monthlyPaymentDay
    || data.billingPeriodUnit !== existing.billingPeriodUnit || data.billingPeriodCount !== existing.billingPeriodCount;
  const nextPaymentDate = joinedDate && paymentDay
    ? scheduleChanged || !existing.nextPaymentDate
      ? nextPaymentDueDate(paymentDay, { unit: data.billingPeriodUnit, count: data.billingPeriodCount }, joinedDate)
      : existing.nextPaymentDate
    : null;
  const oldAmount = mother?.expectedAmountMinor ?? child!.monthlyAmountMinor;
  const oldCurrency = mother?.expectedCurrencyCode ?? child?.monthlyCurrencyCode;
  const oldUsd = mother ? mother.expectedAmountUsd : child!.monthlyAmountUsd;
  let rateUsed = mother ? mother.expectedRateUsed : child!.monthlyRateUsed;
  let rateAsOf = mother ? mother.expectedRateAsOf : child!.monthlyRateAsOf;
  let rateSource = mother ? mother.expectedRateSource : child!.monthlyRateSource;
  let amountUsd = oldUsd;
  const minorUnit = getCurrencyMinorUnit(db, data.currencyCode);
  if (minorUnit === undefined) return { ok: false, error: "请选择有效币种。" };
  if (data.amountMinor !== oldAmount || data.currencyCode !== oldCurrency || amountUsd === null) {
    if (data.amountMinor === 0) {
      rateUsed = "1"; rateAsOf = new Date().toISOString(); rateSource = "self-use"; amountUsd = 0;
    } else {
      await ensureFreshRates();
      const rate = getRate(db, data.currencyCode);
      if (!rate) return { ok: false, error: "该币种暂无汇率，请先刷新汇率。" };
      rateUsed = rate.rateToUsd; rateAsOf = rate.quoteDate ?? rate.fetchedAt; rateSource = rate.source;
      amountUsd = freezeUsdMinor(data.amountMinor, minorUnit, rate.rateToUsd);
      if (!Number.isSafeInteger(amountUsd)) return { ok: false, error: "金额过大。" };
    }
  }
  if (mother) {
    db.transaction(tx => {
    tx.update(motherAccount).set({
      email: data.email ?? mother.email,
      contact, label: data.label ?? mother.label, joinedDate, monthlyPaymentDay: paymentDay, nextPaymentDate,
      canChangeSeatType: false,
      seatType: "chatgpt",
      usageStatus: data.usageStatus, expectedAmountMinor: data.amountMinor, expectedCurrencyCode: data.currencyCode,
      expectedAmountUsd: amountUsd, expectedRateUsed: rateUsed, expectedRateAsOf: rateAsOf, expectedRateSource: rateSource,
      billingPeriodUnit: data.billingPeriodUnit, billingPeriodCount: data.billingPeriodCount,
    }).where(eq(motherAccount.id, mother.id)).run();
      syncMotherRecord(tx, data.spaceId);
      tx.update(childAccount).set({ seatType: "chatgpt" }).where(eq(childAccount.spaceId, owner.space.id)).run();
    });
  } else {
    db.update(childAccount).set({
      email: data.email ?? child!.email, contact, label: data.label ?? child!.label,
      joinedDate: joinedDate!, monthlyPaymentDay: paymentDay!, seatType: "chatgpt",
      usageStatus: data.usageStatus, monthlyAmountMinor: data.amountMinor, monthlyCurrencyCode: data.currencyCode,
      monthlyAmountUsd: amountUsd!, monthlyRateUsed: rateUsed!, monthlyRateAsOf: rateAsOf!, monthlyRateSource: rateSource!,
      billingPeriodUnit: data.billingPeriodUnit, billingPeriodCount: data.billingPeriodCount,
      nextPaymentDate,
    }).where(eq(childAccount.id, child!.id)).run();
  }
  revalidatePath("/"); revalidatePath("/spaces"); revalidatePath(`/spaces/${data.spaceId}`);
  return { ok: true };
}

export async function renewMotherAccount(spaceId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!z.number().int().positive().safeParse(spaceId).success) return { ok: false, error: "无效的订阅。" };
  const owner = getSpaceDetail(db, spaceId);
  if (!owner || owner.space.planType !== "team") {
    return { ok: false, error: "请选择有效的 Business 母号。" };
  }
  const mother = owner.motherAccount;
  if (mother.usageStatus !== "rented") return { ok: false, error: "只有出租中的账号需要推进收款周期。" };
  if (!mother.joinedDate || !mother.monthlyPaymentDay) return { ok: false, error: "请先编辑账号，填写加入日期和付款日。" };
  db.transaction(tx => {
  tx.update(motherAccount).set({
    nextPaymentDate: renewPaymentDueDate(mother.monthlyPaymentDay!,
      { unit: mother.billingPeriodUnit as PeriodUnit, count: mother.billingPeriodCount }, mother.nextPaymentDate),
  }).where(eq(motherAccount.id, mother.id)).run();
  syncMotherRecord(tx, spaceId);
  });
  revalidatePath("/"); revalidatePath("/spaces"); revalidatePath(`/spaces/${spaceId}`);
  return { ok: true };
}
