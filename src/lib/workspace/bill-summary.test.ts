import { describe, expect, it } from "vitest";
import type { BillData, EntryData, OperationsSnapshot, OpsRecord } from "../operations/types";
import { billSummary } from "./bill-summary";

const metadata = { tags: [], group: "", note: "" };
const fx = { rateToUsd: "0.15", rateToCny: "1", cnyRateToUsd: "0.15", quoteDate: "2026-10-13", fetchedAt: "2026-10-13T00:00:00Z", source: "synthetic", minorUnit: 2 };
const record = <T extends BillData | EntryData>(id: string, kind: "bill" | "entry", data: T): OpsRecord<T> => ({ id, kind, data, revision: 1, updatedAt: "2026-10-13T00:00:00Z" });
function snapshot(status: BillData["status"] = "open"): Pick<OperationsSnapshot, "bills" | "entries"> {
  return {
    bills: [record("bill", "bill", { ...metadata, subscriptionId: "subscription", startDate: "2026-10-01", endDate: "2026-11-01", dueDate: "2026-10-01", amountMinor: 8000, discountMinor: 0, currency: "CNY", usdMinor: 1200, cnyMinor: 8000, fx, status })],
    entries: [],
  };
}
function entry(id: string, type: EntryData["type"], appliedMinor: number, overrides: Partial<EntryData> = {}): OpsRecord<EntryData> {
  return record(id, "entry", { ...metadata, billId: "bill", type, amountMinor: appliedMinor, appliedMinor, currency: "CNY", feePercent: "0", feeAmountMinor: 0, totalMinor: appliedMinor, usdMinor: 0, cnyMinor: appliedMinor, fx, date: "2026-10-13", status: "posted", ...overrides });
}

describe("workspace bill summary", () => {
  it("shows zero actual receipts and zero outstanding for a void bill without payment", () => {
    const value = snapshot("void");
    const before = structuredClone(value);
    expect(billSummary(value, "bill")).toEqual({ billId: "bill", amountMinor: 0, receivedMinor: 0, outstandingMinor: 0, currency: "CNY", status: "void", isVoid: true });
    expect(value).toEqual(before);
  });

  it("calculates partial payments and refunds from posted bill-currency applications", () => {
    const value = snapshot();
    value.bills[0].data.discountMinor = 500;
    value.entries = [
      entry("partial", "receipt", 3000),
      entry("foreign-topup", "receipt", 2000, { currency: "USD", amountMinor: 300, totalMinor: 300 }),
      entry("refund", "refund", 1000),
      entry("cancelled-receipt", "receipt", 7000, { status: "void" }),
      entry("other-bill", "receipt", 7000, { billId: "other" }),
      entry("purchase", "cost", 7000),
    ];
    expect(billSummary(value, "bill")).toEqual({ billId: "bill", amountMinor: 7500, receivedMinor: 4000, outstandingMinor: 3500, currency: "CNY", status: "open", isVoid: false });
  });

  it("keeps actual net receipt independent of a void bill and ignores unapplied entries", () => {
    const value = snapshot("void");
    value.entries = [entry("receipt", "receipt", 3000), entry("refund", "refund", 1000), entry("unapplied", "receipt", 5000, { appliedMinor: undefined })];
    expect(billSummary(value, "bill")).toMatchObject({ amountMinor: 0, receivedMinor: 2000, outstandingMinor: 0, isVoid: true });
    expect(billSummary(value, "missing")).toBeNull();
  });
});
