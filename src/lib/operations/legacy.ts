import type Database from "better-sqlite3";
import type { EntryData, Metadata, OpsData, OpsKind, Period, RentalData, SlotData, SubscriptionData } from "./types";
import { addPeriod, fingerprint, shanghaiToday } from "./utils";

type Row = Record<string, string | number | null>;
export type LegacyCandidate = { id: string; kind: OpsKind; data: OpsData };
const string = (row: Row, key: string, fallback = "") => row[key] === null || row[key] === undefined ? fallback : String(row[key]);
const number = (row: Row, key: string, fallback = 0) => row[key] === null || row[key] === undefined ? fallback : Number(row[key]);
const periodOf = (row: Row, unit: string, count: string): Period => ({ unit: ["day", "month", "quarter", "year"].includes(string(row, unit)) ? string(row, unit) as Period["unit"] : "month", count: Math.max(1, number(row, count, 1)) });
function rows(sqlite: Database.Database, table: string): Row[] {
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return [];
  return sqlite.prepare(`SELECT * FROM ${table}`).all() as Row[]; // table names are fixed below, never external input.
}
function meta(note = ""): Metadata { return { tags: [], group: "", note }; }
function linked(data: OpsData, sources: string[]): OpsData {
  return { ...data, legacy: { sources, fingerprint: fingerprint(data), managedFields: Object.keys(data), present: true } };
}

/** Read-only projection of old tables. No guessed bill allocation or manufactured Pro owner slot. */
export function legacyCandidates(sqlite: Database.Database): LegacyCandidate[] {
  const result: LegacyCandidate[] = [];
  const spaces = rows(sqlite, "space"); const mothers = rows(sqlite, "mother_account"); const children = rows(sqlite, "child_account");
  const today = shanghaiToday();
  for (const space of spaces) {
    const subscriptionId = `legacy:subscription:${space.id}`;
    const mother = mothers.find(row => row.space_id === space.id);
    const pro = ["pro5x", "pro20x"].includes(string(space, "plan_type"));
    const period = periodOf(space, "period_unit", "period_count");
    const startDate = string(space, "current_period_start_date", string(space, "opening_date", today));
    const endDate = string(space, "expiry_date", addPeriod(startDate, period));
    const channel = rows(sqlite, "payment_channel").find(row => row.id === space.payment_channel_id);
    const cycleAnchorDay = Number(string(space, "opening_date", startDate).slice(8, 10));
    const data: SubscriptionData = { ...meta(), channelId: number(space, "payment_channel_id"), ...(channel ? { channelName: string(channel, "name") } : {}), name: string(space, "name"), service: "ChatGPT", planName: string(space, "custom_plan_name") || ({ team: "Business", pro5x: "Pro 5x", pro20x: "Pro 20x", plus: "Plus" }[string(space, "plan_type")] ?? string(space, "plan_type")), account: mother ? string(mother, "email") : "", currency: string(space, "currency_code", "USD"), amountMinor: number(space, "amount_minor"), feePercent: string(space, "fee_percent", "0"), period, cycleAnchorDay, startDate, endDate: endDate > startDate ? endDate : addPeriod(startDate, period, cycleAnchorDay), status: "active", allocation: pro ? "daily" : "fixed" };
    result.push({ id: subscriptionId, kind: "subscription", data: linked(data, [`space:${space.id}`]) });
    const allChildren = children.filter(row => row.space_id === space.id);
    const duplicates = mother && !pro ? allChildren.filter(row => number(row, "is_mother_account") === 1 || string(row, "email").trim().toLowerCase() === string(mother, "email").trim().toLowerCase()) : [];
    const occupants: { row: Row; mother: boolean; sources: string[]; id: string }[] = [
      ...(mother && !pro ? [{ row: string(mother, "usage_status") === "rented" || string(mother, "usage_status") === "self" ? mother : duplicates.find(row => string(row, "usage_status") === "rented" || string(row, "usage_status") === "self") ?? mother, mother: true, id: `legacy:slot:mother:${mother.id}`, sources: [`mother_account:${mother.id}`, ...duplicates.map(row => `child_account:${row.id}`)] }] : []),
      ...allChildren.filter(row => !duplicates.includes(row)).map(row => ({ row, mother: false, id: `legacy:slot:child:${row.id}`, sources: [`child_account:${row.id}`] })),
    ];
    for (const occupant of occupants) {
      const row = occupant.row; const isMotherRow = mothers.includes(row);
      const slot: SlotData = { ...meta(string(row, "label")), subscriptionId, label: occupant.mother ? "母号" : pro ? "拼车成员" : "子账号", account: string(row, "email"), kind: occupant.mother ? "mother" : pro ? "member" : "child", weight: 1, status: string(row, "usage_status") === "disabled" ? "disabled" : "available" };
      result.push({ id: occupant.id, kind: "slot", data: linked(slot, occupant.sources) });
      const usage = string(row, "usage_status") || (string(row, isMotherRow ? "expected_rate_source" : "monthly_rate_source") === "self-use" || !isMotherRow && number(row, "monthly_amount_minor") === 0 ? "self" : !isMotherRow ? "rented" : "unmarked");
      if (usage !== "rented" && usage !== "self") continue;
      const customerId = `legacy:customer:${occupant.id.replace("legacy:slot:", "")}`;
      if (usage === "rented") result.push({ id: customerId, kind: "customer", data: linked({ ...meta(string(row, "label")), name: string(row, "contact") || string(row, "email") || "旧账本客户", contact: string(row, "contact"), email: "", archived: false }, occupant.sources) });
      const billingPeriod = periodOf(row, "billing_period_unit", "billing_period_count");
      const rentalStart = string(row, "joined_date", string(space, "opening_date", startDate));
      const cycleAnchorDay = number(row, "monthly_payment_day") || Number(rentalStart.slice(8, 10));
      const rentalEnd = string(row, "next_payment_date", addPeriod(rentalStart, billingPeriod, cycleAnchorDay));
      const rental: RentalData = { ...meta(string(row, "label")), subscriptionId, slotId: occupant.id, ...(usage === "rented" ? { customerId } : {}), usage, startDate: rentalStart, endDate: rentalEnd > rentalStart ? rentalEnd : addPeriod(rentalStart, billingPeriod, cycleAnchorDay), cycleAnchorDay, billing: { amountMinor: usage === "self" ? 0 : number(row, isMotherRow ? "expected_amount_minor" : "monthly_amount_minor"), currency: string(row, isMotherRow ? "expected_currency_code" : "monthly_currency_code", "CNY"), period: billingPeriod }, status: "active", periodVersion: 1, history: [{ type: "join", date: rentalStart, commandId: "legacy-migration", periodVersion: 1 }] };
      result.push({ id: occupant.id.replace("legacy:slot:", "legacy:rental:"), kind: "rental", data: linked(rental, occupant.sources) });
    }
  }
  const units = new Map(rows(sqlite, "currency").map(row => [string(row, "code"), number(row, "minor_unit", 2)]));
  for (const row of rows(sqlite, "account_receipt")) {
    const currency = string(row, "currency_code", "USD"); const amountMinor = number(row, "amount_minor");
    const entry: EntryData = { ...meta(string(row, "note")), type: "receipt", subscriptionId: `legacy:subscription:${row.space_id}`, amountMinor, currency, feePercent: "0", feeAmountMinor: 0, totalMinor: amountMinor, usdMinor: number(row, "amount_usd"), cnyMinor: currency === "CNY" ? amountMinor : null, fx: { rateToUsd: string(row, "rate_used", "1"), rateToCny: currency === "CNY" ? "1" : null, quoteDate: string(row, "rate_as_of"), fetchedAt: string(row, "created_at"), source: string(row, "rate_source", "legacy"), minorUnit: units.get(currency) ?? 2 }, date: string(row, "received_date"), status: "posted" };
    result.push({ id: `legacy:entry:receipt:${row.id}`, kind: "entry", data: linked(entry, [`account_receipt:${row.id}`]) });
  }
  return result;
}
