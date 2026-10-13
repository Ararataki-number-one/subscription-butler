import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { currency, space } from "./schema";
import { paymentCost } from "@/lib/payment-fees";

export function recalculateChannelCosts(db: BetterSQLite3Database<Record<string, unknown>>, channelId: number, percent: string) {
  const rows = db.select({ subscription: space, minorUnit: currency.minorUnit }).from(space)
    .innerJoin(currency, eq(currency.code, space.currencyCode)).where(eq(space.paymentChannelId, channelId)).all();
  for (const { subscription, minorUnit } of rows) {
    const cost = paymentCost({ amountMinor: subscription.amountMinor,
      baseAmountUsd: subscription.baseAmountUsd, percent, minorUnit, rateUsed: subscription.rateUsed });
    db.update(space).set({ feePercent: percent, feeAmountMinor: cost.feeAmountMinor, amountUsd: cost.amountUsd })
      .where(eq(space.id, subscription.id)).run();
  }
}
