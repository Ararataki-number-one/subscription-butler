import { freezeUsdMinor } from "@/lib/money";
import { paymentFee } from "@/lib/payment-fees";
import type { BillData, FxQuote, OperationsReport, OperationsSnapshot, Period, ReportLine, ReportOptions } from "./types";
import { allocateRange, crossMinor, date, days, integer, invalid, rentalIntervals } from "./utils";

export function monthlyAmount(amount: number, period: Period) {
  const months = period.count * (period.unit === "year" ? 12 : period.unit === "quarter" ? 3 : period.unit === "day" ? 12 / 365.2425 : 1);
  return Math.round(amount / months);
}
export function billBalance(snapshot: OperationsSnapshot, billId: string, asOf?: string) {
  const bill = snapshot.bills.find(record => record.id === billId);
  if (!bill) invalid("账单不存在。");
  const amountMinor = bill.data.status === "void" ? 0 : bill.data.amountMinor - bill.data.discountMinor;
  const receivedMinor = snapshot.entries.filter(record => record.data.billId === billId && record.data.status === "posted" && (!asOf || record.data.date < asOf))
    .reduce((sum, record) => sum + (record.data.type === "receipt" ? record.data.appliedMinor ?? 0 : record.data.type === "refund" ? -(record.data.appliedMinor ?? 0) : 0), 0);
  return { billId, amountMinor, receivedMinor, outstandingMinor: Math.max(0, amountMinor - receivedMinor), currency: bill.data.currency };
}
function matches(data: { subscriptionId?: string; customerId?: string; channelId?: number | string }, options: ReportOptions, snapshot?: OperationsSnapshot) {
  const channelId = data.channelId ?? snapshot?.subscriptions.find(row => row.id === data.subscriptionId)?.data.channelId;
  return (!options.subscriptionId || data.subscriptionId === options.subscriptionId) && (!options.customerId || data.customerId === options.customerId) && (options.channelId === undefined || String(channelId) === String(options.channelId));
}
function billValue(bill: BillData, nativeAmount: number) {
  return freezeUsdMinor(nativeAmount, bill.fx.minorUnit, bill.fx.rateToUsd);
}
/** Half-open report ranges; cumulative integer allocation makes adjacent periods sum exactly. */
export function buildOperationsReport(snapshot: OperationsSnapshot, quotes: FxQuote[] = [], options: ReportOptions = {}): OperationsReport {
  const from = options.from ? date(options.from) : "0001-01-01";
  const to = options.to ? date(options.to) : "9999-12-31";
  if (to <= from) invalid("报告结束日必须晚于开始日。");
  const cash: OperationsReport["cash"] = { incomeUsd: 0, costUsd: 0, netUsd: 0, lines: [] };
  const accrual: OperationsReport["accrual"] = { incomeUsd: 0, costUsd: 0, netUsd: 0, lines: [] };
  const warnings: string[] = [];
  for (const record of snapshot.entries) {
    const entry = record.data;
    const isAllocatedCost = entry.type === "cost" && options.customerId && entry.periodStart && entry.periodEnd;
    if (entry.status !== "posted" || !matches(entry, isAllocatedCost ? { ...options, customerId: undefined } : options, snapshot)) continue;
    const customerShare = (start?: string, end?: string, nativeCny = false) => {
      if (!options.customerId || !entry.periodStart || !entry.periodEnd) return nativeCny ? entry.cnyMinor : entry.usdMinor;
      if (nativeCny && entry.cnyMinor === null) return null;
      const allocation = allocateCostToRentals(snapshot, record.id, start, end, nativeCny ? entry.cnyMinor! : entry.usdMinor, nativeCny ? "CNY" : "USD");
      return allocation.rentals.filter(row => snapshot.rentals.some(rental => rental.id === row.rentalId && rental.data.customerId === options.customerId)).reduce((sum, row) => sum + row.usdMinor, 0);
    };
    const line: ReportLine = { sourceId: record.id, sourceKind: "entry", subscriptionId: entry.subscriptionId, customerId: entry.customerId, type: entry.type, date: entry.date, usdMinor: entry.type === "refund" ? -entry.usdMinor : entry.usdMinor, cnyMinor: entry.cnyMinor === null ? null : entry.type === "refund" ? -entry.cnyMinor : entry.cnyMinor, amountMinor: entry.amountMinor, currency: entry.currency };
    if (entry.date >= from && entry.date < to) {
      const cashValue = entry.type === "cost" && isAllocatedCost ? customerShare()! : entry.usdMinor;
      cash.lines.push({ ...line, ...(entry.type === "cost" ? { usdMinor: cashValue, cnyMinor: isAllocatedCost ? customerShare(undefined, undefined, true) : line.cnyMinor } : {}) });
      if (entry.type === "cost") cash.costUsd += cashValue;
      else cash.incomeUsd += line.usdMinor;
    }
    if (entry.type === "cost") {
      const amount = isAllocatedCost ? customerShare(from, to)! : entry.periodStart && entry.periodEnd ? allocateRange(entry.usdMinor, entry.periodStart, entry.periodEnd, from, to) : entry.date >= from && entry.date < to ? entry.usdMinor : 0;
      const cny = isAllocatedCost ? customerShare(from, to, true) : entry.cnyMinor !== null && entry.periodStart && entry.periodEnd ? allocateRange(entry.cnyMinor, entry.periodStart, entry.periodEnd, from, to) : entry.date >= from && entry.date < to ? line.cnyMinor : 0;
      if (amount || cny) {
        accrual.costUsd += amount;
        accrual.lines.push({ ...line, usdMinor: amount, cnyMinor: cny });
      }
    }
    if (!entry.billId && entry.type !== "cost") warnings.push(`收款 ${record.id} 未归属账期，仅计现金收支。`);
    if (entry.cnyMinor === null) warnings.push(`历史记录 ${record.id} 缺少冻结人民币汇率。`);
  }
  const balances = snapshot.bills.filter(record => matches(record.data, options, snapshot) && record.data.dueDate >= from && record.data.dueDate < to).map(record => billBalance(snapshot, record.id, to));
  let billedUsd = 0; let receivedUsd = 0; let outstandingUsd = 0;
  for (const record of snapshot.bills) {
    const bill = record.data;
    if (bill.status !== "open" || !matches(bill, options, snapshot)) continue;
    const balance = billBalance(snapshot, record.id, to);
    if (bill.dueDate >= from && bill.dueDate < to) {
      billedUsd += billValue(bill, balance.amountMinor);
      receivedUsd += billValue(bill, balance.receivedMinor);
      outstandingUsd += billValue(bill, balance.outstandingMinor);
    }
    const amount = allocateRange(bill.usdMinor, bill.startDate, bill.endDate, from, to);
    const cny = bill.cnyMinor === null ? null : allocateRange(bill.cnyMinor, bill.startDate, bill.endDate, from, to);
    if (amount || cny) {
      accrual.incomeUsd += amount;
      accrual.lines.push({ sourceId: record.id, sourceKind: "bill", subscriptionId: bill.subscriptionId, customerId: bill.customerId, type: "billed", date: bill.startDate, usdMinor: amount, cnyMinor: cny, amountMinor: bill.amountMinor - bill.discountMinor, currency: bill.currency });
    }
  }
  const quoteMap = new Map(quotes.map(quote => [quote.currency, quote]));
  const missing = new Set<string>(); const estimatedLines: ReportLine[] = [];
  let estimatedIncome = 0; let estimatedCost = 0;
  const convert = (amount: number, currency: string) => {
    const quote = quoteMap.get(currency);
    if (!quote) { missing.add(currency); return null; }
    return freezeUsdMinor(amount, quote.minorUnit, quote.rateToUsd);
  };
  const toCny = (amount: number, currency: string) => {
    const cny = quoteMap.get("CNY"); const source = quoteMap.get(currency); return cny && source ? crossMinor(amount, source.minorUnit, source.rateToUsd, cny.minorUnit, cny.rateToUsd) : null;
  };
  for (const record of snapshot.subscriptions) {
    const sub = record.data;
    if (sub.status !== "active" || options.subscriptionId && record.id !== options.subscriptionId || options.channelId !== undefined && String(sub.channelId) !== String(options.channelId)) continue;
    const value = convert(paymentFee(sub.amountMinor, sub.feePercent).totalAmountMinor, sub.currency);
    if (value === null) continue;
    const allSlots = snapshot.slots.filter(slot => slot.data.subscriptionId === record.id && slot.data.status === "available");
    const rentals = snapshot.rentals.filter(rental => rental.data.subscriptionId === record.id && rental.data.status === "active");
    const participants = sub.allocation === "fixed" ? allSlots : allSlots.filter(slot => rentals.some(rental => rental.data.slotId === slot.id));
    const totalWeight = participants.reduce((sum, slot) => sum + slot.data.weight, 0);
    const share = (whole: number) => {
      if (!options.customerId) return whole;
      if (sub.allocation === "fixed-amount") {
        const fixed = allSlots.filter(slot => rentals.some(rental => rental.data.slotId === slot.id && rental.data.customerId === options.customerId)).reduce((sum, slot) => sum + (slot.data.fixedCostMinor ?? 0), 0);
        const quote = quoteMap.get(sub.currency)!;
        return monthlyAmount(freezeUsdMinor(fixed, quote.minorUnit, quote.rateToUsd), sub.period);
      }
      let cumulative = 0; let allocated = 0;
      for (const slot of participants) {
        const before = cumulative; cumulative += slot.data.weight;
        if (rentals.some(rental => rental.data.slotId === slot.id && rental.data.customerId === options.customerId) && totalWeight) allocated += Number(BigInt(whole) * BigInt(cumulative) / BigInt(totalWeight) - BigInt(whole) * BigInt(before) / BigInt(totalWeight));
      }
      return allocated;
    };
    const amount = share(monthlyAmount(value, sub.period)); estimatedCost += amount;
    const cny = toCny(monthlyAmount(paymentFee(sub.amountMinor, sub.feePercent).totalAmountMinor, sub.period), sub.currency);
    const fixedForCustomer = sub.allocation === "fixed-amount" && options.customerId ? allSlots.filter(slot => rentals.some(rental => rental.data.slotId === slot.id && rental.data.customerId === options.customerId)).reduce((sum, slot) => sum + (slot.data.fixedCostMinor ?? 0), 0) : undefined;
    const customerCny = fixedForCustomer === undefined ? cny === null ? null : share(cny) : toCny(monthlyAmount(fixedForCustomer, sub.period), sub.currency);
    estimatedLines.push({ sourceId: record.id, sourceKind: "subscription", subscriptionId: record.id, type: "estimated-cost", date: sub.startDate, usdMinor: amount, cnyMinor: customerCny, amountMinor: sub.amountMinor, currency: sub.currency });
  }
  for (const record of snapshot.rentals) {
    const rental = record.data;
    if (rental.status !== "active" || rental.usage !== "rented" || !matches(rental, options, snapshot)) continue;
    const value = convert(rental.billing.amountMinor, rental.billing.currency);
    if (value !== null) {
      const amount = monthlyAmount(value, rental.billing.period); estimatedIncome += amount;
      estimatedLines.push({ sourceId: record.id, sourceKind: "rental", subscriptionId: rental.subscriptionId, customerId: rental.customerId, type: "estimated-income", date: rental.startDate, usdMinor: amount, cnyMinor: toCny(monthlyAmount(rental.billing.amountMinor, rental.billing.period), rental.billing.currency), amountMinor: rental.billing.amountMinor, currency: rental.billing.currency });
    }
  }
  cash.netUsd = cash.incomeUsd - cash.costUsd; accrual.netUsd = accrual.incomeUsd - accrual.costUsd;
  return { cash, accrual, receivables: { billedUsd, receivedUsd, outstandingUsd, bills: balances }, estimates: { incomeUsd: missing.size ? null : estimatedIncome, costUsd: missing.size ? null : estimatedCost, netUsd: missing.size ? null : estimatedIncome - estimatedCost, lines: estimatedLines, missingCurrencies: [...missing] }, warnings: [...new Set(warnings)] };
}
/** Native-unit, per-period pricing. Fee is a payment cost; profit margin is a share of selling price. */
export function calculatePricing(input: { amountMinor: number; feePercent?: string; capacity: number; occupied?: number; marginPercent?: number }) {
  const amount = integer(input.amountMinor, "成本"); const capacity = integer(input.capacity, "位置数", 1);
  const occupied = integer(input.occupied ?? capacity, "出租位置数", 1);
  if (occupied > capacity) invalid("出租位置数不能超过容量。");
  const margin = input.marginPercent ?? 0;
  if (!Number.isFinite(margin) || margin < 0 || margin >= 100) invalid("利润率必须在 0–100% 之间，不包含 100%。");
  const cost = paymentFee(amount, input.feePercent ?? "0").totalAmountMinor;
  const breakEvenPerSlot = Math.ceil(cost / occupied);
  const targetPerSlot = Math.ceil(cost * 100 / (100 - margin) / occupied);
  return { costMinor: cost, breakEvenPerSlot, targetPerSlot, totalRevenueMinor: targetPerSlot * occupied, profitMinor: targetPerSlot * occupied - cost, capacity, occupied };
}
/** Allocate an actual cost to rental intervals; unoccupied time remains subscription-level cost. */
export function allocateCostToRentals(snapshot: OperationsSnapshot, entryId: string, from?: string, to?: string, amountOverride?: number, valueKind: "USD" | "CNY" = "USD") {
  const record = snapshot.entries.find(row => row.id === entryId);
  if (!record || record.data.type !== "cost" || !record.data.periodStart || !record.data.periodEnd) invalid("需要带服务期的购买成本记录。");
  const entry = record.data; const start = entry.periodStart!; const end = entry.periodEnd!;
  if (days(start, end) > 36600) invalid("分摊期超过支持的 100 年。");
  const sub = snapshot.subscriptions.find(row => row.id === entry.subscriptionId);
  const slots = entry.costAllocation?.slots ?? snapshot.slots.filter(row => row.data.subscriptionId === entry.subscriptionId).map(row => ({ slotId: row.id, weight: row.data.weight }));
  const mode = entry.costAllocation?.mode ?? sub?.data.allocation;
  const intervals = snapshot.rentals.flatMap(row => rentalIntervals(row.data).map(interval => ({ ...interval, rentalId: row.id })));
  const fixedShares = entry.costAllocation?.fixedShares;
  const total = amountOverride ?? entry.usdMinor;
  const fixedTotals = fixedShares?.map(share => valueKind === "CNY" ? share.cnyMinor ?? 0 : share.usdMinor) ?? [];
  const columns = [...fixedTotals, total - fixedTotals.reduce((sum, value) => sum + value, 0)];
  const assigned = columns.map(() => 0);
  let elapsed = 0;
  const result = new Map<string, number>(); let unallocatedUsd = 0;
  for (let day = start; day < end;) {
    const next = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
    const cost = allocateRange(amountOverride ?? entry.usdMinor, start, end, day, next);
    elapsed++;
    let fixedDay: number[] = [];
    if (mode === "fixed-amount") {
      if (!fixedShares || columns.some(value => value < 0)) invalid("固定金额分摊快照无效。");
      let remaining = cost; fixedDay = columns.map(() => 0);
      const wants = columns.map((value, index) => ({ index, want: Math.max(0, Number(BigInt(value) * BigInt(elapsed) / BigInt(days(start, end))) - assigned[index]) })).sort((a, b) => b.want - a.want || a.index - b.index);
      for (const { index, want } of wants) { const take = Math.min(want, remaining); fixedDay[index] += take; assigned[index] += take; remaining -= take; }
      const remainders = columns.map((value, index) => ({ index, score: BigInt(value) * BigInt(elapsed) - BigInt(assigned[index]) * BigInt(days(start, end)) })).filter(({ index }) => assigned[index] < columns[index]).sort((a, b) => a.score > b.score ? -1 : a.score < b.score ? 1 : a.index - b.index);
      for (const { index } of remainders) { if (!remaining) break; fixedDay[index]++; assigned[index]++; remaining--; }
      if (remaining) invalid("固定金额日分摊无法对账。");
    }
    if ((!from || day >= from) && (!to || day < to)) {
      const active = intervals.filter(interval => interval.startDate <= day && interval.endDate > day);
      if (mode === "fixed-amount") {
        fixedShares!.forEach((share, index) => {
          const rental = active.find(row => row.slotId === share.slotId);
          if (rental) result.set(rental.rentalId, (result.get(rental.rentalId) ?? 0) + fixedDay[index]);
          else unallocatedUsd += fixedDay[index];
        });
        unallocatedUsd += fixedDay.at(-1)!;
        day = next; continue;
      }
      const participants = mode === "fixed" ? slots : slots.filter(slot => active.some(interval => interval.slotId === slot.slotId));
      const weights = participants.reduce((sum, slot) => sum + slot.weight, 0);
      if (!weights) unallocatedUsd += cost;
      else {
        let cumulative = 0;
        for (const slot of participants) {
          const prior = cumulative; cumulative += slot.weight;
          const share = Number(BigInt(cost) * BigInt(cumulative) / BigInt(weights) - BigInt(cost) * BigInt(prior) / BigInt(weights));
          const rental = active.find(row => row.slotId === slot.slotId);
          if (rental) result.set(rental.rentalId, (result.get(rental.rentalId) ?? 0) + share);
          else unallocatedUsd += share;
        }
      }
    }
    day = next;
  }
  return { entryId, rentals: [...result].map(([rentalId, usdMinor]) => ({ rentalId, usdMinor })), unallocatedUsd };
}
