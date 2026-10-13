import type { BillData, OperationsSnapshot } from "../operations/types";

export type BillSummary = {
  billId: string;
  amountMinor: number;
  receivedMinor: number;
  outstandingMinor: number;
  currency: string;
  status: BillData["status"];
  isVoid: boolean;
};

/** Bill-currency balances use posted applications, independently of bill status. */
export function billSummary(snapshot: Pick<OperationsSnapshot, "bills" | "entries">, billId: string): BillSummary | null {
  const bill = snapshot.bills.find(row => row.id === billId);
  if (!bill) return null;
  const isVoid = bill.data.status === "void";
  const amountMinor = isVoid ? 0 : bill.data.amountMinor - bill.data.discountMinor;
  const receivedMinor = snapshot.entries.reduce((sum, row) => {
    const entry = row.data;
    if (entry.billId !== billId || entry.status !== "posted") return sum;
    const direction = entry.type === "receipt" ? 1 : entry.type === "refund" ? -1 : 0;
    return sum + direction * (entry.appliedMinor ?? 0);
  }, 0);
  return {
    billId,
    amountMinor,
    receivedMinor,
    outstandingMinor: isVoid ? 0 : Math.max(0, amountMinor - receivedMinor),
    currency: bill.data.currency,
    status: bill.data.status,
    isVoid,
  };
}
