import type { OperationsSnapshot } from "../operations/types";

export function shanghaiToday(now = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {timeZone:"Asia/Shanghai"}).format(now);
}
export function dueCategory(date:string,today:string) {
  const days = Math.round((Date.parse(date + "T00:00:00Z") - Date.parse(today + "T00:00:00Z"))/86400000);
  return days < 0 ? "逾期" : days === 0 ? "今日到期" : days <= 7 ? "近期到期" : "正常";
}
export function outstandingMinor(snapshot:OperationsSnapshot,billId:string) {
  const bill = snapshot.bills.find(row=>row.id === billId);
  if (!bill || bill.data.status === "void") return 0;
  const paid = snapshot.entries.filter(row=>row.data.billId === billId && row.data.status === "posted").reduce((sum,row)=>sum+(row.data.type === "refund" ? -1 : row.data.type === "receipt" ? 1 : 0)*(row.data.appliedMinor ?? (row.data.currency === bill.data.currency ? row.data.amountMinor : 0)),0);
  return Math.max(0,bill.data.amountMinor - bill.data.discountMinor - paid);
}
export function workbench(snapshot:OperationsSnapshot,today:string) {
  const activeSubscriptions = new Set(snapshot.subscriptions.filter(row=>row.data.status === "active").map(row=>row.id));
  return {
    renewals:snapshot.rentals.filter(row=>row.data.status === "active" && dueCategory(row.data.endDate,today) !== "正常"),
    subscriptions:snapshot.subscriptions.filter(row=>row.data.status === "active" && dueCategory(row.data.endDate,today) !== "正常"),
    receivables:snapshot.bills.filter(row=>outstandingMinor(snapshot,row.id) > 0),
    vacant:snapshot.slots.filter(row=>row.data.status === "available" && activeSubscriptions.has(row.data.subscriptionId) && !snapshot.rentals.some(rental=>rental.data.slotId === row.id && rental.data.status === "active")),
  };
}
export function calendarDays(month:string) {
  if (!/^\d{4}-\d{2}$/.test(month)) return [];
  const [year,number] = month.split("-").map(Number);
  if (number < 1 || number > 12 || year < 1900 || year > 2200) return [];
  return Array.from({length:new Date(Date.UTC(year,number,0)).getUTCDate()},(_,index)=>`${month}-${String(index+1).padStart(2,"0")}`);
}
