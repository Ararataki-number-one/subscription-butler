import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDb } from "@/test/db-harness";
const holder = vi.hoisted(() => ({ db: null as unknown as TestDb }));
vi.mock("@/db", () => ({ get db() { return holder.db; } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/fx/frankfurter", () => ({ ensureFreshRates: vi.fn().mockResolvedValue({ stale: false }) }));
import { createTestDb } from "@/test/db-harness";
import { seedCurrencies } from "@/db/seed";
import { insertChannel, getChannelUsage } from "@/db/channels";
import { upsertRates } from "@/db/fxRates";
import { getSpaceDetail, listSpaceDetails } from "@/db/spaces";
import { listChildAccounts, getChildAccount } from "@/db/childAccounts";
import { getAccountEarnings } from "@/db/teamEarnings";
import { motherAccount, space, childAccountReminderSubscription } from "@/db/schema";
import { createSpace, updateSpace, renewSpace } from "./spaces";
import { updateChannel } from "./channels";
import { createChildAccount, updateChildAccount, deleteChildAccount, renewChildAccount } from "./childAccounts";
import { renewMotherAccount, updateTeamSeat } from "./teamSeats";

describe("member identity and percentage fees", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let channelId: number;
  beforeEach(() => {
    ctx = createTestDb(); holder.db = ctx.db; seedCurrencies(ctx.db);
    channelId = insertChannel(ctx.db, "Card", { feePercent: "2.5" }).id;
    upsertRates(ctx.db, ["USD", "CNY"].map(code => ({
      currencyCode: code, rateToUsd: code === "USD" ? "1" : "0.2", quoteDate: "2026-10-01",
      fetchedAt: "2026-10-01T00:00:00Z", source: "frankfurter",
    })));
  });
  afterEach(() => { ctx.sqlite.close(); vi.useRealTimers(); });
  function subscription(planType = "team", name = planType) {
    return { name, planType, country: "US", paymentChannelId: channelId, currencyCode: "CNY",
      amountMinor: 10000, openingDate: "2026-10-01", currentPeriodStartDate: "2026-10-01",
      periodUnit: "month", periodCount: 1, motherEmail: "owner@example.com" };
  }
  async function create(plan = "team", name = plan) {
    expect(await createSpace(subscription(plan, name))).toEqual({ ok: true });
    return ctx.db.select().from(space).all().at(-1)!;
  }
  function member(email = "member@example.com", overrides = {}) {
    return { email, seatType: "chatgpt", usageStatus: "rented", contact: "Customer", label: "Rental",
      joinedDate: "2026-10-01", monthlyPaymentDay: 15, billingPeriodUnit: "month", billingPeriodCount: 1,
      monthlyAmountMinor: 8000, monthlyCurrencyCode: "CNY", ...overrides };
  }
  it("calculates initial, edited and renewed costs with the channel percentage", async () => {
    const row = await create();
    expect(getSpaceDetail(ctx.db, row.id)!.space).toMatchObject({
      amountMinor: 10000, baseAmountUsd: 2000, feePercent: "2.5", feeAmountMinor: 250, amountUsd: 2050,
    });
    expect(await updateSpace(row.id, { ...subscription(), amountMinor: 20000 })).toEqual({ ok: true });
    expect(getSpaceDetail(ctx.db, row.id)!.space).toMatchObject({ baseAmountUsd: 4000, feeAmountMinor: 500, amountUsd: 4100 });
    expect(await renewSpace(row.id)).toEqual({ ok: true });
    expect(getSpaceDetail(ctx.db, row.id)!.space.amountUsd).toBe(4100);
  });
  it("recalculates every linked cost and profit using the original FX snapshot", async () => {
    const business = await create();
    const pro = await create("pro20x");
    await createChildAccount(business.id, member());
    await createChildAccount(pro.id, member("Alice"));
    upsertRates(ctx.db, [{ currencyCode: "CNY", rateToUsd: "0.9", fetchedAt: "2026-10-12T00:00:00Z" }]);
    expect(await updateChannel(channelId, { name: "Card", feePercent: "5" })).toEqual({ ok: true });
    for (const row of [business, pro]) {
      expect(getSpaceDetail(ctx.db, row.id)!.space).toMatchObject({
        amountMinor: 10000, baseAmountUsd: 2000, amountUsd: 2100, feeAmountMinor: 500,
        rateUsed: "0.2", rateAsOf: "2026-10-01",
      });
      expect(getAccountEarnings(ctx.db)[row.id].monthlyNetUsd).toBe(-500);
    }
    expect(getChannelUsage(ctx.db)[channelId].costUsdMinor).toBe(4200);
    expect(await updateChannel(channelId, { name: "Renamed" })).toEqual({ ok: true });
    expect(getSpaceDetail(ctx.db, pro.id)!.space.amountUsd).toBe(2100);
    expect(await updateChannel(channelId, { name: "Renamed", feePercent: "0" })).toEqual({ ok: true });
    expect(getSpaceDetail(ctx.db, pro.id)!.space.amountUsd).toBe(2000);
  });
  it("uses the new channel's fee on reassignment without refreshing a historical base cost", async () => {
    const row = await create();
    const second = insertChannel(ctx.db, "Other", { feePercent: "10" });
    upsertRates(ctx.db, [{ currencyCode: "CNY", rateToUsd: "0.9", fetchedAt: "2026-10-12T00:00:00Z" }]);
    expect(await updateSpace(row.id, { ...subscription(), paymentChannelId: second.id })).toEqual({ ok: true });
    expect(getSpaceDetail(ctx.db, row.id)!.space).toMatchObject({ amountUsd: 2200, baseAmountUsd: 2000, rateUsed: "0.2" });
  });
  it("rolls back a fee change and every related cost when a total overflows", async () => {
    const first = await create();
    const second = await create("pro5x");
    ctx.db.update(space).set({ amountMinor: Number.MAX_SAFE_INTEGER }).where(eq(space.id, second.id)).run();
    const before = ctx.db.select().from(space).all();
    expect((await updateChannel(channelId, { name: "Changed", feePercent: "100" })).ok).toBe(false);
    expect(ctx.db.select().from(space).all()).toEqual(before);
    expect(getSpaceDetail(ctx.db, first.id)!.paymentChannel).toMatchObject({ name: "Card", feePercent: "2.5" });
  });
  it("routes a new same-email rental into the mother instead of adding a child", async () => {
    const row = await create();
    expect(await createChildAccount(row.id, member(" OWNER@example.com "))).toEqual({ ok: true });
    expect(listChildAccounts(ctx.db, row.id)).toHaveLength(0);
    expect(getSpaceDetail(ctx.db, row.id)!.motherAccount).toMatchObject({ contact: "Customer", expectedAmountUsd: 1600 });
    expect(await createChildAccount(row.id, member())).toEqual({ ok: true });
    expect(getAccountEarnings(ctx.db)[row.id].monthlyIncomeUsd).toBe(3200);
    expect(getAccountEarnings(ctx.db)[row.id].seats).toHaveLength(2);
  });
  it("promotes an existing child, preserves its reminder id, and synchronizes mother edits and renewals", async () => {
    const row = await create();
    await createChildAccount(row.id, member("temporary@example.com"));
    const id = listChildAccounts(ctx.db, row.id)[0].childAccount.id;
    ctx.db.insert(childAccountReminderSubscription).values({ childAccountId: id, email: "alerts@example.com" }).run();
    expect(await updateChildAccount(id, member("owner@example.com"))).toEqual({ ok: true });
    expect(listChildAccounts(ctx.db, row.id)).toHaveLength(0);
    expect(getChildAccount(ctx.db, id)!.isMotherAccount).toBe(true);
    expect(listSpaceDetails(ctx.db)[0].childCount).toBe(0);
    const mother = getSpaceDetail(ctx.db, row.id)!.motherAccount;
    expect(getAccountEarnings(ctx.db)[row.id].monthlyIncomeUsd).toBe(1600);
    expect(await updateTeamSeat({ spaceId: row.id, role: "mother", id: mother.id, email: mother.email,
      usageStatus: "rented", contact: "Updated", label: "Note", amountMinor: 8000, currencyCode: "CNY",
      billingPeriodUnit: "month", billingPeriodCount: 1, joinedDate: mother.joinedDate, monthlyPaymentDay: mother.monthlyPaymentDay })).toEqual({ ok: true });
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 12));
    expect(await renewMotherAccount(row.id)).toEqual({ ok: true });
    expect(getChildAccount(ctx.db, id)).toMatchObject({ contact: "Updated", label: "Note", nextPaymentDate: "2026-11-15" });
    expect(await renewChildAccount(id)).toEqual({ ok: true });
    expect(getSpaceDetail(ctx.db, row.id)!.motherAccount.nextPaymentDate).toBe("2026-12-15");
    expect(getChildAccount(ctx.db, id)!.nextPaymentDate).toBe("2026-12-15");
    expect((await deleteChildAccount(id)).ok).toBe(false);
    expect(ctx.db.select().from(childAccountReminderSubscription).get()!.childAccountId).toBe(id);
    expect(await updateSpace(row.id, { ...subscription(), motherEmail: "renamed@example.com" })).toEqual({ ok: true });
    expect(getChildAccount(ctx.db, id)!.email).toBe("renamed@example.com");
    expect(listChildAccounts(ctx.db, row.id)).toHaveLength(0);
  });
  it("ignores legacy Pro main-account income and allocates the entire cost among members", async () => {
    const row = await create("pro20x");
    ctx.db.update(motherAccount).set({ usageStatus: "rented", expectedAmountMinor: 10, expectedAmountUsd: 1 })
      .where(eq(motherAccount.spaceId, row.id)).run();
    await createChildAccount(row.id, member("Alice"));
    const value = getAccountEarnings(ctx.db)[row.id];
    expect(value.seats).toHaveLength(1);
    expect(value.seats[0]).toMatchObject({ role: "child", monthlyIncomeUsd: 1600, monthlyCostUsd: 2050, monthlyNetUsd: -450 });
    expect(value.monthlyIncomeUsd).toBe(1600);
    expect(value.monthlyNetUsd).toBe(-450);
  });
  it("preserves an actual Business mother rental when changing the subscription to Pro", async () => {
    const row = await create();
    await createChildAccount(row.id, member("owner@example.com"));
    await createChildAccount(row.id, member("Other"));
    const before = getAccountEarnings(ctx.db)[row.id];
    expect(await updateSpace(row.id, subscription("pro20x"))).toEqual({ ok: true });
    const value = getAccountEarnings(ctx.db)[row.id];
    expect(value.seats).toHaveLength(2);
    expect(value.seats.every(seat => seat.role === "child")).toBe(true);
    expect(value.monthlyIncomeUsd).toBe(before.monthlyIncomeUsd);
    expect(value.monthlyNetUsd).toBe(before.monthlyNetUsd);
  });
});
