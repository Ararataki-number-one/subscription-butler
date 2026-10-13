"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import type { FxQuote, OperationsSnapshot } from "@/lib/operations/types";
import { CURRENCIES } from "@/lib/currencies";
import { calendarDays, shanghaiToday } from "@/lib/workspace/view-model";
import { filterRenewalCalendarEntries, overdueRenewalEntries, renewalCalendarEntries, upcomingRenewalEntries, type RenewalCalendarEntry } from "@/lib/workspace/renewal-calendar";
import { freezeUsdMinor, formatMinor } from "@/lib/money";
import { paymentFee } from "@/lib/payment-fees";
import { MoneyDisplay } from "@/components/money-display";
import { Button } from "@/components/ui/button";

const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const daysFrom = (date: string, today: string) => Math.round((Date.parse(date + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000);
const keyOf = (entry: RenewalCalendarEntry) => entry.kind + ":" + entry.recordId;
const roleLabel = (entry: RenewalCalendarEntry) => entry.kind === "subscription" ? "订阅续费" : entry.slotKind === "mother" ? "母号续费" : entry.slotKind === "child" ? "子账号续费" : entry.slotKind === "member" ? "拼车成员续费" : "账号续费";

export function RenewalCalendar({ initialSnapshot, initialQuotes, classicSpaceIds, initialToday, soonDays = 7 }: {
  initialSnapshot: OperationsSnapshot; initialQuotes: FxQuote[]; classicSpaceIds: number[]; initialToday: string; soonDays?: number;
}) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState(initialSnapshot), [quotes, setQuotes] = useState(initialQuotes);
  const [today, setToday] = useState(initialToday), [month, setMonth] = useState(initialToday.slice(0, 7));
  const [search, setSearch] = useState(""), [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
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
  const dates = calendarDays(month), cnyQuote = quotes.find(quote => quote.currency === "CNY");
  const leading = dates.length ? (new Date(dates[0] + "T00:00:00Z").getUTCDay() + 6) % 7 : 0;
  function changeMonth(delta: number) {
    const date = new Date(month + "-01T00:00:00Z"); date.setUTCMonth(date.getUTCMonth() + delta);
    const target = date.toISOString().slice(0, 7); if (calendarDays(target).length) setMonth(target);
  }
  function amount(entry: RenewalCalendarEntry) {
    const sub = snapshot.subscriptions.find(row => row.id === entry.subRecordId)?.data;
    const rental = entry.kind === "rental" ? snapshot.rentals.find(row => row.id === entry.recordId)?.data : null;
    if (!sub) return "—";
    const currency = rental?.billing.currency ?? sub.currency;
    const native = rental?.billing.amountMinor ?? paymentFee(sub.amountMinor, sub.feePercent).totalAmountMinor;
    const quote = quotes.find(row => row.currency === currency);
    const minorUnit = CURRENCIES.find(row => row.code === currency)?.minorUnit ?? 2;
    return <><MoneyDisplay value={quote ? freezeUsdMinor(native, minorUnit, quote.rateToUsd) : null} cnyRate={cnyQuote ? { rateToUsd: cnyQuote.rateToUsd, minorUnit: cnyQuote.minorUnit } : null}/><small className="mt-1 block text-xs text-muted-foreground">{formatMinor(native, minorUnit)} {currency} · {entry.kind === "subscription" ? "订阅成本" : "约定收费"}</small></>;
  }
  function table(rows: RenewalCalendarEntry[], label: string) {
    return <div className="overflow-x-auto rounded-lg border bg-card"><table className="w-full min-w-[680px] text-left text-sm" aria-label={label}><thead className="border-b bg-muted/40 text-xs text-muted-foreground"><tr>{["状态", "账号 / 成员", "所属订阅", "到期日", "剩余 / 逾期", "费用"].map(name => <th className="px-4 py-3 font-medium" key={name}>{name}</th>)}</tr></thead><tbody>{rows.length ? rows.map(entry => { const days = daysFrom(entry.date, today); return <tr className="border-b last:border-0" key={keyOf(entry)} data-renewal-id={entry.recordId} data-renewal-kind={entry.kind}><td className="px-4 py-3"><span className={`whitespace-nowrap rounded-md px-2 py-1 text-xs ${days < 0 ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-700"}`}>{days < 0 ? "已逾期" : days === 0 ? "今日到期" : "即将到期"}</span></td><td className="px-4 py-3"><button className="text-left font-medium text-primary hover:underline" onClick={() => setSelected(keyOf(entry))}>{entry.account || entry.customerName || entry.name}</button><small className="mt-1 block text-xs text-muted-foreground">{roleLabel(entry)}{entry.customerName ? " · " + entry.customerName : ""}</small></td><td className="px-4 py-3">{entry.name}<small className="mt-1 block text-xs text-muted-foreground">{entry.planName}</small></td><td className="whitespace-nowrap px-4 py-3 font-mono">{entry.date}</td><td className="whitespace-nowrap px-4 py-3">{days < 0 ? `逾期 ${-days} 天` : days === 0 ? "今天到期" : `${days} 天后到期`}</td><td className="px-4 py-3">{amount(entry)}</td></tr>; }) : <tr><td colSpan={6} className="px-4 py-5 text-center text-muted-foreground">暂无{label}事项</td></tr>}</tbody></table></div>;
  }
  function dayCell(date: string) {
    const events = inMonth.filter(entry => entry.date === date);
    return <div key={date} data-calendar-date={date} className={`flex h-20 min-w-0 flex-col rounded-md border bg-card p-1.5 ${date === today ? "border-primary ring-1 ring-primary/20" : ""}`}>
      <div className="mb-1 flex shrink-0 items-center gap-1 text-xs font-medium"><span>{Number(date.slice(-2))}</span>{date === today && <span className="text-[10px] text-primary">今天</span>}{events.length > 0 && <span className="ml-auto text-[10px] font-normal text-muted-foreground">{events.length} 项</span>}</div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain">
        {events.map(entry => {
          const account = entry.account || entry.customerName || entry.slotLabel || "账号未登记";
          const description = [entry.name, roleLabel(entry), account, entry.customerName].filter(Boolean).join(" · ");
          return <button key={keyOf(entry)} data-calendar-entry={keyOf(entry)} title={description} aria-label={description} className={`flex h-5 w-full min-w-0 items-center gap-1 rounded border px-1.5 text-left text-[11px] leading-tight hover:border-primary ${entry.kind === "subscription" ? "bg-primary/5" : "bg-muted/40"}`} onClick={() => setSelected(keyOf(entry))}><span className="max-w-[35%] shrink-0 truncate font-medium">{entry.name}</span><span className="min-w-0 flex-1 truncate text-muted-foreground">{account}</span></button>;
        })}
      </div>
    </div>;
  }
  return <div className="mx-auto w-full max-w-[1600px] px-4 py-4 sm:px-6 lg:px-8" data-renewal-calendar>
    <header className="mb-3 flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-tight">续费日历</h1><p className="mt-1 text-sm text-muted-foreground">按到期日查看订阅、母号、子账号和拼车成员，先处理即将到期的账号。</p></div><Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}><RefreshCw className={busy ? "animate-spin" : ""} />刷新</Button></header>
    {error && <p className="mb-4 rounded-md border border-destructive/30 p-3 text-sm text-destructive" role="alert">{error}</p>}
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><Button variant="outline" size="icon" aria-label="上一月" onClick={() => changeMonth(-1)}><ChevronLeft /></Button><input className="rounded-md border bg-card px-3 py-2 text-sm" aria-label="日历月份" type="month" min="1900-01" max="2200-12" value={month} onChange={event => { if (calendarDays(event.target.value).length) setMonth(event.target.value); }}/><Button variant="outline" size="icon" aria-label="下一月" onClick={() => changeMonth(1)}><ChevronRight /></Button><Button variant="ghost" size="sm" onClick={() => setMonth(today.slice(0, 7))}>本月</Button></div><input className="w-full rounded-md border bg-card px-3 py-2 text-sm sm:w-80" type="search" aria-label="搜索续费账号" placeholder="搜索账号邮箱、成员或订阅名称" value={search} onChange={event => setSearch(event.target.value)}/></div>
    <p className="mb-2 text-sm text-muted-foreground">本月 {inMonth.length} 项 · 即将到期 {upcoming.length} 项 · 已逾期 {overdue.length} 项</p>
    <div className="overflow-x-auto"><div className="grid min-w-[630px] grid-cols-7 gap-1" aria-label={`${month}续费日历`}>{weekdays.map(day => <div className="pb-0.5 text-xs font-medium" key={day}>{day}</div>)}{Array.from({length: leading}, (_, index) => <div key={"empty:" + index} aria-hidden="true" />)}{dates.map(dayCell)}</div></div>
    {current && <section className="mt-5 rounded-lg border bg-card p-4" aria-label="续费账号详情"><div className="flex items-start justify-between gap-4"><div><h2 className="font-semibold">{current.name} · {roleLabel(current)}</h2><p className="mt-2 break-all text-sm">{current.account || "账号未登记"}</p><p className="mt-1 text-sm text-muted-foreground">到期日：{current.date}{current.customerName ? " · 成员：" + current.customerName : ""}</p></div><Button variant="ghost" size="sm" onClick={() => setSelected(null)}>收起</Button></div>{current.sourceLegacySpaceId && classicSpaceIds.includes(current.sourceLegacySpaceId) && <Link className="mt-3 inline-block text-sm font-medium text-primary hover:underline" href={`/spaces/${current.sourceLegacySpaceId}`}>查看账号并续费 →</Link>}</section>}
    <section className="mt-4" aria-labelledby="upcoming-renewals"><div className="mb-2 flex items-center justify-between"><h2 className="text-lg font-semibold" id="upcoming-renewals">即将到期</h2><span className="text-sm text-muted-foreground">今天及未来 {soonDays} 天</span></div>{table(upcoming, "即将到期")}</section>
    <details className="mt-4"><summary className="cursor-pointer text-base font-semibold text-destructive">已逾期 {overdue.length} 项</summary><p className="my-3 text-sm text-muted-foreground">按原到期日保留，包含以前月份尚未续费的账号。</p>{table(overdue, "已逾期")}</details>
  </div>;
}
