import { and, asc, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { childAccount, motherAccount, space } from "./schema";
import { childUsageStatus, monthlyEquivalent, type EffectiveSeatUsageStatus } from "@/lib/seat-usage";
import { isProPlan } from "@/lib/space-plans";

type Db = BetterSQLite3Database<Record<string, unknown>>;
export type TeamEarningSeat = {
  role: "mother" | "child";
  id: number | null;
  label: string;
  email: string;
  usageStatus: EffectiveSeatUsageStatus;
  amountMinor: number;
  currencyCode: string | null;
  billingPeriodUnit: string;
  billingPeriodCount: number;
  monthlyIncomeUsd: number;
  monthlyCostUsd: number | null;
  monthlyNetUsd: number | null;
};
export type TeamEarnings = {
  spaceId: number;
  planType: string;
  sharingMode: string;
  seats: TeamEarningSeat[];
  monthlyIncomeUsd: number;
  monthlyCostUsd: number | null;
  monthlyNetUsd: number | null;
  unmarkedCount: number;
  extraSeatCount: number;
};

export function getAccountEarnings(db: Db, scope: "business" | "pro" | "all" = "all"): Record<number, TeamEarnings> {
  const teams = db.select({ space, mother: motherAccount }).from(space)
    .innerJoin(motherAccount, eq(motherAccount.spaceId, space.id))
    .where(inArray(space.planType, scope === "business" ? ["team"] : scope === "pro" ? ["pro5x", "pro20x"] : ["team", "pro5x", "pro20x"])).all();
  if (!teams.length) return {};
  const children = db.select().from(childAccount)
    .where(and(inArray(childAccount.spaceId, teams.map(row => row.space.id)), eq(childAccount.isMotherAccount, false))).orderBy(asc(childAccount.id)).all();
  return Object.fromEntries(teams.map(({ space: team, mother }) => {
    const pro = isProPlan(team.planType);
    const sharedPro = pro;
    const rows = children.filter(row => row.spaceId === team.id);
    const seats: TeamEarningSeat[] = [...(pro ? [] : [{
      role: "mother", id: mother.id, label: pro ? "主账号" : "母号", email: mother.email,
      usageStatus: mother.usageStatus ?? "unmarked",
      amountMinor: mother.expectedAmountMinor, currencyCode: mother.expectedCurrencyCode,
      billingPeriodUnit: mother.billingPeriodUnit, billingPeriodCount: mother.billingPeriodCount,
      monthlyIncomeUsd: mother.usageStatus === "rented"
        ? monthlyEquivalent(mother.expectedAmountUsd ?? 0, mother.billingPeriodUnit, mother.billingPeriodCount) : 0,
      monthlyCostUsd: null, monthlyNetUsd: null,
    } as TeamEarningSeat]), ...rows.map((row): TeamEarningSeat => ({
      role: "child", id: row.id, label: pro ? "拼车成员" : "子账号", email: row.email,
      usageStatus: childUsageStatus(row), amountMinor: row.monthlyAmountMinor, currencyCode: row.monthlyCurrencyCode,
      billingPeriodUnit: row.billingPeriodUnit, billingPeriodCount: row.billingPeriodCount,
      monthlyIncomeUsd: childUsageStatus(row) === "rented"
        ? monthlyEquivalent(row.monthlyAmountUsd, row.billingPeriodUnit, row.billingPeriodCount) : 0,
      monthlyCostUsd: null, monthlyNetUsd: null,
    }))];
    if (!pro && !rows.length) seats.push({
      role: "child", id: null, label: "子账号", email: "", usageStatus: "vacant",
      amountMinor: 0, currencyCode: null, billingPeriodUnit: "month", billingPeriodCount: 1,
      monthlyIncomeUsd: 0, monthlyCostUsd: null, monthlyNetUsd: null,
    });
    const cost = team.amountUsd === null ? null : monthlyEquivalent(team.amountUsd, team.periodUnit, team.periodCount);
    const income = seats.reduce((sum, seat) => sum + seat.monthlyIncomeUsd, 0);
    const participants = sharedPro ? seats.filter(seat => seat.usageStatus === "rented" || seat.usageStatus === "self") : seats;
    const allocated = participants.length ? participants : seats;
    seats.forEach(seat => {
      if (cost !== null) {
        const index = allocated.indexOf(seat);
        seat.monthlyCostUsd = index < 0 ? 0 : Math.floor(cost / allocated.length) + (index < cost % allocated.length ? 1 : 0);
        seat.monthlyNetUsd = seat.monthlyIncomeUsd - seat.monthlyCostUsd;
      }
    });
    return [team.id, {
      spaceId: team.id, planType: team.planType, sharingMode: team.sharingMode, seats, monthlyIncomeUsd: income, monthlyCostUsd: cost,
      monthlyNetUsd: cost === null ? null : income - cost,
      unmarkedCount: seats.filter(seat => seat.usageStatus === "unmarked").length,
      extraSeatCount: pro ? 0 : Math.max(0, seats.length - 2),
    }];
  }));
}

export function getTeamEarnings(db: Db) {
  return getAccountEarnings(db, "business");
}
export function getProEarnings(db: Db) {
  return getAccountEarnings(db, "pro");
}
