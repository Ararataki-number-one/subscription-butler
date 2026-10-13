// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
"use server";

import { hasAdminSession } from "@/lib/action-auth";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { accountReceipt, childAccount } from "@/db/schema";
import { db } from "@/db";
import { OperationsError, OperationsStore } from "@/db/operations";
import { getChannel } from "@/db/channels";
import { getCurrencyMinorUnit } from "@/db/currencies";
import { getRate } from "@/db/fxRates";
import {
  deleteSpaceCascade,
  getSpaceDetail,
  insertSpaceWithMother,
  updateMotherAccountEmail,
  updateSpaceRow,
} from "@/db/spaces";
import { addPeriod } from "@/lib/expiry";
import { ensureFreshRates } from "@/lib/fx/frankfurter";
import { freezeUsdMinor } from "@/lib/money";
import { spaceFormSchema, spaceIdSchema } from "@/lib/validation/space";
import { isProPlan, supportsMembers } from "@/lib/space-plans";
import { paymentCost } from "@/lib/payment-fees";
import { promoteMotherRecord } from "@/db/accountRoles";

/**
 * SPACE-01 / SPACE-04 — space Server Actions.
 *
 * Security (T-03-INPUT / T-03-MASS / T-03-REFDATA):
 * - Every action re-parses input with Zod server-side because Server Actions
 *   are public endpoints; client validation is only convenience.
 * - Parsed fields are whitelisted, blocking mass-assignment.
 * - Reference data is rechecked server-side; client select options are never
 *   trusted as authority.
 */

const SPACES_PATH = "/spaces";
const NO_RATE_ERROR =
  "该币种暂无汇率,无法折算 USD。请先到「汇率」页刷新汇率后重试。";
const DELETE_MISMATCH_ERROR = "空间名称不匹配，未删除。";

const deleteSpaceSchema = z.object({
  id: z.number().int().positive(),
  confirmationName: z.string().min(1),
});

export type SpaceActionResult = { ok: true } | { ok: false; error: string };

function revalidateSpace(id?: number): void {
  revalidatePath("/");
  revalidatePath(SPACES_PATH);
  if (id) {
    revalidatePath(`${SPACES_PATH}/${id}`);
  }
}

function validationError(message = "空间信息无效。"): SpaceActionResult {
  return { ok: false, error: message };
}

function validateReferences(
  paymentChannelId: number,
  currencyCode: string,
  retainedChannelId?: number,
): SpaceActionResult | null {
  const channel = getChannel(db, paymentChannelId);
  if (!channel || (!channel.isActive && paymentChannelId !== retainedChannelId)) {
    return { ok: false, error: "请选择有效的付款渠道。" };
  }

  if (getCurrencyMinorUnit(db, currencyCode) === undefined) {
    return { ok: false, error: "请选择有效的币种。" };
  }

  return null;
}

async function computeSnapshot(input: {
  amountMinor: number;
  currencyCode: string;
  paymentChannelId: number;
}): Promise<
  | {
      ok: true;
      rateUsed: string;
      rateAsOf: string;
      rateSource: string;
      amountUsd: number;
      baseAmountUsd: number; feePercent: string; feeAmountMinor: number;
    }
  | { ok: false; error: string }
> {
  await ensureFreshRates();

  const rate = getRate(db, input.currencyCode);
  if (!rate) {
    return { ok: false, error: NO_RATE_ERROR };
  }

  const srcExp = getCurrencyMinorUnit(db, input.currencyCode);
  if (srcExp === undefined) {
    return { ok: false, error: "请选择有效的币种。" };
  }

  const baseAmountUsd = freezeUsdMinor(input.amountMinor, srcExp, rate.rateToUsd);
  let cost;
  try { cost = paymentCost({ amountMinor: input.amountMinor, baseAmountUsd,
    percent: getChannel(db, input.paymentChannelId)?.feePercent ?? "0", minorUnit: srcExp, rateUsed: rate.rateToUsd }); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : "手续费计算失败。" }; }
  return {
    ok: true,
    rateUsed: rate.rateToUsd,
    rateAsOf: rate.quoteDate ?? rate.fetchedAt,
    rateSource: rate.source,
    amountUsd: cost.amountUsd!, baseAmountUsd,
    feePercent: cost.feePercent, feeAmountMinor: cost.feeAmountMinor,
  };
}

export async function createSpace(
  input: unknown,
): Promise<SpaceActionResult> {
  if (!(await hasAdminSession())) return { ok: false, error: "登录状态已失效，请重新登录。" };
  const parsed = spaceFormSchema.safeParse(input);
  if (!parsed.success) {
    return validationError(parsed.error.issues[0]?.message);
  }

  const data = parsed.data;
  const referenceError = validateReferences(
    data.paymentChannelId,
    data.currencyCode,
  );
  if (referenceError) return referenceError;

  const snapshot = await computeSnapshot(data);
  if (!snapshot.ok) return snapshot;

  const expiryDate = addPeriod(data.currentPeriodStartDate, {
    unit: data.periodUnit,
    count: data.periodCount,
  });

  insertSpaceWithMother(
    db,
    {
      name: data.name,
      planType: data.planType ?? "team",
      sharingMode: !data.planType || data.planType === "team" || isProPlan(data.planType) ? "shared" : "single",
      customPlanName: data.planType === "custom" ? data.customPlanName : "",
      contact: data.contact ?? "",
      country: data.country,
      paymentChannelId: data.paymentChannelId,
      currencyCode: data.currencyCode,
      amountMinor: data.amountMinor,
      periodUnit: data.periodUnit,
      periodCount: data.periodCount,
      openingDate: data.openingDate,
      currentPeriodStartDate: data.currentPeriodStartDate,
      expiryDate,
      rateUsed: snapshot.rateUsed,
      rateAsOf: snapshot.rateAsOf,
      rateSource: snapshot.rateSource,
      amountUsd: snapshot.amountUsd,
      baseAmountUsd: snapshot.baseAmountUsd, feePercent: snapshot.feePercent, feeAmountMinor: snapshot.feeAmountMinor,
    },
    data.motherEmail,
  );

  revalidateSpace();
  return { ok: true };
}

export async function updateSpace(
  id: number,
  input: unknown,
): Promise<SpaceActionResult> {
  if (!(await hasAdminSession())) return { ok: false, error: "登录状态已失效，请重新登录。" };
  const parsedId = spaceIdSchema.safeParse({ id });
  if (!parsedId.success) {
    return { ok: false, error: "无效的空间。" };
  }

  const parsed = spaceFormSchema.safeParse(input);
  if (!parsed.success) {
    return validationError(parsed.error.issues[0]?.message);
  }

  const data = parsed.data;
  const existing = getSpaceDetail(db, parsedId.data.id);
  if (!existing) {
    return { ok: false, error: "空间不存在。" };
  }
  const planType = data.planType ?? existing.space.planType;
  const sharingMode = planType === "team" || isProPlan(planType) ? "shared" : "single";
  const customPlanName = planType === "custom"
    ? (data.customPlanName ?? existing.space.customPlanName) : "";
  if (planType === "custom" && !customPlanName) return validationError("请输入订阅类型名称。");

  const referenceError = validateReferences(
    data.paymentChannelId,
    data.currencyCode,
    existing.space.paymentChannelId,
  );
  if (referenceError) return referenceError;

  const expiryDate = addPeriod(data.currentPeriodStartDate, {
    unit: data.periodUnit,
    count: data.periodCount,
  });
  const shouldRefreeze =
    data.amountMinor !== existing.space.amountMinor ||
    data.currencyCode !== existing.space.currencyCode;

  const snapshot = shouldRefreeze
    ? await computeSnapshot(data)
    : {
        ok: true as const,
        rateUsed: existing.space.rateUsed,
        rateAsOf: existing.space.rateAsOf,
        rateSource: existing.space.rateSource,
        amountUsd: existing.space.amountUsd,
        baseAmountUsd: existing.space.baseAmountUsd,
        feePercent: existing.space.feePercent, feeAmountMinor: existing.space.feeAmountMinor,
      };
  if (!snapshot.ok) return snapshot;
  let currentCost;
  try { currentCost = paymentCost({ amountMinor: data.amountMinor, baseAmountUsd: snapshot.baseAmountUsd,
    percent: getChannel(db, data.paymentChannelId)?.feePercent ?? "0",
    minorUnit: getCurrencyMinorUnit(db, data.currencyCode)!, rateUsed: snapshot.rateUsed }); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : "手续费计算失败。" }; }

  const result = db.transaction((tx): SpaceActionResult => {
    const allMemberRows = tx.select().from(childAccount).where(eq(childAccount.spaceId, parsedId.data.id)).all();
    const memberRows = allMemberRows.filter(row => !row.isMotherAccount);
    if (!supportsMembers(planType, sharingMode) && allMemberRows.length) {
      return { ok: false, error: "当前已有子账号或拼车成员，请先处理成员记录，才能改为单人使用或其他订阅。" };
    }
    if (planType === "team" && existing.space.planType !== "team" && memberRows
      .filter(row => row.email.trim().toLowerCase() !== data.motherEmail.trim().toLowerCase()).length > 1) {
      return { ok: false, error: "Business 只支持母号＋一个子账号，当前拼车成员超过一个。" };
    }
    if (planType === "team" && tx.select({ id: accountReceipt.id }).from(accountReceipt)
      .where(eq(accountReceipt.spaceId, parsedId.data.id)).get()) {
      return { ok: false, error: "此独立账号已有收款记录，不能改为 Business。可继续在独立订阅类型之间切换。" };
    }
    const formerMother = existing.motherAccount;
    const transferMother = isProPlan(planType) && existing.space.planType === "team"
      && formerMother.usageStatus === "rented" && !allMemberRows.some(row => row.isMotherAccount);
    if (transferMother && (!formerMother.joinedDate || !formerMother.monthlyPaymentDay ||
      !formerMother.expectedCurrencyCode || formerMother.expectedAmountUsd === null ||
      !formerMother.expectedRateUsed || !formerMother.expectedRateAsOf || !formerMother.expectedRateSource)) {
      return { ok: false, error: "请先完整保存母号出租资料，再改成 Pro，原租赁会转为拼车成员。" };
    }
    updateSpaceRow(tx, parsedId.data.id, {
    name: data.name,
    planType,
    sharingMode,
    customPlanName,
    contact: data.contact ?? existing.space.contact,
    country: data.country,
    paymentChannelId: data.paymentChannelId,
    currencyCode: data.currencyCode,
    amountMinor: data.amountMinor,
    periodUnit: data.periodUnit,
    periodCount: data.periodCount,
    openingDate: data.openingDate,
    currentPeriodStartDate: data.currentPeriodStartDate,
    expiryDate,
    rateUsed: snapshot.rateUsed,
    rateAsOf: snapshot.rateAsOf,
    rateSource: snapshot.rateSource,
    amountUsd: currentCost.amountUsd, baseAmountUsd: snapshot.baseAmountUsd,
    feePercent: currentCost.feePercent, feeAmountMinor: currentCost.feeAmountMinor,
  });
    updateMotherAccountEmail(tx, parsedId.data.id, data.motherEmail);
    if (transferMother) {
      tx.insert(childAccount).values({
        spaceId: parsedId.data.id, seatType: "chatgpt", email: data.motherEmail,
        contact: formerMother.contact, label: formerMother.label, usageStatus: "rented",
        joinedDate: formerMother.joinedDate!, monthlyPaymentDay: formerMother.monthlyPaymentDay!,
        nextPaymentDate: formerMother.nextPaymentDate, billingPeriodUnit: formerMother.billingPeriodUnit,
        billingPeriodCount: formerMother.billingPeriodCount, monthlyAmountMinor: formerMother.expectedAmountMinor,
        monthlyCurrencyCode: formerMother.expectedCurrencyCode!, monthlyAmountUsd: formerMother.expectedAmountUsd!,
        monthlyRateUsed: formerMother.expectedRateUsed!, monthlyRateAsOf: formerMother.expectedRateAsOf!,
        monthlyRateSource: formerMother.expectedRateSource!,
      }).run();
    }
    if (isProPlan(planType)) {
      tx.update(childAccount).set({ isMotherAccount: false }).where(eq(childAccount.spaceId, parsedId.data.id)).run();
    } else if (planType === "team") {
      for (const row of memberRows) promoteMotherRecord(tx, row.id);
    }
    return { ok: true };
  });
  if (!result.ok) return result;

  revalidateSpace(parsedId.data.id);
  return { ok: true };
}

export async function renewSpace(id: number, expectedDueDate?: string): Promise<SpaceActionResult> {
  if (!(await hasAdminSession())) return { ok: false, error: "登录状态已失效，请重新登录。" };
  const parsedId = spaceIdSchema.safeParse({ id });
  if (!parsedId.success) {
    return { ok: false, error: "无效的空间。" };
  }

  const existing = getSpaceDetail(db, parsedId.data.id);
  if (!existing) {
    return { ok: false, error: "空间不存在。" };
  }

  const periodUnit = existing.space.periodUnit ?? "month";
  const periodCount = existing.space.periodCount ?? 1;
  if (
    periodUnit !== "month" &&
    periodUnit !== "quarter" &&
    periodUnit !== "year"
  ) {
    return { ok: false, error: "空间周期无效。" };
  }

  const currentPeriodStartDate =
    existing.space.expiryDate ??
    existing.space.currentPeriodStartDate ??
    existing.space.openingDate;
  if (!currentPeriodStartDate) {
    return { ok: false, error: "缺少当前周期日期，无法续费。" };
  }

  const snapshot = await computeSnapshot({
    amountMinor: existing.space.amountMinor,
    currencyCode: existing.space.currencyCode,
    paymentChannelId: existing.space.paymentChannelId,
  });
  if (!snapshot.ok) return snapshot;

  const expiryDate = addPeriod(currentPeriodStartDate, {
    unit: periodUnit,
    count: periodCount,
  });

  try {
    new OperationsStore(db.$client).renewClassicSource({ kind: "subscription", source: `space:${parsedId.data.id}`,
      expectedDueDate: expectedDueDate ?? existing.space.expiryDate ?? undefined, update: () => updateSpaceRow(db, parsedId.data.id, {
        currentPeriodStartDate,
        expiryDate,
        rateUsed: snapshot.rateUsed,
        rateAsOf: snapshot.rateAsOf,
        rateSource: snapshot.rateSource,
        amountUsd: snapshot.amountUsd,
        baseAmountUsd: snapshot.baseAmountUsd, feePercent: snapshot.feePercent, feeAmountMinor: snapshot.feeAmountMinor,
      }) });
  } catch (error) {
    return { ok: false, error: error instanceof OperationsError ? error.message : "续费失败，请重试。" };
  }

  revalidateSpace(parsedId.data.id);
  return { ok: true };
}

export async function deleteSpace(
  input: unknown,
): Promise<SpaceActionResult> {
  if (!(await hasAdminSession())) return { ok: false, error: "登录状态已失效，请重新登录。" };
  const parsed = deleteSpaceSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "删除确认信息无效。" };
  }

  const result = deleteSpaceCascade(
    db,
    parsed.data.id,
    parsed.data.confirmationName,
  );
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.reason === "name_mismatch"
          ? DELETE_MISMATCH_ERROR
          : "空间不存在。",
    };
  }

  revalidateSpace(parsed.data.id);
  return { ok: true };
}
