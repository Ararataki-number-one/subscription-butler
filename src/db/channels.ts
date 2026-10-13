// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { paymentChannel, space } from "./schema";
import { expiryStatus } from "@/lib/expiry";
import { format } from "date-fns";

/**
 * REF-01 — parameterized payment-channel data access (T-03-SQLI / T-03-DEL).
 *
 * Pure data helpers that take an explicit `db` so they can run against both the
 * production singleton and the in-memory test harness. Every removal is a
 * soft-delete (flip `is_active`) — there is intentionally NO delete helper here
 * (D-06: uniform soft-delete, FK integrity preserved per D-07). All queries use
 * Drizzle's parameterized builders — never string-concatenated SQL.
 */
type ChannelDb = BetterSQLite3Database<Record<string, unknown>>;

export type ChannelRow = typeof paymentChannel.$inferSelect;
export type ChannelMetadata = Pick<ChannelRow, "channelType" | "provider" | "identifier" | "note" | "isFavorite" | "feePercent">;
export type ChannelSubscription = Pick<typeof space.$inferSelect,
  "id" | "name" | "planType" | "customPlanName" | "expiryDate" | "amountUsd">;
export type ChannelUsage = {
  subscriptions: ChannelSubscription[];
  total: number;
  teamCount: number;
  independentCount: number;
  costUsdMinor: number;
  missingCostCount: number;
  overdueCount: number;
  soonCount: number;
  nextExpiryDate: string | null;
};

/** Active-only picker query (default) or all rows when `includeArchived`. */
export function listChannels(
  db: ChannelDb,
  includeArchived = false,
): ChannelRow[] {
  if (includeArchived) {
    return db.select().from(paymentChannel)
      .orderBy(desc(paymentChannel.isActive), desc(paymentChannel.isFavorite), asc(paymentChannel.id)).all();
  }
  return db
    .select()
    .from(paymentChannel)
    .where(eq(paymentChannel.isActive, true))
    .orderBy(desc(paymentChannel.isFavorite), asc(paymentChannel.id))
    .all();
}

export function countSpacesByChannel(db: ChannelDb): Record<number, number> {
  return Object.fromEntries(
    db
      .select({
        channelId: space.paymentChannelId,
        value: count(),
      })
      .from(space)
      .groupBy(space.paymentChannelId)
      .all()
      .map((row) => [row.channelId, row.value]),
  );
}

/** Insert a new channel (new surrogate id, is_active defaults to true). */
export function insertChannel(db: ChannelDb, name: string, metadata: Partial<ChannelMetadata> = {}): ChannelRow {
  return db.insert(paymentChannel).values({ name, ...metadata }).returning().get();
}

export function getChannel(db: ChannelDb, id: number): ChannelRow | undefined {
  return db.select().from(paymentChannel).where(eq(paymentChannel.id, id)).get();
}

export function updateChannelRow(db: ChannelDb, id: number, values: Partial<ChannelMetadata> & { name?: string }): ChannelRow | undefined {
  return db.update(paymentChannel).set(values).where(eq(paymentChannel.id, id)).returning().get();
}

export function getChannelUsage(db: ChannelDb, today = new Date(), soonDays = 7): Record<number, ChannelUsage> {
  const usage: Record<number, ChannelUsage> = {};
  const todayIso = format(today, "yyyy-MM-dd");
  const rows = db.select({
    channelId: space.paymentChannelId, id: space.id, name: space.name,
    planType: space.planType, customPlanName: space.customPlanName,
    expiryDate: space.expiryDate, amountUsd: space.amountUsd,
  }).from(space).orderBy(asc(space.expiryDate), asc(space.id)).all();
  for (const { channelId, ...row } of rows) {
    const current = usage[channelId] ??= {
      subscriptions: [], total: 0, teamCount: 0, independentCount: 0,
      costUsdMinor: 0, missingCostCount: 0, overdueCount: 0, soonCount: 0, nextExpiryDate: null,
    };
    current.subscriptions.push(row);
    current.total += 1;
    if (row.planType === "team") current.teamCount += 1;
    else current.independentCount += 1;
    current.costUsdMinor += row.amountUsd ?? 0;
    if (row.amountUsd === null) current.missingCostCount += 1;
    if (row.expiryDate) {
      const status = expiryStatus(row.expiryDate, today, soonDays);
      if (status === "expired") current.overdueCount += 1;
      if (status === "soon") current.soonCount += 1;
      if (row.expiryDate >= todayIso && (!current.nextExpiryDate || row.expiryDate < current.nextExpiryDate)) {
        current.nextExpiryDate = row.expiryDate;
      }
    }
  }
  return usage;
}

/** Rename a channel by id — the surrogate id is unchanged (D-05). */
export function renameChannelRow(
  db: ChannelDb,
  id: number,
  name: string,
): ChannelRow {
  return db
    .update(paymentChannel)
    .set({ name })
    .where(eq(paymentChannel.id, id))
    .returning()
    .get();
}

/** Soft-delete / reactivate — flips is_active; the row is never removed (D-06). */
export function setChannelActive(
  db: ChannelDb,
  id: number,
  isActive: boolean,
): ChannelRow {
  return db
    .update(paymentChannel)
    .set({ isActive })
    .where(eq(paymentChannel.id, id))
    .returning()
    .get();
}

/** Look up an ACTIVE channel by exact name (duplicate-name guard). */
export function findActiveByName(
  db: ChannelDb,
  name: string,
): ChannelRow | undefined {
  return db
    .select()
    .from(paymentChannel)
    .where(and(sql`lower(trim(${paymentChannel.name})) = lower(${name.trim()})`, eq(paymentChannel.isActive, true)))
    .get();
}
