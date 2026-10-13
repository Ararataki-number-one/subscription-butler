// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "@/test/db-harness";
import {
  countSpacesByChannel,
  insertChannel,
  setChannelActive,
  renameChannelRow,
  listChannels,
  getChannelUsage,
} from "@/db/channels";
import { seedCurrencies } from "@/db/seed";
import { paymentChannel, space } from "@/db/schema";

describe("channel queries (REF-01 / D-05..D-08)", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    ctx = createTestDb();
  });

  afterEach(() => {
    ctx.sqlite.close();
  });

  it("insert creates an active row with a new surrogate id", () => {
    const row = insertChannel(ctx.db, "支付宝");
    expect(row.id).toBeGreaterThan(0);
    expect(row.isActive).toBe(true);
    expect(row.name).toBe("支付宝");
  });

  it("archive (soft-delete) preserves the row but excludes it from the active list (D-06)", () => {
    const row = insertChannel(ctx.db, "支付宝");
    setChannelActive(ctx.db, row.id, false);

    // The row STILL EXISTS — soft-delete never removes it (count unchanged).
    const all = ctx.db.select().from(paymentChannel).all();
    expect(all).toHaveLength(1);

    // ...but it drops out of the active-only picker query (D-07).
    const active = listChannels(ctx.db, false);
    expect(active.find((r) => r.id === row.id)).toBeUndefined();
  });

  it("reactivate restores the row to the active list (D-08)", () => {
    const row = insertChannel(ctx.db, "微信");
    setChannelActive(ctx.db, row.id, false);
    setChannelActive(ctx.db, row.id, true);

    const active = listChannels(ctx.db, false);
    expect(active.find((r) => r.id === row.id)).toBeDefined();
  });

  it("rename keeps the same surrogate id (D-05)", () => {
    const row = insertChannel(ctx.db, "支付宝");
    const renamed = renameChannelRow(ctx.db, row.id, "支付宝-个人");
    expect(renamed.id).toBe(row.id);
    expect(renamed.name).toBe("支付宝-个人");
  });

  it("show-archived list returns all rows; active list filters is_active=1", () => {
    const a = insertChannel(ctx.db, "支付宝");
    const b = insertChannel(ctx.db, "微信");
    setChannelActive(ctx.db, b.id, false);

    expect(listChannels(ctx.db, true)).toHaveLength(2);
    const active = listChannels(ctx.db, false);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(a.id);
  });

  it("counts spaces bound to each channel", () => {
    seedCurrencies(ctx.db);
    const visa = insertChannel(ctx.db, "Visa");
    const alipay = insertChannel(ctx.db, "Alipay");
    ctx.db
      .insert(space)
      .values([
        {
          name: "First Visa Space",
          country: "US",
          paymentChannelId: visa.id,
          currencyCode: "USD",
          amountMinor: 1000,
        },
        {
          name: "Second Visa Space",
          country: "US",
          paymentChannelId: visa.id,
          currencyCode: "USD",
          amountMinor: 2000,
        },
        {
          name: "Alipay Space",
          country: "CN",
          paymentChannelId: alipay.id,
          currencyCode: "CNY",
          amountMinor: 3000,
        },
      ])
      .run();

    expect(countSpacesByChannel(ctx.db)).toEqual({
      [visa.id]: 2,
      [alipay.id]: 1,
    });
  });

  it("summarizes Team and independent subscriptions with unconverted costs and renewal risks", () => {
    seedCurrencies(ctx.db);
    const channel = insertChannel(ctx.db, "Main card");
    const unused = insertChannel(ctx.db, "Backup");
    const base = { country: "US", paymentChannelId: channel.id, currencyCode: "USD", amountMinor: 1000 };
    ctx.db.insert(space).values([
      { ...base, name: "Expired Team", amountUsd: 1000, expiryDate: "2026-06-14" },
      { ...base, name: "Plus today", planType: "plus", amountUsd: 2000, expiryDate: "2026-06-15" },
      { ...base, name: "Pro soon", planType: "pro5x", amountUsd: 3000, expiryDate: "2026-06-22" },
      { ...base, name: "Later", planType: "pro20x", amountUsd: 4000, expiryDate: "2026-06-23" },
      { ...base, name: "No snapshot", amountUsd: null, expiryDate: null },
    ]).run();
    setChannelActive(ctx.db, channel.id, false);
    const usage = getChannelUsage(ctx.db, new Date(2026, 5, 15), 7);
    expect(usage[channel.id]).toMatchObject({
      total: 5, teamCount: 2, independentCount: 3, costUsdMinor: 10000,
      missingCostCount: 1, overdueCount: 1, soonCount: 2, nextExpiryDate: "2026-06-15",
    });
    expect(usage[channel.id].subscriptions).toHaveLength(5);
    expect(usage[unused.id]).toBeUndefined();
    expect(getChannelUsage(ctx.db, new Date(2026, 5, 15), 0)[channel.id].soonCount).toBe(1);
  });
});
