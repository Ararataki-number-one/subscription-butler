import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDb } from "@/test/db-harness";

const holder = vi.hoisted(() => ({ db: null as unknown as TestDb }));
vi.mock("@/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/action-auth", () => ({ hasAdminSession: vi.fn().mockResolvedValue(true) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/fx/frankfurter", () => ({ ensureFreshRates: vi.fn().mockResolvedValue({ stale: false }) }));

import { renewSpace, updateSpace } from "@/actions/spaces";
import { renewMotherAccount, updateTeamSeat } from "@/actions/teamSeats";
import { renewChildAccount } from "@/actions/childAccounts";
import { createTestDb } from "@/test/db-harness";
import { OperationsStore } from "./operations";
import { seedCurrencies } from "./seed";
import { insertChannel } from "./channels";
import { upsertRates } from "./fxRates";
import { getSpaceDetail, insertSpaceWithMother } from "./spaces";
import { getChildAccount, insertChildAccount } from "./childAccounts";
import { motherAccount, space } from "./schema";

describe("explicit classic renewal history", () => {
  let context: ReturnType<typeof createTestDb>, store: OperationsStore, channelId: number;
  beforeEach(() => {
    context = createTestDb(); holder.db = context.db; seedCurrencies(context.db);
    channelId = insertChannel(context.db, "Synthetic card", { feePercent: "2.5" }).id;
    upsertRates(context.db, [{ currencyCode: "USD", rateToUsd: "1", fetchedAt: "2026-01-20T04:00:00Z", source: "synthetic" },
      { currencyCode: "CNY", rateToUsd: "0.2", fetchedAt: "2026-01-20T04:00:00Z", source: "synthetic" }]);
    store = new OperationsStore(context.sqlite);
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-20T04:00:00Z"));
  });
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); context.sqlite.close(); });
  function subscription(planType: "team" | "pro20x" = "team") {
    const row = insertSpaceWithMother(context.db, { name: "Synthetic service", planType, country: "US", contact: "Original contact",
      paymentChannelId: channelId, currencyCode: "USD", amountMinor: 1000, amountUsd: 1025, baseAmountUsd: 1000,
      feePercent: "2.5", feeAmountMinor: 25, rateUsed: "1", rateAsOf: "2026-01-01", rateSource: "synthetic",
      periodUnit: "month", periodCount: 1, openingDate: "2026-01-31", currentPeriodStartDate: "2026-01-31", expiryDate: "2026-02-28" }, "synthetic-owner@example.invalid");
    context.db.update(motherAccount).set({ usageStatus: "rented", contact: "Synthetic mother", label: "Original label", joinedDate: "2026-01-31",
      monthlyPaymentDay: 31, nextPaymentDate: "2026-02-28", billingPeriodUnit: "month", billingPeriodCount: 1,
      expectedAmountMinor: 8000, expectedCurrencyCode: "CNY", expectedAmountUsd: 1600, expectedRateUsed: "0.2",
      expectedRateAsOf: "2026-01-01", expectedRateSource: "synthetic" }).where(eq(motherAccount.spaceId, row.id)).run();
    return row;
  }
  function child(spaceId: number, alias = false) {
    return insertChildAccount(context.db, { spaceId, email: alias ? "synthetic-owner@example.invalid" : "synthetic-child@example.invalid",
      isMotherAccount: alias, usageStatus: "rented", contact: "Synthetic child", label: "Original child label", joinedDate: "2026-01-31", monthlyPaymentDay: 31,
      nextPaymentDate: "2026-02-28", billingPeriodUnit: "quarter", billingPeriodCount: 1, monthlyAmountMinor: 9000,
      monthlyCurrencyCode: "CNY", monthlyAmountUsd: 1800, monthlyRateUsed: "0.2", monthlyRateAsOf: "2026-01-01", monthlyRateSource: "synthetic" });
  }
  const sources = () => ({ spaces: context.sqlite.prepare("SELECT * FROM space ORDER BY id").all(),
    mothers: context.sqlite.prepare("SELECT * FROM mother_account ORDER BY id").all(), children: context.sqlite.prepare("SELECT * FROM child_account ORDER BY id").all() });
  const counts = () => ({ changes: context.sqlite.prepare("SELECT COUNT(*) n FROM ops_change").get(),
    audits: context.sqlite.prepare("SELECT COUNT(*) n FROM ops_audit").get(), commands: context.sqlite.prepare("SELECT COUNT(*) n FROM ops_command").get() });
  function expectNoFinancialEntries() {
    const snapshot = store.snapshot(); expect(snapshot.bills).toEqual([]); expect(snapshot.entries).toEqual([]);
    expect(context.sqlite.prepare("SELECT COUNT(*) n FROM account_receipt").get()).toEqual({ n: 0 });
  }

  it("captures the original expiry while retaining classic FX, fees, opening date and contact", async () => {
    const source = subscription(); store.snapshot();
    upsertRates(context.db, [{ currencyCode: "USD", rateToUsd: "1.25", fetchedAt: "2026-01-20T04:00:00Z", source: "synthetic-new" }]);
    expect(await renewSpace(source.id, "2026-02-28")).toEqual({ ok: true });
    expect(getSpaceDetail(context.db, source.id)!.space).toMatchObject({ openingDate: "2026-01-31", currentPeriodStartDate: "2026-02-28",
      expiryDate: "2026-03-28", contact: "Original contact", amountMinor: 1000, feePercent: "2.5", feeAmountMinor: 25,
      rateUsed: "1.25", baseAmountUsd: 1250, amountUsd: 1281, periodUnit: "month", periodCount: 1 });
    expect(store.snapshot().subscriptions[0].data.calendarHistory).toEqual([expect.objectContaining({ dueDate: "2026-02-28", nextDueDate: "2026-03-28",
      name: "Synthetic service", account: "synthetic-owner@example.invalid", amountMinor: 1000, currency: "USD", feePercent: "2.5" })]);
    expect(store.audit().filter(row => row.action === "classic.renew")).toHaveLength(1);
    expectNoFinancialEntries();
  });

  it("keeps mother aliases synchronized with one canonical completion and replays the same dated request", async () => {
    const source = subscription(), alias = child(source.id, true); store.snapshot();
    expect(await renewMotherAccount(source.id, "2026-02-28")).toEqual({ ok: true });
    expect(getSpaceDetail(context.db, source.id)!.motherAccount).toMatchObject({ nextPaymentDate: "2026-03-31", contact: "Synthetic mother",
      label: "Original label", billingPeriodUnit: "month", billingPeriodCount: 1, expectedAmountMinor: 8000, expectedRateUsed: "0.2" });
    expect(getChildAccount(context.db, alias.id)!.nextPaymentDate).toBe("2026-03-31");
    expect(await renewChildAccount(alias.id, "2026-02-28")).toEqual({ ok: true });
    const snapshot = store.snapshot(); expect(snapshot.rentals).toHaveLength(1);
    expect(snapshot.rentals[0].data.calendarHistory).toEqual([expect.objectContaining({ dueDate: "2026-02-28", nextDueDate: "2026-03-31",
      account: "synthetic-owner@example.invalid", customerName: "Synthetic mother", role: "母号", amountMinor: 8000, currency: "CNY", slotKind: "mother" })]);
    expect(getSpaceDetail(context.db, source.id)!.motherAccount.nextPaymentDate).toBe("2026-03-31");
    expect(store.audit().filter(row => row.action === "classic.renew")).toHaveLength(1);
    expectNoFinancialEntries();
  });

  it("preserves member billing and original overdue calculation while adding completion history", async () => {
    const source = subscription("pro20x"), member = child(source.id); store.snapshot();
    vi.setSystemTime(new Date("2026-06-05T04:00:00Z"));
    expect(await renewChildAccount(member.id, "2026-02-28")).toEqual({ ok: true });
    const row = getChildAccount(context.db, member.id)!;
    expect(row).toMatchObject({ nextPaymentDate: "2026-06-30", monthlyAmountMinor: 9000, monthlyCurrencyCode: "CNY",
      monthlyRateUsed: "0.2", billingPeriodUnit: "quarter", billingPeriodCount: 1, contact: "Synthetic child", label: "Original child label" });
    expect(store.snapshot().rentals[0].data.calendarHistory).toEqual([expect.objectContaining({ dueDate: "2026-02-28", nextDueDate: "2026-06-30",
      account: "synthetic-child@example.invalid", role: "拼车成员", slotKind: "member", amountMinor: 9000, currency: "CNY" })]);
    expect(getSpaceDetail(context.db, source.id)!.motherAccount.nextPaymentDate).toBe("2026-02-28");
    expectNoFinancialEntries();
  });

  it("does not mark manual subscription or mother schedule edits as renewal", async () => {
    const source = subscription(); store.snapshot();
    expect(await updateSpace(source.id, { name: source.name, planType: "team", country: "US", contact: source.contact,
      paymentChannelId: channelId, currencyCode: "USD", amountMinor: source.amountMinor, openingDate: "2026-01-31",
      currentPeriodStartDate: "2026-03-01", periodUnit: "month", periodCount: 1, motherEmail: "synthetic-owner@example.invalid" })).toEqual({ ok: true });
    const mother = getSpaceDetail(context.db, source.id)!.motherAccount;
    expect(await updateTeamSeat({ role: "mother", spaceId: source.id, id: mother.id, usageStatus: "rented", contact: mother.contact,
      amountMinor: 8000, currencyCode: "CNY", billingPeriodUnit: "month", billingPeriodCount: 1,
      joinedDate: "2026-03-01", monthlyPaymentDay: 31 })).toEqual({ ok: true });
    const snapshot = store.snapshot(); expect(snapshot.subscriptions[0].data.calendarHistory).toBeUndefined();
    expect(snapshot.rentals[0].data.calendarHistory).toBeUndefined(); expect(store.audit().some(row => row.action === "classic.renew")).toBe(false);
    expectNoFinancialEntries();
  });

  it.each(["source", "history", "command"])("rolls back source dates, history, audit and commands when %s write fails", async stage => {
    const source = subscription(); store.snapshot(); const beforeSources = sources(), beforeCounts = counts();
    const trigger = stage === "source" ? "BEFORE UPDATE ON space" : stage === "history"
      ? "BEFORE UPDATE ON ops_record WHEN COALESCE(json_array_length(NEW.data, '$.calendarHistory'), 0) > COALESCE(json_array_length(OLD.data, '$.calendarHistory'), 0)"
      : "BEFORE INSERT ON ops_command";
    context.sqlite.exec(`CREATE TRIGGER synthetic_failure ${trigger} BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
    expect((await renewSpace(source.id, "2026-02-28")).ok).toBe(false);
    expect(sources()).toEqual(beforeSources); expect(counts()).toEqual(beforeCounts);
    expect(store.snapshot().subscriptions[0].data.calendarHistory).toBeUndefined(); expectNoFinancialEntries();
  });

  it("replays an original dated subscription request and rejects a stale manual-date request", async () => {
    const source = subscription(); store.snapshot();
    expect(await renewSpace(source.id, "2026-02-28")).toEqual({ ok: true });
    const saved = sources(), savedCounts = counts();
    expect(await renewSpace(source.id, "2026-02-28")).toEqual({ ok: true });
    expect(sources()).toEqual(saved); expect(counts()).toEqual(savedCounts);
    context.db.update(space).set({ currentPeriodStartDate: "2026-04-01", expiryDate: "2026-05-01" }).where(eq(space.id, source.id)).run();
    expect((await renewSpace(source.id, "2026-03-28")).ok).toBe(false);
    expect(getSpaceDetail(context.db, source.id)!.space.expiryDate).toBe("2026-05-01");
    expect(store.snapshot().subscriptions[0].data.calendarHistory).toHaveLength(1); expectNoFinancialEntries();
  });

  it.each(["replicated", "conflict"])("rejects %s source authority without advancing dates", async state => {
    const source = subscription(), record = store.snapshot().subscriptions[0];
    if (state === "replicated") store.applyReplica({ id: "synthetic-replica", records: [{ ...record, expectedRevision: record.revision,
      sourceRevision: record.revision, data: { ...record.data, name: "Remote authoritative service" } }] });
    else context.sqlite.prepare("INSERT INTO ops_legacy_conflict(record_id,local_fingerprint,detected_at) VALUES(?,?,?)").run(record.id, "synthetic", "2026-01-20T04:00:00Z");
    const before = sources(); expect((await renewSpace(source.id, "2026-02-28")).ok).toBe(false);
    expect(sources()).toEqual(before); expect(store.snapshot().subscriptions[0].data.calendarHistory).toBeUndefined(); expectNoFinancialEntries();
  });

  it("rolls back a nested Drizzle mother alias update when its history cannot commit", async () => {
    const source = subscription(); child(source.id, true); store.snapshot(); const before = sources();
    context.sqlite.exec("CREATE TRIGGER synthetic_history_failure BEFORE UPDATE ON ops_record WHEN COALESCE(json_array_length(NEW.data, '$.calendarHistory'), 0) > 0 BEGIN SELECT RAISE(ABORT, 'synthetic history failure'); END;");
    expect((await renewMotherAccount(source.id, "2026-02-28")).ok).toBe(false);
    expect(sources()).toEqual(before); expect(store.snapshot().rentals[0].data.calendarHistory).toBeUndefined(); expectNoFinancialEntries();
  });

  it("keeps missing-FX subscription renewal fully unchanged", async () => {
    const source = subscription(); store.snapshot(); const before = sources(), beforeCounts = counts();
    context.sqlite.prepare("DELETE FROM fx_rate WHERE currency_code='USD'").run();
    expect((await renewSpace(source.id, "2026-02-28")).ok).toBe(false);
    expect(sources()).toEqual(before); expect(counts()).toEqual(beforeCounts);
    expect(store.snapshot().subscriptions[0].data.calendarHistory).toBeUndefined(); expectNoFinancialEntries();
  });
});
