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
import { upsertRates } from "@/db/fxRates";
import { space, childAccount, motherAccount } from "@/db/schema";
import { getSpaceDetail } from "@/db/spaces";
import { getAccountEarnings, getTeamEarnings, getProEarnings } from "@/db/teamEarnings";
import { getDashboardOverview } from "@/db/dashboard";
import { listChildAccounts } from "@/db/childAccounts";
import { listDueChildAccountPaymentReminders } from "@/db/childAccountReminders";
import { createSpace, updateSpace, renewSpace } from "./spaces";
import { createChildAccount, updateChildAccount, renewChildAccount, deleteChildAccount } from "./childAccounts";
import { updateTeamSeat } from "./teamSeats";
import { saveAccountReceipt } from "./accountReceipts";

describe("Pro carpool and separate financial totals", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let channel: number;
  beforeEach(() => {
    ctx = createTestDb(); holder.db = ctx.db; seedCurrencies(ctx.db);
    channel = insertChannel(ctx.db, "Card").id;
    upsertRates(ctx.db, ["USD", "CNY"].map(code => ({
      currencyCode: code, rateToUsd: code === "USD" ? "1" : "0.2", quoteDate: "2026-10-10",
      fetchedAt: "2026-10-10T00:00:00Z", source: "frankfurter",
    })));
  });
  afterEach(() => ctx.sqlite.close());
  function input(planType = "pro20x", sharingMode = "shared") {
    return { name: planType, planType, sharingMode, country: "US", paymentChannelId: channel,
      currencyCode: "USD", amountMinor: 20000, openingDate: "2026-10-01",
      currentPeriodStartDate: "2026-10-01", periodUnit: "month", periodCount: 1, motherEmail: "owner@example.com" };
  }
  async function create(planType = "pro20x", sharingMode = "shared") {
    expect(await createSpace(input(planType, sharingMode))).toEqual({ ok: true });
    return ctx.db.select().from(space).all().at(-1)!;
  }
  function member(name = "Member", overrides = {}) {
    return { email: name, contact: "Customer contact", label: "Carpool", seatType: "chatgpt", usageStatus: "rented",
      joinedDate: "2026-10-01", monthlyAmountMinor: 5000, monthlyCurrencyCode: "CNY",
      monthlyPaymentDay: 11, billingPeriodUnit: "month", billingPeriodCount: 1, ...overrides };
  }

  it.each(["pro5x", "pro20x"])("supports multiple members for a shared %s", async plan => {
    const row = await create(plan);
    for (const name of ["Alice", "Bob", "Carol"]) expect(await createChildAccount(row.id, member(name))).toEqual({ ok: true });
    const earnings = getProEarnings(ctx.db)[row.id];
    expect(earnings.seats.filter(seat => seat.role === "child")).toHaveLength(3);
    expect(earnings.monthlyIncomeUsd).toBe(3000);
    expect(earnings.monthlyCostUsd).toBe(20000);
    expect(earnings.monthlyNetUsd).toBe(-17000);
    expect(earnings.seats.every(seat => seat.role === "child")).toBe(true);
    expect(earnings.seats.map(seat => seat.monthlyCostUsd)).toEqual([6667, 6667, 6666]);
    expect(earnings.seats.reduce((sum, seat) => sum + seat.monthlyCostUsd!, 0)).toBe(20000);
    expect(getTeamEarnings(ctx.db)[row.id]).toBeUndefined();
  });

  it("normalizes old single-Pro input to member-only carpool", async () => {
    const row = await create("pro5x", "single");
    expect(getProEarnings(ctx.db)[row.id].seats).toHaveLength(0);
    expect(await createChildAccount(row.id, member())).toEqual({ ok: true });
    expect(await updateSpace(row.id, input("pro5x", "single"))).toEqual({ ok: true });
    expect(listChildAccounts(ctx.db, row.id)).toHaveLength(1);
    expect(getSpaceDetail(ctx.db, row.id)?.space.sharingMode).toBe("shared");
  });

  it("keeps the Business two-account limit", async () => {
    const row = await create("team");
    expect(await createChildAccount(row.id, member("Business child"))).toEqual({ ok: true });
    expect((await createChildAccount(row.id, member("Second child"))).ok).toBe(false);
    expect(listChildAccounts(ctx.db, row.id)).toHaveLength(1);
  });

  it("separates Business, Pro and other subscriptions including actual receipts", async () => {
    const business = await create("team");
    const pro = await create();
    const plus = await create("plus", "single");
    await createChildAccount(business.id, member("Business", { monthlyAmountMinor: 3000, monthlyCurrencyCode: "USD" }));
    for (const name of ["Alice", "Bob"]) await createChildAccount(pro.id, member(name));
    await saveAccountReceipt({ spaceId: pro.id, receivedDate: "2026-10-10", amountMinor: 7000, currencyCode: "USD" });
    await saveAccountReceipt({ spaceId: plus.id, receivedDate: "2026-10-10", amountMinor: 9000, currencyCode: "USD" });
    const overview = getDashboardOverview(ctx.db, new Date(2026, 9, 11));
    expect(overview.totals.childMonthlyRevenueUsdMinor).toBe(3000);
    expect(overview.totals.spacePaymentUsdMinor).toBe(20000);
    expect(overview.totals.netMonthlyUsdMinor).toBe(-17000);
    expect(overview.proAccounts).toMatchObject({ count: 1, sharedCount: 1, monthlyIncomeUsdMinor: 2000,
      monthlyCostUsdMinor: 20000, monthlyNetUsdMinor: -18000, receivedThisMonthUsdMinor: 7000 });
    expect(overview.independentAccounts).toEqual({ count: 1, costUsdMinor: 20000, receivedThisMonthUsdMinor: 9000 });
    expect(overview.counts.motherAccountsBySeatType).toEqual({ codex: 0, chatgpt: 1 });
    expect(overview.spacePerformance).toHaveLength(1);
    expect(overview.spacePerformance[0].id).toBe(business.id);
  });

  it("edits member identity, price, state and period together and supports renewal/deletion", async () => {
    const row = await create();
    await createChildAccount(row.id, member());
    const original = listChildAccounts(ctx.db, row.id)[0].childAccount;
    expect(await updateChildAccount(original.id, member("Renamed", {
      contact: "Updated contact", monthlyAmountMinor: 30000, billingPeriodUnit: "quarter",
    }))).toEqual({ ok: true });
    let edited = listChildAccounts(ctx.db, row.id)[0].childAccount;
    expect(edited).toMatchObject({ email: "Renamed", contact: "Updated contact", monthlyAmountUsd: 6000 });
    expect(getProEarnings(ctx.db)[row.id].monthlyIncomeUsd).toBe(2000);
    expect(await renewChildAccount(original.id)).toEqual({ ok: true });
    const dueBeforeDisable = listChildAccounts(ctx.db, row.id)[0].childAccount.nextPaymentDate;
    expect(await updateChildAccount(original.id, member("Renamed", {
      usageStatus: "disabled", monthlyAmountMinor: 30000, billingPeriodUnit: "quarter",
    }))).toEqual({ ok: true });
    edited = listChildAccounts(ctx.db, row.id)[0].childAccount;
    expect(edited.nextPaymentDate).toBe(dueBeforeDisable);
    expect(getProEarnings(ctx.db)[row.id].monthlyIncomeUsd).toBe(0);
    expect(listDueChildAccountPaymentReminders(ctx.db, new Date(dueBeforeDisable!))).toHaveLength(0);
    expect(await deleteChildAccount(original.id)).toEqual({ ok: true });
    expect(listChildAccounts(ctx.db, row.id)).toHaveLength(0);
  });

  it("saves mother identity, seat type, usage and price in a single action", async () => {
    const row = await create("team");
    await createChildAccount(row.id, member("Child", { seatType: "codex" }));
    const mother = getSpaceDetail(ctx.db, row.id)!.motherAccount;
    expect(await updateTeamSeat({ spaceId: row.id, role: "mother", id: mother.id, email: "renamed@example.com",
      contact: "Customer", joinedDate: "2026-10-01", monthlyPaymentDay: 11,
      seatType: "codex", canChangeSeatType: false, usageStatus: "rented",
      amountMinor: 10000, currencyCode: "CNY", billingPeriodUnit: "month", billingPeriodCount: 1 })).toEqual({ ok: true });
    expect(getSpaceDetail(ctx.db, row.id)?.motherAccount).toMatchObject({
      email: "renamed@example.com", seatType: "chatgpt", canChangeSeatType: false, usageStatus: "rented", expectedAmountUsd: 2000,
    });
    expect(listChildAccounts(ctx.db, row.id)[0].childAccount.seatType).toBe("chatgpt");
  });

  it("uses only member earnings for Pro and rejects a separate main-account rental", async () => {
    const row = await create("pro5x", "single");
    const mother = getSpaceDetail(ctx.db, row.id)!.motherAccount;
    expect((await updateTeamSeat({ spaceId: row.id, role: "mother", id: mother.id, usageStatus: "rented",
      contact: "Customer", joinedDate: "2026-10-01", monthlyPaymentDay: 11,
      amountMinor: 30000, currencyCode: "USD", billingPeriodUnit: "month", billingPeriodCount: 1 })).ok).toBe(false);
    expect(await createChildAccount(row.id, member("Customer", { monthlyAmountMinor: 30000, monthlyCurrencyCode: "USD" }))).toEqual({ ok: true });
    const overview = getDashboardOverview(ctx.db);
    expect(overview.proAccounts.monthlyIncomeUsdMinor).toBe(30000);
    expect(overview.proAccounts.monthlyNetUsdMinor).toBe(10000);
    expect(overview.totals.motherMonthlyRevenueUsdMinor).toBe(0);
  });

  it("preserves member records and income through Pro tier changes and subscription renewal", async () => {
    const row = await create("pro5x");
    await createChildAccount(row.id, member("Alice"));
    await createChildAccount(row.id, member("Bob"));
    const before = listChildAccounts(ctx.db, row.id);
    expect(await updateSpace(row.id, input("pro20x", "shared"))).toEqual({ ok: true });
    expect(await renewSpace(row.id)).toEqual({ ok: true });
    expect(listChildAccounts(ctx.db, row.id)).toEqual(before);
    expect(getAccountEarnings(ctx.db)[row.id].monthlyIncomeUsd).toBe(2000);
    expect((await updateSpace(row.id, input("team"))).ok).toBe(false);
  });

  it("rejects a member id from another subscription", async () => {
    const first = await create();
    const second = await create("pro5x");
    await createChildAccount(first.id, member("Alice"));
    const id = listChildAccounts(ctx.db, first.id)[0].childAccount.id;
    expect((await updateTeamSeat({ spaceId: second.id, role: "child", id, usageStatus: "rented",
      amountMinor: 1000, currencyCode: "USD", billingPeriodUnit: "month", billingPeriodCount: 1 })).ok).toBe(false);
    expect(listChildAccounts(ctx.db, first.id)[0].childAccount.monthlyAmountMinor).toBe(5000);
  });

  it("does not overwrite identity or seat settings if pricing validation fails", async () => {
    const row = await create("team");
    const mother = getSpaceDetail(ctx.db, row.id)!.motherAccount;
    expect((await updateTeamSeat({ spaceId: row.id, role: "mother", id: mother.id, email: "changed@example.com",
      canChangeSeatType: false, usageStatus: "rented", amountMinor: 1000, currencyCode: "EUR",
      billingPeriodUnit: "month", billingPeriodCount: 1 })).ok).toBe(false);
    expect(getSpaceDetail(ctx.db, row.id)?.motherAccount).toEqual(mother);
  });

  it("requires a valid sharing mode and never creates fake carpool members on conversion", async () => {
    expect((await createSpace({ ...input(), sharingMode: "invalid" })).ok).toBe(false);
    const row = await create("pro20x", "single");
    expect(ctx.db.select().from(childAccount).all()).toHaveLength(0);
    expect(await updateSpace(row.id, input("pro20x", "shared"))).toEqual({ ok: true });
    expect(ctx.db.select().from(childAccount).all()).toHaveLength(0);
    ctx.db.update(motherAccount).set({ usageStatus: "self" }).where(eq(motherAccount.spaceId, row.id)).run();
    expect(getProEarnings(ctx.db)[row.id].monthlyCostUsd).toBe(20000);
  });
});
