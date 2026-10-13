import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/db-harness";
const holder = vi.hoisted(() => ({ db: null as unknown as TestDb }));
vi.mock("@/db", () => ({ get db() { return holder.db; } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  notFound: () => { throw new Error("Not found"); },
}));
import { createTestDb } from "@/test/db-harness";
import { seedCurrencies } from "@/db/seed";
import { insertChannel } from "@/db/channels";
import { insertSpaceWithMother } from "@/db/spaces";
import { insertChildAccount } from "@/db/childAccounts";
import SpaceDetailPage from "@/app/(protected)/spaces/[id]/page";
import DashboardPage from "@/app/(protected)/page";
import { TooltipProvider } from "@/components/ui/tooltip";

describe("unified account and earnings pages", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let channelId: number;
  beforeEach(() => {
    ctx = createTestDb(); holder.db = ctx.db;
    vi.stubGlobal("React", React);
    seedCurrencies(ctx.db);
    channelId = insertChannel(ctx.db, "Card").id;
  });
  afterEach(() => { ctx.sqlite.close(); vi.unstubAllGlobals(); });
  function account(planType: "team" | "pro20x", sharingMode: "single" | "shared") {
    return insertSpaceWithMother(ctx.db, {
      name: planType, planType, sharingMode, country: "US", paymentChannelId: channelId,
      currencyCode: "USD", amountMinor: 2000, amountUsd: 2000,
      openingDate: "2026-10-01", currentPeriodStartDate: "2026-10-01",
      periodUnit: "month", periodCount: 1, expiryDate: "2026-11-01",
    }, "owner@example.com");
  }
  function member(spaceId: number, name: string) {
    return insertChildAccount(ctx.db, {
      spaceId, seatType: "chatgpt", email: name, contact: "Contact", joinedDate: "2026-10-01",
      monthlyCurrencyCode: "USD", monthlyAmountMinor: 3000, monthlyAmountUsd: 3000,
      monthlyRateUsed: "1", monthlyRateAsOf: "2026-10-01", monthlyRateSource: "frankfurter",
      monthlyPaymentDay: 11, nextPaymentDate: "2026-11-11",
    });
  }
  async function detail(id: number) {
    return renderToStaticMarkup(React.createElement(TooltipProvider, null,
      await SpaceDetailPage({ params: Promise.resolve({ id: String(id) }) })));
  }
  it("renders Business identity, seat settings, member actions and profit in one panel", async () => {
    const row = account("team", "shared");
    member(row.id, "child@example.com");
    const html = await detail(row.id);
    expect(html.match(/账号管理与收益/g)).toHaveLength(1);
    expect(html).not.toContain("母号席位");
    expect(html).not.toContain("Business 位置与收益");
    expect(html).toContain("编辑母号");
    expect(html).not.toContain("可变更席位类型");
    expect(html).not.toContain("codex");
    expect(html).toContain("child@example.com");
    expect(html).toContain("联系方式");
    expect(html).toContain("续费");
    expect(html).toContain("预计净收益 / 月");
  });
  it("renders multiple Pro members together and keeps Pro totals separately labeled", async () => {
    const business = account("team", "shared");
    member(business.id, "Business user");
    const pro = account("pro20x", "shared");
    member(pro.id, "Alice"); member(pro.id, "Bob");
    const html = await detail(pro.id);
    expect(html.match(/账号管理与收益/g)).toHaveLength(1);
    expect(html).toContain("新增拼车成员");
    expect(html).toContain("Alice"); expect(html).toContain("Bob");
    expect(html).not.toContain("母号席位");
    const dashboard = renderToStaticMarkup(React.createElement(TooltipProvider, null, React.createElement(DashboardPage)));
    expect(dashboard).toContain("Business 每月预计收益");
    expect(dashboard).toContain("Pro 每月预计收益");
    expect(dashboard).toContain("Pro 约定收入 / 月");
    expect(dashboard).toContain("Pro 预计净收益 / 月");
    expect(dashboard).not.toContain("codex");
  });
  it("shows only members for legacy single-Pro records", async () => {
    const pro = account("pro20x", "single");
    const html = await detail(pro.id);
    expect(html).not.toContain("主账号");
    expect(html).not.toContain("编辑母号");
    expect(html).toContain("新增拼车成员");
  });
});
