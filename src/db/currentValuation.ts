import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { childAccount, currency, motherAccount, space } from "./schema";
import { getRate } from "./fxRates";
import { freezeUsdMinor } from "@/lib/money";
import { paymentCost } from "@/lib/payment-fees";

type Db = BetterSQLite3Database<Record<string, unknown>>;
function checkedUsd(amount: number, minorUnit: number, rate: string) {
  const value = freezeUsdMinor(amount, minorUnit, rate);
  if (!Number.isSafeInteger(value)) throw new Error("折算金额过大。");
  return value;
}

/** Current subscriptions and agreed rentals are revalued; actual receipts remain historical. */
export function revalueCurrentAccounts(db: Db) {
  db.transaction(tx => {
    const units = new Map(tx.select().from(currency).all().map(row => [row.code, row.minorUnit]));
    for (const row of tx.select().from(space).all()) {
      const rate = getRate(tx, row.currencyCode);
      const unit = units.get(row.currencyCode);
      if (!rate || unit === undefined) continue;
      const baseAmountUsd = checkedUsd(row.amountMinor, unit, rate.rateToUsd);
      const cost = paymentCost({ amountMinor: row.amountMinor, baseAmountUsd,
        percent: row.feePercent, minorUnit: unit, rateUsed: rate.rateToUsd });
      tx.update(space).set({
        baseAmountUsd, amountUsd: cost.amountUsd, feeAmountMinor: cost.feeAmountMinor,
        rateUsed: rate.rateToUsd, rateAsOf: rate.quoteDate ?? rate.fetchedAt, rateSource: rate.source,
      }).where(eq(space.id, row.id)).run();
    }
    for (const row of tx.select().from(motherAccount).all()) {
      if (!row.expectedCurrencyCode || row.expectedAmountMinor === 0) continue;
      const rate = getRate(tx, row.expectedCurrencyCode);
      const unit = units.get(row.expectedCurrencyCode);
      if (!rate || unit === undefined) continue;
      tx.update(motherAccount).set({
        expectedAmountUsd: checkedUsd(row.expectedAmountMinor, unit, rate.rateToUsd),
        expectedRateUsed: rate.rateToUsd, expectedRateAsOf: rate.quoteDate ?? rate.fetchedAt,
        expectedRateSource: row.expectedRateSource === "self-use" ? "self-use" : rate.source,
      }).where(eq(motherAccount.id, row.id)).run();
    }
    for (const row of tx.select().from(childAccount).all()) {
      if (row.monthlyAmountMinor === 0) continue;
      const rate = getRate(tx, row.monthlyCurrencyCode);
      const unit = units.get(row.monthlyCurrencyCode);
      if (!rate || unit === undefined) continue;
      tx.update(childAccount).set({
        monthlyAmountUsd: checkedUsd(row.monthlyAmountMinor, unit, rate.rateToUsd),
        monthlyRateUsed: rate.rateToUsd, monthlyRateAsOf: rate.quoteDate ?? rate.fetchedAt,
        monthlyRateSource: row.monthlyRateSource === "self-use" ? "self-use" : rate.source,
      }).where(eq(childAccount.id, row.id)).run();
    }
  });
}
