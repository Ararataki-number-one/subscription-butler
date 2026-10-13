import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@/test/db-harness";
import { seedCurrencies } from "./seed";
import { insertChannel } from "./channels";
import { insertSpaceWithMother } from "./spaces";
import { insertChildAccount } from "./childAccounts";
import { accountReceipt, childAccount, motherAccount, space } from "./schema";
import { upsertRates } from "./fxRates";
import { revalueCurrentAccounts } from "./currentValuation";
import { getAccountEarnings } from "./teamEarnings";

describe("current exchange-rate valuation", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let id: number;
  beforeEach(() => {
    ctx = createTestDb(); seedCurrencies(ctx.db);
    id = insertSpaceWithMother(ctx.db, {
      name: "Business", country: "GB", paymentChannelId: insertChannel(ctx.db, "Card").id,
      currencyCode: "GBP", amountMinor: 1000, amountUsd: 1320, baseAmountUsd: 1200,
      feePercent: "10", feeAmountMinor: 100, periodUnit: "month", periodCount: 1,
      rateUsed: "1.2", rateAsOf: "2026-09-01", expiryDate: "2026-11-01",
    }, "owner@example.com").id;
    ctx.db.update(motherAccount).set({
      usageStatus: "rented", contact: "Mother customer", joinedDate: "2026-10-01",
      monthlyPaymentDay: 15, nextPaymentDate: "2026-11-15", expectedCurrencyCode: "CNY",
      expectedAmountMinor: 8000, expectedAmountUsd: 1600, expectedRateUsed: "0.2", expectedRateAsOf: "2026-09-01",
    }).run();
    insertChildAccount(ctx.db, { spaceId: id, email: "child@example.com", contact: "Child customer",
      joinedDate: "2026-10-01", monthlyPaymentDay: 20, nextPaymentDate: "2026-11-20",
      monthlyAmountMinor: 10000, monthlyCurrencyCode: "CNY", monthlyAmountUsd: 2000,
      monthlyRateUsed: "0.2", monthlyRateAsOf: "2026-09-01", monthlyRateSource: "frankfurter" });
    ctx.db.insert(accountReceipt).values({ spaceId: id, receivedDate: "2026-10-01", amountMinor: 1000,
      currencyCode: "CNY", rateUsed: "0.2", rateAsOf: "2026-09-01", rateSource: "frankfurter", amountUsd: 200 }).run();
    upsertRates(ctx.db, ["GBP", "CNY", "USD"].map(currencyCode => ({
      currencyCode, rateToUsd: currencyCode === "GBP" ? "1.5" : currencyCode === "CNY" ? "0.25" : "1",
      quoteDate: "2026-10-12", fetchedAt: "2026-10-12T02:00:00Z", source: "frankfurter",
    })));
  });
  afterEach(() => ctx.sqlite.close());
  it("revalues fee-inclusive costs and both rentals while retaining native amounts, dates and actual receipts", () => {
    const receipt = ctx.db.select().from(accountReceipt).get();
    revalueCurrentAccounts(ctx.db);
    expect(ctx.db.select().from(space).get()).toMatchObject({
      amountMinor: 1000, feePercent: "10", feeAmountMinor: 100, baseAmountUsd: 1500, amountUsd: 1650,
      rateUsed: "1.5", rateAsOf: "2026-10-12", expiryDate: "2026-11-01",
    });
    expect(ctx.db.select().from(motherAccount).get()).toMatchObject({
      expectedAmountMinor: 8000, expectedAmountUsd: 2000, contact: "Mother customer", nextPaymentDate: "2026-11-15",
    });
    expect(ctx.db.select().from(childAccount).get()).toMatchObject({
      monthlyAmountMinor: 10000, monthlyAmountUsd: 2500, contact: "Child customer", nextPaymentDate: "2026-11-20",
    });
    expect(getAccountEarnings(ctx.db)[id]).toMatchObject({ monthlyIncomeUsd: 4500, monthlyCostUsd: 1650, monthlyNetUsd: 2850 });
    expect(ctx.db.select().from(accountReceipt).get()).toEqual(receipt);
  });
  it("rolls back all changes if a later account has an unsafe valuation", () => {
    ctx.db.update(childAccount).set({ monthlyAmountMinor: Number.MAX_SAFE_INTEGER, monthlyCurrencyCode: "GBP" }).run();
    const before = [ctx.db.select().from(space).all(), ctx.db.select().from(motherAccount).all(), ctx.db.select().from(childAccount).all()];
    expect(() => revalueCurrentAccounts(ctx.db)).toThrow();
    expect([ctx.db.select().from(space).all(), ctx.db.select().from(motherAccount).all(), ctx.db.select().from(childAccount).all()]).toEqual(before);
  });
  it("keeps self-use classification and zero amounts when updating quotes", () => {
    ctx.db.update(childAccount).set({ usageStatus: null, monthlyAmountMinor: 0, monthlyAmountUsd: 0, monthlyRateSource: "self-use" }).run();
    revalueCurrentAccounts(ctx.db);
    expect(getAccountEarnings(ctx.db)[id].seats[1]).toMatchObject({ usageStatus: "self", monthlyIncomeUsd: 0 });
  });
});
