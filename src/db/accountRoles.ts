import { and, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { childAccount, motherAccount, space } from "./schema";
import { childUsageStatus } from "@/lib/seat-usage";

type Db = BetterSQLite3Database<Record<string, unknown>>;
export function sameAccountLogin(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** Keep the original child row and reminder history while its rental belongs to the mother. */
export function promoteMotherRecord(db: Db, childId: number) {
  const child = db.select().from(childAccount).where(eq(childAccount.id, childId)).get();
  if (!child) return;
  const owner = db.select({ planType: space.planType, mother: motherAccount }).from(space)
    .innerJoin(motherAccount, eq(motherAccount.spaceId, space.id)).where(eq(space.id, child.spaceId)).get();
  if (!owner || owner.planType !== "team" || !sameAccountLogin(owner.mother.email, child.email)) return;
  db.update(childAccount).set({ isMotherAccount: true }).where(eq(childAccount.id, childId)).run();
  db.update(motherAccount).set({
    contact: child.contact, label: child.label, joinedDate: child.joinedDate,
    monthlyPaymentDay: child.monthlyPaymentDay, nextPaymentDate: child.nextPaymentDate,
    usageStatus: childUsageStatus(child), expectedAmountMinor: child.monthlyAmountMinor,
    expectedCurrencyCode: child.monthlyCurrencyCode, expectedAmountUsd: child.monthlyAmountUsd,
    expectedRateUsed: child.monthlyRateUsed, expectedRateAsOf: child.monthlyRateAsOf,
    expectedRateSource: child.monthlyRateSource,
    billingPeriodUnit: child.billingPeriodUnit, billingPeriodCount: child.billingPeriodCount,
  }).where(eq(motherAccount.id, owner.mother.id)).run();
}

export function syncMotherRecord(db: Db, spaceId: number) {
  const mother = db.select().from(motherAccount).where(eq(motherAccount.spaceId, spaceId)).get();
  if (!mother) return;
  db.update(childAccount).set({
    email: mother.email, contact: mother.contact, label: mother.label,
    joinedDate: mother.joinedDate ?? sql`joined_date`,
    monthlyPaymentDay: mother.monthlyPaymentDay ?? sql`monthly_payment_day`,
    nextPaymentDate: mother.nextPaymentDate, usageStatus: mother.usageStatus,
    monthlyAmountMinor: mother.expectedAmountMinor,
    monthlyCurrencyCode: mother.expectedCurrencyCode ?? sql`monthly_currency_code`,
    monthlyAmountUsd: mother.expectedAmountUsd ?? sql`monthly_amount_usd`,
    monthlyRateUsed: mother.expectedRateUsed ?? sql`monthly_rate_used`,
    monthlyRateAsOf: mother.expectedRateAsOf ?? sql`monthly_rate_as_of`,
    monthlyRateSource: mother.expectedRateSource ?? sql`monthly_rate_source`,
    billingPeriodUnit: mother.billingPeriodUnit, billingPeriodCount: mother.billingPeriodCount,
  }).where(and(eq(childAccount.spaceId, spaceId), eq(childAccount.isMotherAccount, true))).run();
}
