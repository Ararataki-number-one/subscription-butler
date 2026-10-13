// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
import { and, eq, gte, lt, inArray, notInArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { differenceInCalendarDays } from "date-fns";
import { formatCountryLabel } from "@/lib/countries";
import { expiryStatus, nextPaymentDueDate, type Period } from "@/lib/expiry";
import { getStatusThresholds, type StatusThresholds } from "./settings";
import { getTeamEarnings, getProEarnings } from "./teamEarnings";
import { isProPlan } from "@/lib/space-plans";
import { childUsageStatus, monthlyEquivalent, type SeatUsageStatus } from "@/lib/seat-usage";
import {
  accountReceipt,
  childAccount,
  currency,
  motherAccount,
  paymentChannel,
  space,
} from "./schema";

type Db = BetterSQLite3Database<Record<string, unknown>>;

type ExpiryStatus = ReturnType<typeof expiryStatus>;
type ChildExpiryStatus = Exclude<
  ReturnType<typeof expiryStatus>,
  "normal"
>;


export type DashboardExpiringSpaceRow = {
  id: number;
  name: string;
  country: string;
  paymentChannelName: string;
  expiryDate: string;
  daysUntilExpiry: number;
  status: Exclude<ExpiryStatus, "normal">;
  amountUsdMinor: number;
  childAccountCount: number;
};

export type DashboardExpiringChildAccountRow = {
  id: number;
  spaceId: number;
  email: string;
  label: string;
  contact: string;
  seatType: string;
  spaceName: string;
  nextPaymentDate: string;
  daysUntilExpiry: number;
  status: ChildExpiryStatus;
  revenueUsdMinor: number;
};

export type DashboardSpendBucket = {
  key: string;
  label: string;
  usdMinor: number;
  percentage: number;
};

export type DashboardSpacePerformance = {
  id: number;
  name: string;
  spacePaymentUsdMinor: number;
  rentedRevenueUsdMinor: number;
  netUsdMinor: number;
  rentedChildAccounts: number;
  status: "cost_uncovered" | "no_rental_income" | "cost_covered";
};

export type DashboardCountSummary = {
  spacesByExpiryStatus: {
    expired: number;
    soon: number;
    normal: number;
  };
  childAccountsBySeatType: {
    codex: number;
    chatgpt: number;
  };
  motherAccountsBySeatType: {
    codex: number;
    chatgpt: number;
  };
  allAccountsBySeatType: {
    codex: number;
    chatgpt: number;
  };
  childAccountsByUse: {
    selfUse: number;
    rented: number;
  };
  childAccountsByExpiryStatus: {
    expired: number;
    due: number;
    soon: number;
    normal: number;
  };
};

export type DashboardOverview = {
  proAccounts: {
    count: number;
    sharedCount: number;
    monthlyIncomeUsdMinor: number;
    monthlyCostUsdMinor: number;
    monthlyNetUsdMinor: number | null;
    receivedThisMonthUsdMinor: number;
  };
  incompleteTeamEarnings: number;
  independentAccounts: {
    count: number;
    costUsdMinor: number;
    receivedThisMonthUsdMinor: number;
  };
  totals: {
    renewalRiskSpaces: number;
    renewalRiskChildAccounts: number;
    grossCashflowUsdMinor: number;
    spacePaymentUsdMinor: number;
    childMonthlyRevenueUsdMinor: number;
    motherMonthlyRevenueUsdMinor: number;
    netMonthlyUsdMinor: number;
    totalSpaces: number;
    totalChildAccounts: number;
    rentedChildAccounts: number;
    selfUseChildAccounts: number;
  };
  expiringSpaces: DashboardExpiringSpaceRow[];
  expiringChildAccounts: DashboardExpiringChildAccountRow[];
  distributions: {
    byCountry: DashboardSpendBucket[];
    byCurrency: DashboardSpendBucket[];
    byPaymentChannel: DashboardSpendBucket[];
    spendingByPaymentChannel: DashboardSpendBucket[];
  };
  spacePerformance: DashboardSpacePerformance[];
  counts: DashboardCountSummary;
  thresholds: StatusThresholds;
};

type SpaceDashboardRow = {
  id: number;
  planType: string;
  name: string;
  country: string;
  currencyCode: string;
  amountUsd: number | null;
  expiryDate: string | null;
  paymentChannelId: number;
  paymentChannelName: string;
};

type ChildDashboardRow = {
  id: number;
  spaceId: number;
  email: string;
  label: string;
  contact: string;
  seatType: string;
  joinedDate: string;
  monthlyCurrencyCode: string;
  monthlyAmountMinor: number;
  monthlyAmountUsd: number;
  monthlyRateSource: string;
  usageStatus: SeatUsageStatus | null;
  monthlyPaymentDay: number;
  billingPeriodUnit: string;
  billingPeriodCount: number;
  nextPaymentDate: string | null;
  spaceName: string;
  spaceCountry: string;
  paymentChannelId: number;
  paymentChannelName: string;
};

type MotherDashboardRow = {
  seatType: string;
};

type BucketSeed = {
  key: string;
  label: string;
  usdMinor: number;
};

type SpacePerformanceSeed = Omit<
  DashboardSpacePerformance,
  "netUsdMinor" | "status"
>;

function addBucket(
  buckets: Map<string, BucketSeed>,
  key: string,
  label: string,
  usdMinor: number,
) {
  const current = buckets.get(key);
  if (current) {
    current.usdMinor += usdMinor;
    return;
  }
  buckets.set(key, { key, label, usdMinor });
}

function toBuckets(
  buckets: Map<string, BucketSeed>,
  totalUsdMinor: number,
): DashboardSpendBucket[] {
  return Array.from(buckets.values())
    .filter((bucket) => bucket.usdMinor !== 0)
    .sort((left, right) => {
      const byAmount = right.usdMinor - left.usdMinor;
      return byAmount !== 0 ? byAmount : left.label.localeCompare(right.label);
    })
    .map((bucket) => ({
      ...bucket,
      percentage:
        totalUsdMinor === 0
          ? 0
          : Number(((bucket.usdMinor / totalUsdMinor) * 100).toFixed(1)),
    }));
}

function toSpacePerformance(
  rows: Map<number, SpacePerformanceSeed>,
): DashboardSpacePerformance[] {
  return Array.from(rows.values())
    .map((row) => {
      const netUsdMinor = row.rentedRevenueUsdMinor - row.spacePaymentUsdMinor;
      const status: DashboardSpacePerformance["status"] =
        row.rentedChildAccounts === 0
          ? "no_rental_income"
          : netUsdMinor < 0
            ? "cost_uncovered"
            : "cost_covered";
      return { ...row, netUsdMinor, status };
    })
    .sort((left, right) => {
      const statusWeight = {
        cost_uncovered: 0,
        no_rental_income: 1,
        cost_covered: 2,
      };
      const byStatus = statusWeight[left.status] - statusWeight[right.status];
      if (byStatus !== 0) return byStatus;
      const byNet = left.netUsdMinor - right.netUsdMinor;
      return byNet !== 0 ? byNet : left.name.localeCompare(right.name);
    });
}

function statusWeight(status: ExpiryStatus) {
  if (status === "expired") return 0;
  if (status === "due") return 1;
  if (status === "soon") return 1;
  return 2;
}

function localDateFromIsoDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function daysUntilExpiry(expiryDate: string, today: Date): number {
  return differenceInCalendarDays(localDateFromIsoDate(expiryDate), today);
}

function childBillingPeriod(row: ChildDashboardRow): Period {
  return {
    unit: row.billingPeriodUnit as Period["unit"],
    count: row.billingPeriodCount,
  };
}

function childNextPaymentDate(row: ChildDashboardRow): string {
  return (
    row.nextPaymentDate ??
    nextPaymentDueDate(row.monthlyPaymentDay, childBillingPeriod(row), row.joinedDate)
  );
}

/**
 * DASH-01..04 — read-only aggregate facade for the root dashboard.
 *
 * Space payments and child monthly costs are read as separate cost classes and
 * merged after the fact. Do not sum `space.amountUsd` through a child join.
 */
export function getDashboardOverview(
  db: Db,
  today = new Date(),
): DashboardOverview {
  const thresholds = getStatusThresholds(db);
  const teamEarnings = getTeamEarnings(db);
  const proEarnings = Object.values(getProEarnings(db));
  const spaceRows: SpaceDashboardRow[] = db
    .select({
      id: space.id,
      planType: space.planType,
      name: space.name,
      country: space.country,
      currencyCode: currency.code,
      amountUsd: space.amountUsd,
      expiryDate: space.expiryDate,
      paymentChannelId: paymentChannel.id,
      paymentChannelName: paymentChannel.name,
    })
    .from(space)
    .innerJoin(paymentChannel, eq(paymentChannel.id, space.paymentChannelId))
    .innerJoin(currency, eq(currency.code, space.currencyCode))
    .all();

  const childRows: ChildDashboardRow[] = db
    .select({
      id: childAccount.id,
      spaceId: childAccount.spaceId,
      email: childAccount.email,
      label: childAccount.label,
      contact: childAccount.contact,
      seatType: childAccount.seatType,
      joinedDate: childAccount.joinedDate,
      monthlyCurrencyCode: childAccount.monthlyCurrencyCode,
      monthlyAmountMinor: childAccount.monthlyAmountMinor,
      monthlyAmountUsd: childAccount.monthlyAmountUsd,
      monthlyRateSource: childAccount.monthlyRateSource,
      usageStatus: childAccount.usageStatus,
      monthlyPaymentDay: childAccount.monthlyPaymentDay,
      billingPeriodUnit: childAccount.billingPeriodUnit,
      billingPeriodCount: childAccount.billingPeriodCount,
      nextPaymentDate: childAccount.nextPaymentDate,
      spaceName: space.name,
      spaceCountry: space.country,
      paymentChannelId: paymentChannel.id,
      paymentChannelName: paymentChannel.name,
    })
    .from(childAccount)
    .innerJoin(space, eq(space.id, childAccount.spaceId))
    .innerJoin(paymentChannel, eq(paymentChannel.id, space.paymentChannelId))
    .where(and(eq(space.planType, "team"), eq(childAccount.isMotherAccount, false)))
    .all();

  const motherRows: MotherDashboardRow[] = db
    .select({
      seatType: motherAccount.seatType,
    })
    .from(motherAccount)
    .innerJoin(space, eq(space.id, motherAccount.spaceId))
    .where(eq(space.planType, "team"))
    .all();

  const monthStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const monthEnd = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-01`;
  const independentAccounts = {
    count: spaceRows.filter(row => row.planType !== "team" && !isProPlan(row.planType)).length,
    costUsdMinor: spaceRows.filter(row => row.planType !== "team" && !isProPlan(row.planType)).reduce((sum, row) => sum + (row.amountUsd ?? 0), 0),
    receivedThisMonthUsdMinor: db.select({ amount: accountReceipt.amountUsd }).from(accountReceipt)
      .innerJoin(space, eq(space.id, accountReceipt.spaceId))
      .where(and(gte(accountReceipt.receivedDate, monthStart), lt(accountReceipt.receivedDate, monthEnd),
        notInArray(space.planType, ["team", "pro5x", "pro20x"])))
      .all().reduce((sum, row) => sum + row.amount, 0),
  };
  const proAccounts = {
    count: proEarnings.length,
    sharedCount: proEarnings.filter(row => row.sharingMode === "shared").length,
    monthlyIncomeUsdMinor: proEarnings.reduce((sum, row) => sum + row.monthlyIncomeUsd, 0),
    monthlyCostUsdMinor: proEarnings.reduce((sum, row) => sum + (row.monthlyCostUsd ?? 0), 0),
    monthlyNetUsdMinor: proEarnings.some(row => row.monthlyNetUsd === null) ? null
      : proEarnings.reduce((sum, row) => sum + row.monthlyNetUsd!, 0),
    receivedThisMonthUsdMinor: db.select({ amount: accountReceipt.amountUsd }).from(accountReceipt)
      .innerJoin(space, eq(space.id, accountReceipt.spaceId))
      .where(and(gte(accountReceipt.receivedDate, monthStart), lt(accountReceipt.receivedDate, monthEnd),
        inArray(space.planType, ["pro5x", "pro20x"])))
      .all().reduce((sum, row) => sum + row.amount, 0),
  };

  const counts: DashboardCountSummary = {
    spacesByExpiryStatus: {
      expired: 0,
      soon: 0,
      normal: 0,
    },
    childAccountsBySeatType: {
      codex: 0,
      chatgpt: 0,
    },
    motherAccountsBySeatType: {
      codex: 0,
      chatgpt: 0,
    },
    allAccountsBySeatType: {
      codex: 0,
      chatgpt: 0,
    },
    childAccountsByUse: {
      selfUse: 0,
      rented: 0,
    },
    childAccountsByExpiryStatus: {
      expired: 0,
      due: 0,
      soon: 0,
      normal: 0,
    },
  };
  const countryBuckets = new Map<string, BucketSeed>();
  const currencyBuckets = new Map<string, BucketSeed>();
  const paymentChannelBuckets = new Map<string, BucketSeed>();
  const spendingByPaymentChannelBuckets = new Map<string, BucketSeed>();
  const spacePerformanceById = new Map<number, SpacePerformanceSeed>();
  const childCountBySpace = new Map<number, number>();

  for (const row of childRows) {
    childCountBySpace.set(
      row.spaceId,
      (childCountBySpace.get(row.spaceId) ?? 0) + 1,
    );
  }

  let spacePaymentUsdMinor = 0;
  const expiringSpaces: DashboardExpiringSpaceRow[] = [];

  for (const row of spaceRows) {
    const amountUsdMinor = row.planType === "team" ? (teamEarnings[row.id]?.monthlyCostUsd ?? 0) : (row.amountUsd ?? 0);
    if (row.planType === "team") {
    spacePaymentUsdMinor += amountUsdMinor;
    addBucket(
      countryBuckets,
      row.country,
      formatCountryLabel(row.country),
      amountUsdMinor,
    );
    addBucket(currencyBuckets, row.currencyCode, row.currencyCode, amountUsdMinor);
    addBucket(
      paymentChannelBuckets,
      String(row.paymentChannelId),
      row.paymentChannelName,
      amountUsdMinor,
    );
    addBucket(
      spendingByPaymentChannelBuckets,
      String(row.paymentChannelId),
      row.paymentChannelName,
      amountUsdMinor,
    );
    spacePerformanceById.set(row.id, {
      id: row.id,
      name: row.name,
      spacePaymentUsdMinor: amountUsdMinor,
      rentedRevenueUsdMinor: 0,
      rentedChildAccounts: 0,
    });
    }

    if (!row.expiryDate) {
      counts.spacesByExpiryStatus.normal += 1;
      continue;
    }

    const status = expiryStatus(row.expiryDate, today, thresholds.spaceSoonDays);
    counts.spacesByExpiryStatus[status] += 1;
    if (status !== "normal") {
      expiringSpaces.push({
        id: row.id,
        name: row.name,
        country: formatCountryLabel(row.country),
        paymentChannelName: row.paymentChannelName,
        expiryDate: row.expiryDate,
        daysUntilExpiry: daysUntilExpiry(row.expiryDate, today),
        status,
        amountUsdMinor,
        childAccountCount: childCountBySpace.get(row.id) ?? 0,
      });
    }
  }

  let childMonthlyRevenueUsdMinor = 0;
  const expiringChildAccounts: DashboardExpiringChildAccountRow[] = [];

  for (const row of childRows) {
    const usage = childUsageStatus(row);
    const selfUse = usage === "self";
    const rented = usage === "rented";
    const revenue = rented ? monthlyEquivalent(row.monthlyAmountUsd, row.billingPeriodUnit, row.billingPeriodCount) : 0;

    if (selfUse) {
      counts.childAccountsByUse.selfUse += 1;
    } else if (rented) {
      counts.childAccountsByUse.rented += 1;
      childMonthlyRevenueUsdMinor += revenue;
      const performance = spacePerformanceById.get(row.spaceId);
      if (performance) {
        performance.rentedRevenueUsdMinor += revenue;
        performance.rentedChildAccounts += 1;
      }
    }

    addBucket(
      countryBuckets,
      row.spaceCountry,
      formatCountryLabel(row.spaceCountry),
      revenue,
    );
    addBucket(
      currencyBuckets,
      row.monthlyCurrencyCode,
      row.monthlyCurrencyCode,
      revenue,
    );
    addBucket(
      paymentChannelBuckets,
      String(row.paymentChannelId),
      row.paymentChannelName,
      revenue,
    );

    if (row.seatType === "chatgpt") {
      counts.childAccountsBySeatType.chatgpt += 1;
      counts.allAccountsBySeatType.chatgpt += 1;
    } else {
      counts.childAccountsBySeatType.codex += 1;
      counts.allAccountsBySeatType.codex += 1;
    }

    if (rented) {
      const nextPaymentDate = childNextPaymentDate(row);
      const status = expiryStatus(
        nextPaymentDate,
        today,
        thresholds.childAccountSoonDays,
        true,
      );
      counts.childAccountsByExpiryStatus[status] += 1;

      if (status !== "normal") {
        expiringChildAccounts.push({
          id: row.id,
          spaceId: row.spaceId,
          email: row.email,
          label: row.label,
          contact: row.contact,
          seatType: row.seatType,
          spaceName: row.spaceName,
          nextPaymentDate,
          daysUntilExpiry: daysUntilExpiry(nextPaymentDate, today),
          status,
          revenueUsdMinor: revenue,
        });
      }
    }
  }

  let motherMonthlyRevenueUsdMinor = 0;
  for (const row of spaceRows) {
    if (row.planType !== "team") continue;
    const mother = teamEarnings[row.id]?.seats[0];
    if (!mother || mother.usageStatus !== "rented") continue;
    const revenue = mother.monthlyIncomeUsd;
    motherMonthlyRevenueUsdMinor += revenue;
    const performance = spacePerformanceById.get(row.id);
    if (performance) {
      performance.rentedRevenueUsdMinor += revenue;
      performance.rentedChildAccounts += 1;
    }
    addBucket(countryBuckets, row.country, formatCountryLabel(row.country), revenue);
    addBucket(currencyBuckets, mother.currencyCode ?? "USD", mother.currencyCode ?? "USD", revenue);
    addBucket(paymentChannelBuckets, String(row.paymentChannelId), row.paymentChannelName, revenue);
  }

  for (const row of motherRows) {
    if (row.seatType === "chatgpt") {
      counts.motherAccountsBySeatType.chatgpt += 1;
      counts.allAccountsBySeatType.chatgpt += 1;
    } else {
      counts.motherAccountsBySeatType.codex += 1;
      counts.allAccountsBySeatType.codex += 1;
    }
  }

  expiringSpaces.sort((left, right) => {
    const byStatus = statusWeight(left.status) - statusWeight(right.status);
    if (byStatus !== 0) return byStatus;
    return left.expiryDate.localeCompare(right.expiryDate);
  });

  expiringChildAccounts.sort((left, right) => {
    const byStatus = statusWeight(left.status) - statusWeight(right.status);
    if (byStatus !== 0) return byStatus;
    return left.nextPaymentDate.localeCompare(right.nextPaymentDate);
  });

  const grossCashflowUsdMinor =
    spacePaymentUsdMinor + childMonthlyRevenueUsdMinor + motherMonthlyRevenueUsdMinor;
  const netMonthlyUsdMinor = childMonthlyRevenueUsdMinor + motherMonthlyRevenueUsdMinor - spacePaymentUsdMinor;

  return {
    proAccounts,
    incompleteTeamEarnings: Object.values(teamEarnings).filter(team => team.unmarkedCount > 0 || team.monthlyCostUsd === null).length,
    independentAccounts,
    totals: {
      renewalRiskSpaces: expiringSpaces.length,
      renewalRiskChildAccounts: expiringChildAccounts.length,
      grossCashflowUsdMinor,
      spacePaymentUsdMinor,
      childMonthlyRevenueUsdMinor,
      motherMonthlyRevenueUsdMinor,
      netMonthlyUsdMinor,
      totalSpaces: spaceRows.length,
      totalChildAccounts: childRows.length,
      rentedChildAccounts: counts.childAccountsByUse.rented,
      selfUseChildAccounts: counts.childAccountsByUse.selfUse,
    },
    expiringSpaces,
    expiringChildAccounts,
    distributions: {
      byCountry: toBuckets(countryBuckets, grossCashflowUsdMinor),
      byCurrency: toBuckets(currencyBuckets, grossCashflowUsdMinor),
      byPaymentChannel: toBuckets(paymentChannelBuckets, grossCashflowUsdMinor),
      spendingByPaymentChannel: toBuckets(
        spendingByPaymentChannelBuckets,
        spacePaymentUsdMinor,
      ),
    },
    spacePerformance: toSpacePerformance(spacePerformanceById),
    counts,
    thresholds,
  };
}
