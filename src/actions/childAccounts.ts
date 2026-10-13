// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
  deleteChildAccount as deleteChildAccountRow,
  getChildAccount,
  listChildAccounts,
  insertChildAccount,
  updateChildAccount as updateChildAccountRow,
  updateMotherSeat as updateMotherSeatRow,
} from "@/db/childAccounts";
import { getCurrencyMinorUnit } from "@/db/currencies";
import { getRate } from "@/db/fxRates";
import { getSpaceDetail } from "@/db/spaces";
import {
  nextPaymentDueDate,
  renewPaymentDueDate,
  type Period,
} from "@/lib/expiry";
import { ensureFreshRates } from "@/lib/fx/frankfurter";
import { freezeUsdMinor } from "@/lib/money";
import {
  childAccountFormSchema,
  childAccountIdSchema,
  type ChildAccountFormInput,
} from "@/lib/validation/childAccount";
import { motherSeatFormSchema } from "@/lib/validation/motherAccount";
import { spaceIdSchema } from "@/lib/validation/space";
import { childUsageStatus, type SeatUsageStatus } from "@/lib/seat-usage";
import { supportsMembers } from "@/lib/space-plans";
import { promoteMotherRecord, sameAccountLogin } from "@/db/accountRoles";
import { updateTeamSeat, renewMotherAccount } from "./teamSeats";

/**
 * ACCT-02/03 — child-account Server Actions.
 *
 * Server Actions are public mutation endpoints, so every ID and form payload is
 * re-parsed here. The parsed schemas whitelist fields and block credential-like
 * mass assignment by construction.
 */

const SPACES_PATH = "/spaces";
const NO_RATE_ERROR =
  "该币种暂无汇率，无法折算 USD。请先到「汇率」页刷新汇率后重试。";
const SELF_USE_RATE_SOURCE = "self-use";

export type ChildAccountActionResult =
  | { ok: true }
  | { ok: false; error: string };

function validationError(message = "子账号信息无效。"): ChildAccountActionResult {
  return { ok: false, error: message };
}

function revalidateSpace(spaceId: number): void {
  revalidatePath("/");
  revalidatePath(SPACES_PATH);
  revalidatePath(`${SPACES_PATH}/${spaceId}`);
}

function validateContactForStatus(
  contact: string,
  monthlyRateSource: string,
  usageStatus?: SeatUsageStatus,
): ChildAccountActionResult {
  if ((usageStatus ? usageStatus === "rented" : monthlyRateSource !== SELF_USE_RATE_SOURCE) && !contact) {
    return { ok: false, error: "非自用子账号请输入联系方式。" };
  }

  return { ok: true };
}

async function computeMonthlySnapshot(input: {
  monthlyAmountMinor: number;
  monthlyCurrencyCode: string;
}): Promise<
  | {
      ok: true;
      monthlyRateUsed: string;
      monthlyRateAsOf: string;
      monthlyRateSource: string;
      monthlyAmountUsd: number;
    }
  | { ok: false; error: string }
> {
  const srcExp = getCurrencyMinorUnit(db, input.monthlyCurrencyCode);
  if (srcExp === undefined) {
    return { ok: false, error: "请选择有效的币种。" };
  }

  if (input.monthlyAmountMinor === 0) {
    return {
      ok: true,
      monthlyRateUsed: "1",
      monthlyRateAsOf: new Date().toISOString(),
      monthlyRateSource: SELF_USE_RATE_SOURCE,
      monthlyAmountUsd: 0,
    };
  }

  await ensureFreshRates();

  const rate = getRate(db, input.monthlyCurrencyCode);
  if (!rate) {
    return { ok: false, error: NO_RATE_ERROR };
  }

  return {
    ok: true,
    monthlyRateUsed: rate.rateToUsd,
    monthlyRateAsOf: rate.quoteDate ?? rate.fetchedAt,
    monthlyRateSource: rate.source,
    monthlyAmountUsd: freezeUsdMinor(
      input.monthlyAmountMinor,
      srcExp,
      rate.rateToUsd,
    ),
  };
}

function toChildValues(
  spaceId: number,
  data: ChildAccountFormInput,
  snapshot: {
    monthlyRateUsed: string;
    monthlyRateAsOf: string;
    monthlyRateSource: string;
    monthlyAmountUsd: number;
  },
  nextPaymentDate: string | null,
) {
  return {
    spaceId,
    seatType: data.seatType,
    usageStatus: data.usageStatus,
    email: data.email,
    contact: data.contact,
    label: data.label,
    joinedDate: data.joinedDate,
    monthlyAmountMinor: data.monthlyAmountMinor,
    monthlyCurrencyCode: data.monthlyCurrencyCode,
    monthlyRateUsed: snapshot.monthlyRateUsed,
    monthlyRateAsOf: snapshot.monthlyRateAsOf,
    monthlyRateSource: snapshot.monthlyRateSource,
    monthlyAmountUsd: snapshot.monthlyAmountUsd,
    monthlyPaymentDay: data.monthlyPaymentDay,
    billingPeriodUnit: data.billingPeriodUnit,
    billingPeriodCount: data.billingPeriodCount,
    nextPaymentDate,
  };
}

function childBillingPeriod(data: Pick<
  ChildAccountFormInput,
  "billingPeriodUnit" | "billingPeriodCount"
>): Period {
  return {
    unit: data.billingPeriodUnit,
    count: data.billingPeriodCount,
  };
}

export async function createChildAccount(
  spaceId: number,
  input: unknown,
): Promise<ChildAccountActionResult> {
  const parsedSpaceId = spaceIdSchema.safeParse({ id: spaceId });
  if (!parsedSpaceId.success) {
    return { ok: false, error: "无效的空间。" };
  }

  const parsed = childAccountFormSchema.safeParse(input);
  if (!parsed.success) {
    return validationError(parsed.error.issues[0]?.message);
  }

  const space = getSpaceDetail(db, parsedSpaceId.data.id);
  if (!space) {
    return { ok: false, error: "空间不存在。" };
  }
  if (!supportsMembers(space.space.planType, space.space.sharingMode)) {
    return { ok: false, error: "请先将 Pro 使用方式设置为多人拼车，再添加成员。" };
  }
  if (space.space.planType === "team" && sameAccountLogin(parsed.data.email, space.motherAccount.email)) {
    return updateTeamSeat({
      spaceId: space.space.id, role: "mother", id: space.motherAccount.id,
      email: space.motherAccount.email, contact: parsed.data.contact, label: parsed.data.label,
      usageStatus: parsed.data.usageStatus ?? (parsed.data.monthlyAmountMinor > 0 ? "rented" : "self"),
      joinedDate: parsed.data.joinedDate, monthlyPaymentDay: parsed.data.monthlyPaymentDay,
      amountMinor: parsed.data.monthlyAmountMinor, currencyCode: parsed.data.monthlyCurrencyCode,
      billingPeriodUnit: parsed.data.billingPeriodUnit, billingPeriodCount: parsed.data.billingPeriodCount,
    });
  }

  const snapshot = await computeMonthlySnapshot(parsed.data);
  if (!snapshot.ok) return snapshot;
  const contactCheck = validateContactForStatus(
    parsed.data.contact,
    snapshot.monthlyRateSource,
    parsed.data.usageStatus,
  );
  if (!contactCheck.ok) return contactCheck;

  if (space.space.planType === "team" && listChildAccounts(db, parsedSpaceId.data.id).length >= 1) {
    return { ok: false, error: "Business 按母号＋一个子账号管理，已有子账号时请编辑现有位置。" };
  }
  insertChildAccount(
    db,
    toChildValues(
      parsedSpaceId.data.id,
      parsed.data,
      snapshot,
      nextPaymentDueDate(
        parsed.data.monthlyPaymentDay,
        childBillingPeriod(parsed.data),
        parsed.data.joinedDate,
      ),
    ),
  );
  revalidateSpace(parsedSpaceId.data.id);
  return { ok: true };
}

export async function updateChildAccount(
  id: number,
  input: unknown,
): Promise<ChildAccountActionResult> {
  const parsedId = childAccountIdSchema.safeParse({ id });
  if (!parsedId.success) {
    return { ok: false, error: "无效的子账号。" };
  }

  const parsed = childAccountFormSchema.safeParse(input);
  if (!parsed.success) {
    return validationError(parsed.error.issues[0]?.message);
  }

  const existing = getChildAccount(db, parsedId.data.id);
  if (!existing) {
    return { ok: false, error: "子账号不存在。" };
  }

  const data = { ...parsed.data, usageStatus: parsed.data.usageStatus ?? existing.usageStatus ?? undefined };
  if (existing.isMotherAccount) {
    const owner = getSpaceDetail(db, existing.spaceId);
    if (!owner) return { ok: false, error: "空间不存在。" };
    return updateTeamSeat({ spaceId: existing.spaceId, role: "mother", id: owner.motherAccount.id,
      email: data.email, contact: data.contact, label: data.label,
      usageStatus: data.usageStatus ?? (data.monthlyAmountMinor > 0 ? "rented" : "self"),
      joinedDate: data.joinedDate, monthlyPaymentDay: data.monthlyPaymentDay,
      amountMinor: data.monthlyAmountMinor, currencyCode: data.monthlyCurrencyCode,
      billingPeriodUnit: data.billingPeriodUnit, billingPeriodCount: data.billingPeriodCount });
  }
  if (data.usageStatus === "rented" && data.monthlyAmountMinor <= 0) {
    return { ok: false, error: "出租状态请输入正数约定收入。" };
  }
  const shouldRefreeze =
    data.monthlyAmountMinor !== existing.monthlyAmountMinor ||
    data.monthlyCurrencyCode !== existing.monthlyCurrencyCode;
  const nextPaymentDate =
    data.joinedDate !== existing.joinedDate ||
    data.monthlyPaymentDay !== existing.monthlyPaymentDay ||
    data.billingPeriodUnit !== existing.billingPeriodUnit ||
    data.billingPeriodCount !== existing.billingPeriodCount
      ? nextPaymentDueDate(
          data.monthlyPaymentDay,
          childBillingPeriod(data),
          data.joinedDate,
        )
      : existing.nextPaymentDate;

  const snapshot = shouldRefreeze
    ? await computeMonthlySnapshot(data)
    : {
        ok: true as const,
        monthlyRateUsed: existing.monthlyRateUsed,
        monthlyRateAsOf: existing.monthlyRateAsOf,
        monthlyRateSource: existing.monthlyRateSource,
        monthlyAmountUsd: existing.monthlyAmountUsd,
      };
  if (!snapshot.ok) return snapshot;
  const contactCheck = validateContactForStatus(
    data.contact,
    snapshot.monthlyRateSource,
    data.usageStatus,
  );
  if (!contactCheck.ok) return contactCheck;

  db.transaction(tx => {
    updateChildAccountRow(tx, parsedId.data.id, toChildValues(existing.spaceId, data, snapshot, nextPaymentDate));
    promoteMotherRecord(tx, parsedId.data.id);
  });
  revalidateSpace(existing.spaceId);
  return { ok: true };
}

export async function renewChildAccount(
  id: number,
): Promise<ChildAccountActionResult> {
  const parsedId = childAccountIdSchema.safeParse({ id });
  if (!parsedId.success) {
    return { ok: false, error: "无效的子账号。" };
  }

  const existing = getChildAccount(db, parsedId.data.id);
  if (!existing) {
    return { ok: false, error: "子账号不存在。" };
  }
  if (childUsageStatus(existing) !== "rented") {
    return { ok: false, error: "只有出租中的账号需要推进收款周期。" };
  }
  if (existing.isMotherAccount) return renewMotherAccount(existing.spaceId);

  updateChildAccountRow(db, parsedId.data.id, {
    nextPaymentDate: renewPaymentDueDate(
      existing.monthlyPaymentDay,
      {
        unit: existing.billingPeriodUnit as Period["unit"],
        count: existing.billingPeriodCount,
      },
      existing.nextPaymentDate,
    ),
  });
  revalidateSpace(existing.spaceId);
  return { ok: true };
}

export async function deleteChildAccount(
  id: number,
): Promise<ChildAccountActionResult> {
  const parsedId = childAccountIdSchema.safeParse({ id });
  if (!parsedId.success) {
    return { ok: false, error: "无效的子账号。" };
  }

  const existing = getChildAccount(db, parsedId.data.id);
  if (!existing) {
    return { ok: false, error: "子账号不存在。" };
  }

  if (existing.isMotherAccount) return { ok: false, error: "这条记录已归入母号，请在母号中修改使用状态。" };
  deleteChildAccountRow(db, parsedId.data.id);
  revalidateSpace(existing.spaceId);
  return { ok: true };
}

export async function updateMotherSeat(
  spaceId: number,
  input: unknown,
): Promise<ChildAccountActionResult> {
  const parsedSpaceId = spaceIdSchema.safeParse({ id: spaceId });
  if (!parsedSpaceId.success) {
    return { ok: false, error: "无效的空间。" };
  }

  const parsed = motherSeatFormSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "母号席位信息无效。" };
  }

  const space = getSpaceDetail(db, parsedSpaceId.data.id);
  if (!space) {
    return { ok: false, error: "空间不存在。" };
  }
  if (space.space.planType !== "team") {
    return { ok: false, error: "独立订阅不使用 Business 席位。" };
  }

  updateMotherSeatRow(db, parsedSpaceId.data.id, parsed.data);
  revalidateSpace(parsedSpaceId.data.id);
  return { ok: true };
}
