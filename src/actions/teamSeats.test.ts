import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDb } from "@/test/db-harness";
const holder = vi.hoisted(() => ({ db: null as unknown as TestDb }));
vi.mock("@/db", () => ({ get db() { return holder.db; } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/fx/frankfurter", () => ({ ensureFreshRates: vi.fn().mockResolvedValue({ stale: false }) }));
import { createTestDb } from "@/test/db-harness";
import { seedCurrencies } from "@/db/seed";
import { insertChannel } from "@/db/channels";
import { insertSpaceWithMother } from "@/db/spaces";
import { insertChildAccount } from "@/db/childAccounts";
import { getTeamEarnings } from "@/db/teamEarnings";
import { getDashboardOverview } from "@/db/dashboard";
import { upsertRates } from "@/db/fxRates";
import { motherAccount, childAccount, space } from "@/db/schema";
import { updateTeamSeat, renewMotherAccount } from "./teamSeats";
import { createChildAccount } from "./childAccounts";
import { deleteCurrency, updateCurrency } from "./currencies";
import { listDueChildAccountPaymentReminders } from "@/db/childAccountReminders";
import { monthlyEquivalent } from "@/lib/seat-usage";

describe("Team position states and agreed earnings", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let teamId: number;
  let motherId: number;
  beforeEach(() => {
    ctx = createTestDb(); holder.db = ctx.db; seedCurrencies(ctx.db);
    const channel = insertChannel(ctx.db, "Card");
    teamId = insertSpaceWithMother(ctx.db, {
      name: "Team", country: "US", paymentChannelId: channel.id, currencyCode: "USD",
      amountMinor: 2001, amountUsd: 2001, periodUnit: "month", periodCount: 1,
      currentPeriodStartDate: "2026-06-01", expiryDate: "2026-07-01",
    }, "mother@example.com").id;
    motherId = ctx.db.select().from(motherAccount).get()!.id;
    upsertRates(ctx.db, ["USD", "CNY", "EUR"].map(code => ({
      currencyCode: code, rateToUsd: code === "USD" ? "1" : "0.2",
      quoteDate: "2026-06-15", source: "frankfurter", fetchedAt: "2026-06-15T00:00:00Z",
    })));
  });
  afterEach(() => ctx.sqlite.close());
  function child() {
    return insertChildAccount(ctx.db, {
      spaceId: teamId, seatType: "chatgpt", email: "child@example.com", contact: "Customer",
      joinedDate: "2026-06-01", monthlyAmountMinor: 3000, monthlyCurrencyCode: "USD",
      monthlyAmountUsd: 3000, monthlyRateUsed: "1", monthlyRateAsOf: "2026-06-15",
      monthlyRateSource: "frankfurter", monthlyPaymentDay: 15,
      billingPeriodUnit: "quarter", billingPeriodCount: 1, nextPaymentDate: "2026-06-15",
    });
  }
  function motherInput(overrides = {}) {
    return { spaceId: teamId, role: "mother", id: motherId, usageStatus: "rented",
      contact: "Customer", label: "Mother rental", joinedDate: "2026-06-01", monthlyPaymentDay: 15,
      amountMinor: 10000, currencyCode: "CNY", billingPeriodUnit: "month", billingPeriodCount: 1, ...overrides };
  }

  it("shows an unmarked mother and a vacant child slot without creating fake accounts", () => {
    const value = getTeamEarnings(ctx.db)[teamId];
    expect(value.seats.map(row => row.usageStatus)).toEqual(["unmarked", "vacant"]);
    expect(value.unmarkedCount).toBe(1);
    expect(value.seats.map(row => row.monthlyCostUsd)).toEqual([1001, 1000]);
    expect(value.monthlyNetUsd).toBe(-2001);
    expect(ctx.db.select().from(childAccount).all()).toHaveLength(0);
  });

  it("normalizes quarterly income and sums both positions using an exact cost allocation", async () => {
    child();
    expect(await updateTeamSeat(motherInput())).toEqual({ ok: true });
    const result = getTeamEarnings(ctx.db)[teamId];
    expect(result.seats.map(row => row.monthlyIncomeUsd)).toEqual([2000, 1000]);
    expect(result.monthlyIncomeUsd).toBe(3000);
    expect(result.monthlyNetUsd).toBe(999);
    expect(result.seats.reduce((sum, row) => sum + row.monthlyNetUsd!, 0)).toBe(999);
    const overview = getDashboardOverview(ctx.db);
    expect(overview.totals.motherMonthlyRevenueUsdMinor).toBe(2000);
    expect(overview.totals.childMonthlyRevenueUsdMinor).toBe(1000);
    expect(overview.totals.netMonthlyUsdMinor).toBe(result.monthlyNetUsd);
    expect(overview.spacePerformance[0].rentedRevenueUsdMinor).toBe(3000);
  });

  it("saves mother rental details and preserves the advanced schedule and FX snapshot on contact edits", async () => {
    await updateTeamSeat(motherInput({ monthlyPaymentDay: 31, joinedDate: "2026-01-31" }));
    expect(ctx.db.select().from(motherAccount).get()).toMatchObject({
      contact: "Customer", label: "Mother rental", joinedDate: "2026-01-31", monthlyPaymentDay: 31,
      nextPaymentDate: "2026-02-28", expectedAmountUsd: 2000,
    });
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 0, 20));
    try {
      expect(await renewMotherAccount(teamId)).toEqual({ ok: true });
      expect(ctx.db.select().from(motherAccount).get()!.nextPaymentDate).toBe("2026-03-31");
      upsertRates(ctx.db, [{ currencyCode: "CNY", rateToUsd: "0.9", fetchedAt: "2026-06-16T00:00:00Z" }]);
      await updateTeamSeat(motherInput({ monthlyPaymentDay: 31, joinedDate: "2026-01-31", contact: "Changed", label: "Updated" }));
      expect(ctx.db.select().from(motherAccount).get()).toMatchObject({
        contact: "Changed", label: "Updated", nextPaymentDate: "2026-03-31", expectedAmountUsd: 2000,
      });
    } finally { vi.useRealTimers(); }
  });

  it.each([
    ["month", 1, "2026-02-28"], ["quarter", 1, "2026-04-30"],
    ["month", 6, "2026-07-31"], ["year", 1, "2027-01-31"],
  ] as const)("uses the same %s/%s payment schedule for mother and child", async (unit, count, due) => {
    const row = child();
    const payload = motherInput({ joinedDate: "2026-01-31", monthlyPaymentDay: 31, billingPeriodUnit: unit, billingPeriodCount: count });
    expect(await updateTeamSeat(payload)).toEqual({ ok: true });
    expect(await updateTeamSeat({ ...payload, role: "child", id: row.id })).toEqual({ ok: true });
    expect(ctx.db.select().from(motherAccount).get()!.nextPaymentDate).toBe(due);
    expect(ctx.db.select().from(childAccount).get()!.nextPaymentDate).toBe(due);
  });

  it("rejects incomplete or invalid rentals atomically and leaves unregistered dates empty", async () => {
    const before = ctx.db.select().from(motherAccount).get();
    expect(before).toMatchObject({ joinedDate: null, monthlyPaymentDay: null, nextPaymentDate: null });
    for (const override of [{ contact: "" }, { joinedDate: null }, { monthlyPaymentDay: null },
      { joinedDate: "2026-02-30" }, { monthlyPaymentDay: 32 }, { monthlyPaymentDay: 1.5 }]) {
      expect((await updateTeamSeat(motherInput({ email: "changed@example.com", ...override }))).ok).toBe(false);
      expect(ctx.db.select().from(motherAccount).get()).toEqual(before);
    }
    expect((await renewMotherAccount(teamId)).ok).toBe(false);
    ctx.db.update(motherAccount).set({ usageStatus: "rented" }).run();
    expect((await renewMotherAccount(teamId)).ok).toBe(false);
    expect((await renewMotherAccount(-1)).ok).toBe(false);
  });

  it("fixes mother and child as chatgpt even if a legacy client requests Codex", async () => {
    child();
    expect(await updateTeamSeat(motherInput({ seatType: "codex", canChangeSeatType: true }))).toEqual({ ok: true });
    expect(ctx.db.select().from(motherAccount).get()).toMatchObject({ seatType: "chatgpt", canChangeSeatType: false });
    expect(ctx.db.select().from(childAccount).get()!.seatType).toBe("chatgpt");
  });

  it.each(["vacant", "self", "disabled"])("excludes %s income without losing the agreed price or FX snapshot", async status => {
    await updateTeamSeat(motherInput());
    upsertRates(ctx.db, [{ currencyCode: "CNY", rateToUsd: "0.9", fetchedAt: "2026-06-16T00:00:00Z" }]);
    expect(await updateTeamSeat(motherInput({ usageStatus: status }))).toEqual({ ok: true });
    expect(getTeamEarnings(ctx.db)[teamId].monthlyIncomeUsd).toBe(0);
    expect(ctx.db.select().from(motherAccount).get()).toMatchObject({ expectedAmountMinor: 10000, expectedAmountUsd: 2000 });
    await updateTeamSeat(motherInput());
    expect(getTeamEarnings(ctx.db)[teamId].monthlyIncomeUsd).toBe(2000);
  });

  it("updates the child state and stops income and due-payment reminders when disabled", async () => {
    const row = child();
    expect(listDueChildAccountPaymentReminders(ctx.db, new Date(2026, 5, 15))).toHaveLength(1);
    expect(await updateTeamSeat(motherInput({
      role: "child", id: row.id, usageStatus: "disabled", amountMinor: 3000,
      currencyCode: "USD", billingPeriodUnit: "quarter",
    }))).toEqual({ ok: true });
    expect(getTeamEarnings(ctx.db)[teamId].monthlyIncomeUsd).toBe(0);
    expect(getDashboardOverview(ctx.db).totals.rentedChildAccounts).toBe(0);
    expect(listDueChildAccountPaymentReminders(ctx.db, new Date(2026, 5, 15))).toHaveLength(0);
  });

  it("keeps all historical extra positions visible and counted", async () => {
    child(); child();
    await updateTeamSeat(motherInput({ usageStatus: "self", amountMinor: 0 }));
    const result = getTeamEarnings(ctx.db)[teamId];
    expect(result.seats).toHaveLength(3);
    expect(result.extraSeatCount).toBe(1);
    expect(result.monthlyIncomeUsd).toBe(2000);
    expect(result.seats.reduce((sum, row) => sum + row.monthlyCostUsd!, 0)).toBe(2001);
  });

  it("does not create a third position", async () => {
    child();
    const result = await createChildAccount(teamId, {
      seatType: "chatgpt", email: "another@example.com", contact: "Customer", label: "", joinedDate: "2026-06-01",
      monthlyAmountMinor: 1000, monthlyCurrencyCode: "USD", monthlyPaymentDay: 15, billingPeriodUnit: "month", billingPeriodCount: 1,
    });
    expect(result.ok).toBe(false);
    expect(ctx.db.select().from(childAccount).all()).toHaveLength(1);
  });

  it("rejects a mismatched role/id, invalid status or zero-price rental without writing", async () => {
    const before = ctx.db.select().from(motherAccount).get();
    for (const override of [{ id: motherId + 100 }, { role: "child", id: 999 },
      { usageStatus: "bad" }, { amountMinor: 0 }, { amountMinor: -1 }, { billingPeriodCount: 2 }]) {
      expect((await updateTeamSeat(motherInput(override))).ok).toBe(false);
    }
    expect(ctx.db.select().from(motherAccount).get()).toEqual(before);
    ctx.db.update(space).set({ planType: "plus" }).where(eq(space.id, teamId)).run();
    expect((await updateTeamSeat(motherInput())).ok).toBe(false);
  });

  it("does not invent profits when the Team cost is unknown", () => {
    ctx.db.update(space).set({ amountUsd: null }).where(eq(space.id, teamId)).run();
    const result = getTeamEarnings(ctx.db)[teamId];
    expect(result.monthlyNetUsd).toBeNull();
    expect(result.seats.every(row => row.monthlyNetUsd === null)).toBe(true);
  });

  it("protects currencies referenced only by mother-account pricing", async () => {
    await updateTeamSeat(motherInput({ currencyCode: "EUR" }));
    expect((await deleteCurrency("EUR")).ok).toBe(false);
    expect((await updateCurrency("EUR", { name: "Euro", symbol: "€", minorUnit: 0 })).ok).toBe(false);
  });

  it("converts annual cost to a monthly estimate and rejects unsafe inputs", () => {
    expect(monthlyEquivalent(24000, "year", 1)).toBe(2000);
    expect(monthlyEquivalent(1000, "quarter", 1)).toBe(333);
    expect(() => monthlyEquivalent(100, "month", 0)).toThrow();
  });
});
