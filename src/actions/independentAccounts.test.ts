import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/action-auth", () => ({ hasAdminSession: vi.fn().mockResolvedValue(true) }));
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
import { accountReceipt, childAccount, space } from "@/db/schema";
import { getSpaceDetail } from "@/db/spaces";
import { listAccountReceipts } from "@/db/accountReceipts";
import { getDashboardOverview } from "@/db/dashboard";
import { createSpace, updateSpace, renewSpace } from "./spaces";
import { createChildAccount, updateMotherSeat } from "./childAccounts";
import { saveAccountReceipt, deleteAccountReceipt } from "./accountReceipts";
import { deleteCurrency, updateCurrency } from "./currencies";
import type { SpacePlanType } from "@/lib/space-plans";

describe("independent subscription accounts", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let channelId: number;
  beforeEach(() => {
    ctx = createTestDb();
    holder.db = ctx.db;
    seedCurrencies(ctx.db);
    channelId = insertChannel(ctx.db, "Card").id;
    upsertRates(ctx.db, ["USD", "CNY", "EUR", "BOB"].map(code => ({
      currencyCode: code, rateToUsd: code === "USD" ? "1" : "0.2",
      fetchedAt: "2026-06-15T12:00:00Z", quoteDate: "2026-06-15", source: "frankfurter",
    })));
  });
  afterEach(() => { ctx.sqlite.close(); vi.clearAllMocks(); });

  function input(planType?: SpacePlanType) {
    return { name: "Subscription", planType, customPlanName: planType === "custom" ? "Other plan" : "",
      contact: "Customer", motherEmail: "personal@example.com", country: "US",
      paymentChannelId: channelId, currencyCode: "USD", amountMinor: 2000,
      openingDate: "2026-06-01", currentPeriodStartDate: "2026-06-01",
      periodUnit: "month", periodCount: 1 };
  }
  async function create(planType: SpacePlanType = "plus") {
    expect(await createSpace(input(planType))).toEqual({ ok: true });
    return ctx.db.select().from(space).all().at(-1)!;
  }
  function receipt(spaceId: number, currencyCode = "CNY", receivedDate = "2026-06-15") {
    return { spaceId, currencyCode, receivedDate, amountMinor: 10000, payer: "Customer", note: "June payment" };
  }
  const childInput = { seatType: "chatgpt", email: "child@example.com", contact: "Customer", label: "",
    joinedDate: "2026-06-01", monthlyAmountMinor: 2000, monthlyCurrencyCode: "USD",
    monthlyPaymentDay: 1, billingPeriodUnit: "month", billingPeriodCount: 1 };

  it.each(["team", "plus", "pro5x", "pro20x", "custom"] as const)("creates %s with cost and expiry", async plan => {
    const row = await create(plan);
    expect(row).toMatchObject({ planType: plan, amountUsd: 2000, expiryDate: "2026-07-01" });
    expect(getSpaceDetail(ctx.db, row.id)?.motherAccount.email).toBe("personal@example.com");
    expect(ctx.db.select().from(childAccount).all()).toHaveLength(0);
    expect(listAccountReceipts(ctx.db, row.id)).toHaveLength(0);
  });

  it("defaults old payloads to Team and preserves a personal type on old edit payloads", async () => {
    expect(await createSpace(input())).toEqual({ ok: true });
    expect(ctx.db.select().from(space).get()?.planType).toBe("team");
    const personal = await create("pro5x");
    expect(await updateSpace(personal.id, { ...input(), name: "Renamed" })).toEqual({ ok: true });
    expect(getSpaceDetail(ctx.db, personal.id)?.space.planType).toBe("pro5x");
  });

  it("rejects unknown plans and unnamed custom plans", async () => {
    expect((await createSpace({ ...input(), planType: "invalid" })).ok).toBe(false);
    expect((await createSpace({ ...input("custom"), customPlanName: " " })).ok).toBe(false);
    expect(ctx.db.select().from(space).all()).toHaveLength(0);
  });

  it("rejects child accounts and Team seat changes for an independent account", async () => {
    const row = await create();
    expect((await createChildAccount(row.id, childInput)).ok).toBe(false);
    expect((await updateMotherSeat(row.id, { seatType: "codex", canChangeSeatType: true })).ok).toBe(false);
    expect(ctx.db.select().from(childAccount).all()).toHaveLength(0);
  });

  it("does not hide existing Team children by changing the subscription type", async () => {
    const row = await create("team");
    expect(await createChildAccount(row.id, childInput)).toEqual({ ok: true });
    expect((await updateSpace(row.id, input("plus"))).ok).toBe(false);
    expect(getSpaceDetail(ctx.db, row.id)?.space.planType).toBe("team");
    expect(ctx.db.select().from(childAccount).all()).toHaveLength(1);
  });

  it("keeps receipt conversion on metadata edits and refreezes changed amounts", async () => {
    const row = await create();
    expect(await saveAccountReceipt(receipt(row.id))).toEqual({ ok: true });
    const saved = listAccountReceipts(ctx.db, row.id)[0].receipt;
    expect(saved).toMatchObject({ amountUsd: 2000, rateUsed: "0.2", rateAsOf: "2026-06-15" });
    upsertRates(ctx.db, [{ currencyCode: "CNY", rateToUsd: "0.25", fetchedAt: "2026-06-20T00:00:00Z" }]);
    expect(await saveAccountReceipt({ ...receipt(row.id), id: saved.id, note: "Corrected memo" })).toEqual({ ok: true });
    expect(listAccountReceipts(ctx.db, row.id)[0].receipt.amountUsd).toBe(2000);
    expect(await saveAccountReceipt({ ...receipt(row.id), id: saved.id, amountMinor: 12000 })).toEqual({ ok: true });
    expect(listAccountReceipts(ctx.db, row.id)[0].receipt.amountUsd).toBe(3000);
  });

  it("retains receipt history across plan upgrades and renewals", async () => {
    const row = await create();
    await saveAccountReceipt(receipt(row.id));
    const before = listAccountReceipts(ctx.db, row.id);
    expect(await updateSpace(row.id, input("pro20x"))).toEqual({ ok: true });
    expect(await renewSpace(row.id)).toEqual({ ok: true });
    expect(getSpaceDetail(ctx.db, row.id)?.space).toMatchObject({ planType: "pro20x", expiryDate: "2026-08-01" });
    expect(listAccountReceipts(ctx.db, row.id)).toEqual(before);
    expect((await updateSpace(row.id, input("team"))).ok).toBe(false);
  });

  it("rejects invalid receipt dates, amounts and account reassignment", async () => {
    const first = await create();
    const second = await create("pro5x");
    for (const override of [{ amountMinor: 0 }, { amountMinor: 1.5 }, { receivedDate: "2026-02-30" }, { currencyCode: "ZZZ" }]) {
      expect((await saveAccountReceipt({ ...receipt(first.id), ...override })).ok).toBe(false);
    }
    await saveAccountReceipt(receipt(first.id));
    const id = listAccountReceipts(ctx.db, first.id)[0].receipt.id;
    expect((await saveAccountReceipt({ ...receipt(second.id), id })).ok).toBe(false);
    expect(listAccountReceipts(ctx.db, first.id)).toHaveLength(1);
    expect(listAccountReceipts(ctx.db, second.id)).toHaveLength(0);
    const team = await create("team");
    expect((await saveAccountReceipt(receipt(team.id))).ok).toBe(false);
  });

  it("protects the currency and minor units of historical receipts", async () => {
    const row = await create();
    await saveAccountReceipt(receipt(row.id, "EUR"));
    expect((await deleteCurrency("EUR")).ok).toBe(false);
    expect((await updateCurrency("EUR", { name: "Euro", symbol: "€", minorUnit: 0 })).ok).toBe(false);
  });

  it("supports explicit receipt correction by deletion", async () => {
    const row = await create();
    await saveAccountReceipt(receipt(row.id));
    const id = listAccountReceipts(ctx.db, row.id)[0].receipt.id;
    expect(await deleteAccountReceipt(id)).toEqual({ ok: true });
    expect(listAccountReceipts(ctx.db, row.id)).toHaveLength(0);
    expect((await deleteAccountReceipt(id)).ok).toBe(false);
  });

  it("summarizes independent costs and calendar-month receipts without Team seat inflation", async () => {
    const row = await create();
    await create("team");
    await saveAccountReceipt(receipt(row.id, "CNY", "2026-06-15"));
    await saveAccountReceipt(receipt(row.id, "CNY", "2026-05-31"));
    await saveAccountReceipt(receipt(row.id, "CNY", "2026-07-01"));
    const overview = getDashboardOverview(ctx.db, new Date(2026, 5, 20));
    expect(overview.independentAccounts).toEqual({ count: 1, costUsdMinor: 2000, receivedThisMonthUsdMinor: 2000 });
    expect(overview.totals.spacePaymentUsdMinor).toBe(2000);
    expect(overview.totals.totalSpaces).toBe(2);
    expect(overview.counts.motherAccountsBySeatType).toEqual({ codex: 0, chatgpt: 1 });
    expect(overview.spacePerformance).toHaveLength(1);
  });

  it("cascades account deletion only to its own receipts", async () => {
    const first = await create();
    const second = await create();
    await saveAccountReceipt(receipt(first.id));
    await saveAccountReceipt(receipt(second.id));
    ctx.db.delete(space).where(eq(space.id, first.id)).run();
    expect(ctx.db.select().from(accountReceipt).all()).toHaveLength(1);
    expect(listAccountReceipts(ctx.db, second.id)).toHaveLength(1);
  });
});
