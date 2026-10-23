"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import type { FxQuote, OperationsSnapshot } from "@/lib/operations/types";
import { CURRENCIES } from "@/lib/currencies";
import { calendarDays, shanghaiToday } from "@/lib/workspace/view-model";
import { filterRenewalCalendarEntries, overdueRenewalEntries, renewalCalendarEntries, renewalCalendarOccurrenceKey, renewalCalendarStatus, upcomingRenewalEntries, type RenewalCalendarEntry } from "@/lib/workspace/renewal-calendar";
import { freezeUsdMinor, formatMinor } from "@/lib/money";
import { paymentFee } from "@/lib/payment-fees";
import { MoneyDisplay } from "@/components/money-display";
import { Button } from "@/components/ui/button";

const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const daysFrom = (date: string, today: string) => Math.round((Date.parse(date + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000);
const keyOf = renewalCalendarOccurrenceKey;
const roleLabel = (entry: RenewalCalendarEntry) => entry.role || (entry.kind === "subscription" ? "订阅续费" : entry.slotKind === "mother" ? "母号续费" : entry.slotKind === "child" ? "子账号续费" : entry.slotKind === "member" ? "拼车成员续费" : "账号续费");
const renewalStyles = {
  renewed: { label: "已续费", color: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  overdue: { label: "已逾期", color: "border-red-200 bg-red-50 text-red-700" },
  "due-today": { label: "今日到期", color: "border-amber-200 bg-amber-50 text-amber-700" },
  "due-soon": { label: "即将到期", color: "border-amber-200 bg-amber-50 text-amber-700" },
  upcoming: { label: "未续费", color: "border-sky-200 bg-sky-50 text-sky-700" },
};

export function RenewalCalendar({ initialSnapshot, initialQuotes, classicSpaceIds, initialToday, soonDays = 7 }: {
  initialSnapshot: OperationsSnapshot; initialQuotes: FxQuote[]; classicSpaceIds: number[]; initialToday: string; soonDays?: number;
}) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState(initialSnapshot), [quotes, setQuotes] = useState(initialQuotes);
  const [today, setToday] = useState(initialToday), [month, setMonth] = useState(initialToday.slice(0, 7));
  const [search, setSearch] = useState(""), [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const refreshing = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true; setBusy(true);
    try {
      const response = await fetch("/api/operations/snapshot", { cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (response.status === 401) { router.replace("/login"); return; }
      const value = await response.json();
      if (!response.ok || !value.snapshot) throw new Error("续费事项暂未更新，请稍后重试。");
      setSnapshot(value.snapshot); setQuotes(value.quotes ?? []); setToday(shanghaiToday()); setError("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "续费事项暂未更新。"); }
    finally { refreshing.current = false; setBusy(false); }
  }, [router]);
  useEffect(() => { const timer = setInterval(() => void refresh(), 300000); return () => clearInterval(timer); }, [refresh]);
  const entries = filterRenewalCalendarEntries(renewalCalendarEntries(snapshot), { search });
  const inMonth = filterRenewalCalendarEntries(entries, { month });
  const upcoming = upcomingRenewalEntries(entries, today, soonDays), overdue = overdueRenewalEntries(entries, today);
  const current = entries.find(entry => keyOf(entry) === selected);
  const pendingOverdue = overdue.filter(entry => !entry.completed);
  const dates = calendarDays(month), cnyQuote = quotes.find(quote => quote.currency === "CNY");
  const leading = dates.length ? (new Date(dates[0] + "T00:00:00Z").getUTCDay() + 6) % 7 : 0;
  function changeMonth(delta: number) {
    const date = new Date(month + "-01T00:00:00Z"); date.setUTCMonth(date.getUTCMonth() + delta);
    const target = date.toISOString().slice(0, 7); if (calendarDays(target).length) setMonth(target);
  }
  async function markRenewed(entry: RenewalCalendarEntry) {
    if (entry.completed || refreshing.current) return;
    const record = entry.kind === "subscription" ? snapshot.subscriptions.find(row => row.id === entry.recordId) : snapshot.rentals.find(row => row.id === entry.recordId);
    if (!record || record.data.endDate !== entry.date) { setError("本期期次已变化，请刷新后重试。"); return; }
    refreshing.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyOf(entry)));
      const id = "calendar-renew:" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      const response = await fetch("/api/operations/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, type: "calendar.renew", payload: { kind: entry.kind, id: entry.recordId, dueDate: entry.date, expectedRevision: record.revision } }), signal: AbortSignal.timeout(20000) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error?.message ?? "续费未完成，请刷新后重试。");
      if (value.snapshot) setSnapshot(value.snapshot);
      setMessage(value.queued ? "操作已保存在本机待同步队列，中心确认后才会标为已续费。" : "已续费，下一期日期已延长；本期记录仍保留在原日期。");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "续费未完成，请重试。"); }
    finally { refreshing.current = false; setBusy(false); }
  }
  function amount(entry: RenewalCalendarEntry) {
    const sub = snapshot.subscriptions.find(row => row.id === entry.subRecordId)?.data;
    const rental = entry.kind === "rental" ? snapshot.rentals.find(row => row.id === entry.recordId)?.data : null;
    const historical = entry.completed ? entry.kind === "subscription"
      ? snapshot.entries.find(row => row.data.type === "cost" && row.data.subscriptionId === entry.subRecordId && row.id === "entry:" + entry.historyCommandId)
      : snapshot.bills.find(row => row.data.rentalId === entry.recordId && row.data.startDate === entry.date && row.data.endDate === entry.nextDueDate) : undefined;
    const currency = entry.currency ?? historical?.data.currency ?? rental?.billing.currency ?? sub?.currency;
    const native = entry.amountMinor !== undefined ? paymentFee(entry.amountMinor, entry.feePercent ?? "0").totalAmountMinor
      : entry.completed ? historical ? "totalMinor" in historical.data ? historical.data.totalMinor : historical.data.amountMinor - historical.data.discountMinor : undefined
      : rental?.billing.amountMinor ?? (sub ? paymentFee(sub.amountMinor, sub.feePercent).totalAmountMinor : undefined);
    if (currency === undefined || native === undefined) return "当时金额未登记";
    const quote = quotes.find(row => row.currency === currency);
    const minorUnit = CURRENCIES.find(row => row.code === currency)?.minorUnit ?? 2;
    return <>{historical ? <span className="inline-flex flex-col gap-1"><span className="font-mono tabular-nums">{historical.data.cnyMinor === null ? "人民币未登记" : "¥" + formatMinor(historical.data.cnyMinor, 2)}</span><span className="font-mono text-xs text-muted-foreground">${formatMinor(historical.data.usdMinor, 2)} USD</span></span> : entry.completed ? <span className="font-mono">{formatMinor(native, minorUnit)} {currency}</span> : <MoneyDisplay value={quote ? freezeUsdMinor(native, minorUnit, quote.rateToUsd) : null} cnyRate={cnyQuote ? { rateToUsd: cnyQuote.rateToUsd, minorUnit: cnyQuote.minorUnit } : null}/>}<small className="mt-1 block text-xs text-muted-foreground">{formatMinor(native, minorUnit)} {currency} · {entry.kind === "subscription" ? "订阅成本" : "约定收费"}</small></>;
  }
  function table(rows: RenewalCalendarEntry[], label: string) {
    return <div className="overflow-x-auto rounded-lg border bg-card"><table className="w-full min-w-[760px] text-left text-sm" aria-label={label}>
      <thead className="border-b bg-muted/40 text-xs text-muted-foreground"><tr>{["状态", "账号 / 成员", "所属订阅", "到期日", "剩余 / 处理结果", "费用", "操作"].map(name => <th className="px-4 py-3 font-medium" key={name}>{name}</th>)}</tr></thead>
      <tbody>{rows.length ? rows.map(entry => {
        const state = renewalCalendarStatus(entry, today, soonDays), style = renewalStyles[state], days = daysFrom(entry.date, today);
        return <tr className="border-b last:border-0" key={keyOf(entry)} data-renewal-id={entry.recordId} data-renewal-date={entry.date} data-renewal-state={state} data-renewal-kind={entry.kind}>
          <td className="px-4 py-3"><span className={`whitespace-nowrap rounded-md border px-2 py-1 text-xs ${style.color}`}>{style.label}</span></td>
          <td className="px-4 py-3"><button className="text-left font-medium text-primary hover:underline" onClick={() => setSelected(keyOf(entry))}>{entry.account || entry.customerName || entry.name}</button><small className="mt-1 block text-xs text-muted-foreground">{roleLabel(entry)}{entry.customerName ? " · " + entry.customerName : ""}</small></td>
          <td className="px-4 py-3">{entry.name}<small className="mt-1 block text-xs text-muted-foreground">{entry.planName}</small></td><td className="whitespace-nowrap px-4 py-3 font-mono">{entry.date}</td>
          <td className="whitespace-nowrap px-4 py-3">{entry.completed ? "已延至 " + entry.nextDueDate : days < 0 ? `逾期 ${-days} 天` : days === 0 ? "今天到期" : `${days} 天后到期`}</td><td className="px-4 py-3">{amount(entry)}</td>
          <td className="px-4 py-3">{entry.completed ? <span className="whitespace-nowrap text-sm font-medium text-emerald-700">✓ 已续费</span> : <Button variant="outline" size="sm" disabled={busy} title="确认本期已续费，并按原周期延长一期" onClick={() => void markRenewed(entry)}>已续费</Button>}</td>
        </tr>;
      }) : <tr><td colSpan={7} className="px-4 py-5 text-center text-muted-foreground">暂无{label}事项</td></tr>}</tbody>
    </table></div>;
  }

  function dayCell(date: string, index: number) {
    const events = inMonth.filter(entry => entry.date === date);
    const week = Math.floor((leading + index) / 7);
    const occupiedWeek = inMonth.some(entry => Math.floor((leading + Number(entry.date.slice(-2)) - 1) / 7) === week);
    return <div key={date} data-calendar-date={date} className={`flex ${occupiedWeek ? "h-20" : "h-14"} min-w-0 flex-col rounded-md border bg-card p-1.5 ${date === today ? "border-primary ring-1 ring-primary/20" : ""}`}>
      <div className="mb-1 flex shrink-0 items-center gap-1 text-xs font-medium"><span>{Number(date.slice(-2))}</span>{date === today && <span className="text-xs text-primary">今天</span>}{events.length > 0 && <span className="ml-auto text-xs font-normal text-muted-foreground">{events.length} 项</span>}</div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain">
        {events.map(entry => {
          const account = entry.account || entry.customerName || entry.slotLabel || "账号未登记";
          const state = renewalCalendarStatus(entry, today, soonDays), style = renewalStyles[state];
          const description = [style.label, entry.name, roleLabel(entry), account, entry.customerName].filter(Boolean).join(" · ");
          return <button key={keyOf(entry)} data-calendar-entry={keyOf(entry)} data-calendar-record-id={entry.recordId} data-calendar-occurrence-date={entry.date} data-renewal-state={state} title={description} aria-label={description} className={`flex h-5 w-full min-w-0 items-center gap-1 rounded border px-1.5 text-left text-xs leading-tight hover:border-primary ${style.color}`} onClick={() => setSelected(keyOf(entry))}><span className="max-w-[35%] shrink-0 truncate font-medium">{entry.name}</span><span className="min-w-0 flex-1 truncate">{account}</span>{entry.completed && <span aria-hidden="true" className="shrink-0">✓</span>}</button>;
        })}
      </div>
    </div>;
  }
  return <div className="mx-auto w-full max-w-[1600px] px-4 py-4 sm:px-6 lg:px-8" data-renewal-calendar>
    <header className="mb-3 flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-tight">续费日历</h1><p className="mt-1 text-sm text-muted-foreground">按到期日查看订阅、母号、子账号和拼车成员，先处理即将到期的账号。</p></div><Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}><RefreshCw className={busy ? "animate-spin" : ""} />刷新</Button></header>
    {message && <p role="status" className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-700">{message}</p>}
    {error && <p className="mb-4 rounded-md border border-destructive/30 p-3 text-sm text-destructive" role="alert">{error}</p>}
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><Button variant="outline" size="icon" aria-label="上一月" onClick={() => changeMonth(-1)}><ChevronLeft /></Button><input className="rounded-md border bg-card px-3 py-2 text-sm" aria-label="日历月份" type="month" min="1900-01" max="2200-12" value={month} onChange={event => { if (calendarDays(event.target.value).length) setMonth(event.target.value); }}/><Button variant="outline" size="icon" aria-label="下一月" onClick={() => changeMonth(1)}><ChevronRight /></Button><Button variant="ghost" size="sm" onClick={() => setMonth(today.slice(0, 7))}>本月</Button></div><input className="w-full rounded-md border bg-card px-3 py-2 text-sm sm:w-80" type="search" aria-label="搜索续费账号" placeholder="搜索账号邮箱、成员或订阅名称" value={search} onChange={event => setSearch(event.target.value)}/></div>
    <p className="mb-2 text-sm text-muted-foreground">本月 {inMonth.length} 项 · 已续费 {inMonth.filter(entry => entry.completed).length} 项 · 即将到期 {upcoming.filter(entry => !entry.completed).length} 项 · 逾期待处理 {pendingOverdue.length} 项</p>
    <div className="mb-2 flex flex-wrap gap-3 text-xs" aria-label="续费状态颜色说明">{["renewed", "upcoming", "due-soon", "overdue"].map(state => {const style=renewalStyles[state as keyof typeof renewalStyles];return <span key={state} className="inline-flex items-center gap-1"><span className={`size-2.5 rounded-full border ${style.color}`} aria-hidden="true"/>{style.label}</span>;})}</div>
    <div className="overflow-x-auto"><div className="grid min-w-[630px] grid-cols-7 gap-1" aria-label={`${month}续费日历`}>{weekdays.map(day => <div className="pb-0.5 text-xs font-medium" key={day}>{day}</div>)}{Array.from({length: leading}, (_, index) => <div key={"empty:" + index} aria-hidden="true" />)}{dates.map(dayCell)}</div></div>
    {current && <section className="mt-5 rounded-lg border bg-card p-4" aria-label="续费账号详情"><div className="flex items-start justify-between gap-4"><div><h2 className="font-semibold">{current.name} · {roleLabel(current)}</h2><p className="mt-2 break-all text-sm">{current.account || "账号未登记"}</p><p className="mt-1 text-sm text-muted-foreground">到期日：{current.date}{current.customerName ? " · 成员：" + current.customerName : ""}{current.completed ? " · 已续费，下一期：" + current.nextDueDate : ""}</p></div><Button variant="ghost" size="sm" onClick={() => setSelected(null)}>收起</Button></div>{!current.completed && <Button className="mt-3" size="sm" disabled={busy} onClick={() => void markRenewed(current)}>已续费</Button>}{current.sourceLegacySpaceId && classicSpaceIds.includes(current.sourceLegacySpaceId) && <Link className="mt-3 inline-block text-sm font-medium text-primary hover:underline" href={`/spaces/${current.sourceLegacySpaceId}`}>查看账号并续费 →</Link>}</section>}
    <section className="mt-4" aria-labelledby="upcoming-renewals"><div className="mb-2 flex items-center justify-between"><h2 className="text-lg font-semibold" id="upcoming-renewals">即将到期</h2><span className="text-sm text-muted-foreground">今天及未来 {soonDays} 天 · 含已续费记录</span></div>{table(upcoming, "即将到期")}</section>
    <section className="mt-4"><h2 className="mb-2 text-lg font-semibold">本月全部续费事项</h2>{table(inMonth, "本月全部续费")}</section>
    <details className="mt-4"><summary className="cursor-pointer text-base font-semibold">历史到期 · 待处理 {pendingOverdue.length} 项 · 已续费 {overdue.filter(entry => entry.completed).length} 项</summary><p className="my-3 text-sm text-muted-foreground">原日期的记录继续保留，已续费为绿色；尚未续费的逾期事项为红色。</p>{table(overdue, "已逾期")}</details>
  </div>;
}
