"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { createChildAccount, updateChildAccount, renewChildAccount, deleteChildAccount } from "@/actions/childAccounts";
import { updateTeamSeat, renewMotherAccount } from "@/actions/teamSeats";
import type { TeamEarnings, TeamEarningSeat } from "@/db/teamEarnings";
import type { MotherAccountRow } from "@/db/schema";
import type { ChildAccountListRow } from "@/db/childAccounts";
import type { CurrencyRow } from "@/db/currencies";
import { SEAT_USAGE_LABELS, SEAT_USAGE_STATUSES, childUsageStatus, type SeatUsageStatus } from "@/lib/seat-usage";
import { spacePlanLabel } from "@/lib/space-plans";
import { formatCurrencyMinor } from "@/lib/currencies";
import { formatMinor, parseToMinor } from "@/lib/money";
import { nextPaymentDueDate } from "@/lib/expiry";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ExpiryBadge } from "./expiry-badge";
import { MoneyDisplay } from "@/components/money-display";
import type { CnyDisplayRate } from "@/lib/money-display";

const PERIODS = [
  { value: "month:1", label: "每月" }, { value: "quarter:1", label: "每季度" },
  { value: "month:6", label: "每半年" }, { value: "year:1", label: "每年" },
];
type Editor = { role: "mother" } | { role: "child"; account?: ChildAccountListRow };
type Confirmation = { action: "renew"; role: "mother" }
  | { action: "delete" | "renew"; role: "child"; account: ChildAccountListRow };
type Props = {
  earnings: TeamEarnings;
  mother: MotherAccountRow;
  accounts: ChildAccountListRow[];
  currencies: CurrencyRow[];
  soonDays: number;
  initiallyEditMother?: boolean;
  cnyRate?: CnyDisplayRate | null;
};

export function AccountManagementCard({ earnings, mother, accounts, currencies, soonDays, initiallyEditMother = false, cnyRate = null }: Props) {
  const router = useRouter();
  const business = earnings.planType === "team";
  const shared = true;
  const memberLabel = business ? "子账号" : "拼车成员";
  const motherLabel = "母号";
  const motherSeat = earnings.seats.find(seat => seat.role === "mother")!;
  const canAdd = shared && (!business || accounts.length === 0);
  const [pending, startTransition] = useTransition();
  const [editor, setEditor] = useState<Editor | null>(business && initiallyEditMother ? { role: "mother" } : null);
  const [status, setStatus] = useState(mother.usageStatus ?? "");
  const [email, setEmail] = useState(mother.email);
  const [contact, setContact] = useState(mother.contact);
  const [note, setNote] = useState(mother.label);
  const defaultCode = currencies.some(c => c.code === "CNY") ? "CNY" : currencies[0]?.code ?? "USD";
  const [code, setCode] = useState(mother.expectedCurrencyCode ?? defaultCode);
  const [amount, setAmount] = useState(mother.expectedAmountMinor
    ? formatMinor(mother.expectedAmountMinor, currencies.find(c => c.code === mother.expectedCurrencyCode)?.minorUnit ?? 2) : "");
  const [period, setPeriod] = useState(mother.billingPeriodUnit + ":" + mother.billingPeriodCount);
  const [joined, setJoined] = useState(mother.joinedDate ?? "");
  const [paymentDay, setPaymentDay] = useState(mother.monthlyPaymentDay ? String(mother.monthlyPaymentDay) : "");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  function editMother() {
    setEditor({ role: "mother" });
    setEmail(mother.email); setStatus(mother.usageStatus ?? "");
    setContact(mother.contact); setNote(mother.label);
    setJoined(mother.joinedDate ?? "");
    setPaymentDay(mother.monthlyPaymentDay ? String(mother.monthlyPaymentDay) : "");
    const currency = currencies.find(c => c.code === mother.expectedCurrencyCode);
    setCode(currency?.code ?? defaultCode);
    setAmount(mother.expectedAmountMinor ? formatMinor(mother.expectedAmountMinor, currency?.minorUnit ?? 2) : "");
    setPeriod(mother.billingPeriodUnit + ":" + mother.billingPeriodCount);
  }
  function editMember(account?: ChildAccountListRow) {
    setEditor({ role: "child", account });
    const child = account?.childAccount;
    setEmail(child?.email ?? ""); setContact(child?.contact ?? ""); setNote(child?.label ?? "");
    setStatus(child ? childUsageStatus(child) : "rented");
    const currency = currencies.find(c => c.code === child?.monthlyCurrencyCode);
    setCode(currency?.code ?? defaultCode);
    setAmount(child ? formatMinor(child.monthlyAmountMinor, currency?.minorUnit ?? 2) : "");
    setPeriod(child ? child.billingPeriodUnit + ":" + child.billingPeriodCount : "month:1");
    setJoined(child?.joinedDate ?? format(new Date(), "yyyy-MM-dd"));
    setPaymentDay(String(child?.monthlyPaymentDay ?? new Date().getDate()));
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!editor) return;
    if (!SEAT_USAGE_STATUSES.includes(status as SeatUsageStatus)) { toast.error("请选择使用状态。"); return; }
    const currency = currencies.find(c => c.code === code);
    if (!currency) { toast.error("请选择币种。"); return; }
    let amountMinor: number;
    try {
      amountMinor = parseToMinor(amount.trim() || "0", currency.minorUnit);
      if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new Error();
    } catch { toast.error("请输入有效金额，并检查小数位数。"); return; }
    if (status === "rented" && amountMinor <= 0) { toast.error("出租状态请输入正数约定收入。"); return; }
    if (status === "rented" && !contact.trim()) { toast.error("出租账号请输入联系方式。"); return; }
    const [unit, count] = period.split(":");
    startTransition(async () => {
      try {
        const result = editor.role === "mother" ? await updateTeamSeat({
          spaceId: earnings.spaceId, role: "mother", id: mother.id,
          usageStatus: status, email, contact, label: note,
          joinedDate: joined || null, monthlyPaymentDay: paymentDay ? Number(paymentDay) : null,
          amountMinor, currencyCode: code, billingPeriodUnit: unit, billingPeriodCount: Number(count),
        }) : await (editor.account ? updateChildAccount(editor.account.childAccount.id, {
          email, contact, label: note, seatType: "chatgpt", usageStatus: status,
          joinedDate: joined, monthlyPaymentDay: Number(paymentDay),
          monthlyAmountMinor: amountMinor, monthlyCurrencyCode: code, billingPeriodUnit: unit, billingPeriodCount: Number(count),
        }) : createChildAccount(earnings.spaceId, {
          email, contact, label: note, seatType: "chatgpt", usageStatus: status,
          joinedDate: joined, monthlyPaymentDay: Number(paymentDay),
          monthlyAmountMinor: amountMinor, monthlyCurrencyCode: code, billingPeriodUnit: unit, billingPeriodCount: Number(count),
        }));
        if (!result.ok) { toast.error(result.error); return; }
        toast.success("账号资料、使用状态和收入已保存"); setEditor(null); router.refresh();
      } catch { toast.error("保存失败，请重试。"); }
    });
  }
  function confirmAction() {
    if (!confirmation) return;
    startTransition(async () => {
      try {
        const result = confirmation.role === "mother"
          ? await renewMotherAccount(earnings.spaceId, motherDue ?? undefined)
          : confirmation.action === "delete"
          ? await deleteChildAccount(confirmation.account.childAccount.id)
          : await renewChildAccount(confirmation.account.childAccount.id, confirmation.account.childAccount.nextPaymentDate ?? undefined);
        if (!result.ok) { toast.error(result.error); return; }
        toast.success(confirmation.action === "delete" ? "成员记录已删除" : "付款周期已更新");
        setConfirmation(null); router.refresh();
      } catch { toast.error("操作失败，请重试。"); }
    });
  }
  function metrics(seat: TeamEarningSeat) {
    return <dl className="grid grid-cols-3 gap-2">
      {[{ label: "收入 / 月", value: seat.monthlyIncomeUsd }, { label: "分摊成本 / 月", value: seat.monthlyCostUsd },
        { label: "预计净收益 / 月", value: seat.monthlyNetUsd }].map(item =>
        <div key={item.label}><dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className={cn("mt-1 text-sm", item.value !== null && item.value < 0 && "text-destructive")}><MoneyDisplay compact className="flex-wrap" value={item.value} cnyRate={cnyRate} /></dd></div>)}
    </dl>;
  }
  const motherCurrency = currencies.find(c => c.code === mother.expectedCurrencyCode);
  const motherDue = mother.nextPaymentDate ?? (mother.joinedDate && mother.monthlyPaymentDay
    ? nextPaymentDueDate(mother.monthlyPaymentDay,
        { unit: mother.billingPeriodUnit as "month" | "quarter" | "year", count: mother.billingPeriodCount }, mother.joinedDate)
    : null);
  const confirmationEmail = confirmation?.role === "mother" ? mother.email : confirmation?.account.childAccount.email;
  return (
    <Card size="sm" id="team-earnings" className="scroll-mt-20">
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{spacePlanLabel(earnings.planType)} · 账号管理与收益</CardTitle>
          {shared && <Button onClick={() => editMember()} disabled={pending || !canAdd}
            title={!canAdd ? "Business 已有子账号，请编辑现有位置。" : undefined}>
            <Plus className="size-4" />新增{memberLabel}
          </Button>}
        </div>
        <CardDescription className="text-xs">
          {business ? "母号与子账号在此统一管理。" : "只管理拼车成员的出租资料和收益。"}
          金额按月折算，人民币优先、美元补充。
          {business ? "成本按登记位置均摊。" : "成本按参与成员分摊。"}
        </CardDescription>
        {earnings.unmarkedCount > 0 && <p className="text-sm text-amber-700 dark:text-amber-300">有位置尚未标记用途，当前收益仅包含已知约定收入。</p>}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          {[{ label: "总约定收入 / 月", value: earnings.monthlyIncomeUsd },
            { label: spacePlanLabel(earnings.planType) + " 成本 / 月", value: earnings.monthlyCostUsd },
            { label: "预计净收益 / 月", value: earnings.monthlyNetUsd }].map(item =>
            <div key={item.label} className="border-b pb-3"><p className="text-xs text-muted-foreground">{item.label}</p>
              <p className={cn("mt-1 text-lg font-semibold", item.value !== null && item.value < 0 && "text-destructive")}><MoneyDisplay compact className="flex-wrap" value={item.value} cnyRate={cnyRate} /></p></div>)}
        </div>
        <div className={cn("grid gap-3", business && "xl:grid-cols-2")}>
          {business && <section className="min-w-0 space-y-2.5 rounded-md border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><h3 className="text-xs font-medium text-muted-foreground">{motherLabel}</h3><p className="mt-1 break-all font-mono text-sm">{mother.email}</p></div>
              <Badge variant="outline">{SEAT_USAGE_LABELS[motherSeat.usageStatus]}</Badge>
            </div>
            <p className="break-words text-xs text-muted-foreground">联系方式：{mother.contact || "—"} · 加入日期：{mother.joinedDate ?? "未登记"}</p>
            {mother.label && <p className="break-all text-xs text-muted-foreground">备注：{mother.label}</p>}
            {metrics(motherSeat)}
            {motherSeat.usageStatus === "rented" && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {motherCurrency && <span>约定收费：{formatCurrencyMinor(mother.expectedAmountMinor, motherCurrency)} / {PERIODS.find(p => p.value === mother.billingPeriodUnit + ":" + mother.billingPeriodCount)?.label ?? "每周期"}</span>}
              <span>下一付款日：{motherDue ?? "未登记"}</span>
              {motherDue && <ExpiryBadge expiryDate={motherDue} soonDays={soonDays} expireOnDate />}
            </div>}
            <div className="flex flex-wrap gap-1">
              <Button size="sm" variant="outline" disabled={pending} onClick={editMother}><Pencil className="size-3.5" />编辑{motherLabel}</Button>
              {motherSeat.usageStatus === "rented" && <Button size="sm" variant="ghost" disabled={pending || !motherDue} onClick={() => setConfirmation({ action: "renew", role: "mother" })}><RefreshCw className="size-3.5" />续费</Button>}
            </div>
          </section>}
          {shared && <section id="child-accounts" className="min-w-0 space-y-2.5 rounded-md border p-3">
            <h3 className="text-xs font-medium text-muted-foreground">{memberLabel}{!business && <span className="ml-2 font-normal">{accounts.length} 人</span>}</h3>
            {accounts.length ? <div className="divide-y">{accounts.map(account => {
              const child = account.childAccount;
              const seat = earnings.seats.find(item => item.role === "child" && item.id === child.id)!;
              const due = child.nextPaymentDate ?? nextPaymentDueDate(child.monthlyPaymentDay,
                { unit: child.billingPeriodUnit as "month" | "quarter" | "year", count: child.billingPeriodCount }, child.joinedDate);
              return <div key={child.id} className="space-y-2.5 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2"><p className="break-all font-mono text-sm font-medium">{child.email}</p>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline">{SEAT_USAGE_LABELS[seat.usageStatus]}</Badge></div></div>
                <p className="break-words text-xs text-muted-foreground">联系方式：{child.contact || "—"} · 加入日期：{child.joinedDate}</p>
                {child.label && <p className="break-all text-xs text-muted-foreground">备注：{child.label}</p>}
                {metrics(seat)}
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>约定收费：{formatCurrencyMinor(child.monthlyAmountMinor, account.currency)} / {PERIODS.find(p => p.value === child.billingPeriodUnit + ":" + child.billingPeriodCount)?.label ?? "每周期"}</span>
                  {seat.usageStatus === "rented" && <><span>下一付款日：{due}</span><ExpiryBadge expiryDate={due} soonDays={soonDays} expireOnDate /></>}
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => editMember(account)}><Pencil className="size-3.5" />编辑</Button>
                  {seat.usageStatus === "rented" && <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmation({ action: "renew", role: "child", account })}><RefreshCw className="size-3.5" />续费</Button>}
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmation({ action: "delete", role: "child", account })}><Trash2 className="size-3.5" />删除</Button>
                </div>
              </div>;
            })}</div> : <div className="space-y-3 py-5 text-center text-sm text-muted-foreground">
              <p>{business ? "子账号位置空闲。" : "还没有拼车成员，添加后可分别记录收费和使用状态。"}</p>
              <Button size="sm" variant="outline" onClick={() => editMember()}>新增{memberLabel}</Button>
            </div>}
          </section>}
        </div>
      </CardContent>
      <Dialog open={editor !== null} onOpenChange={open => { if (!open && !pending) setEditor(null); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>{editor?.role === "mother" ? "编辑" + motherLabel : (editor?.account ? "编辑" : "新增") + memberLabel}</DialogTitle>
            <DialogDescription>账号资料、使用状态、收费和周期在这里一次保存。</DialogDescription></DialogHeader>
          <form onSubmit={save}><fieldset disabled={pending} className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="account-email">{editor?.role === "mother" || business ? "邮箱 / 登录名" : "成员姓名 / 账号"}</Label>
              <Input id="account-email" value={email} required onChange={event => setEmail(event.target.value)} /></div>
            <div className="space-y-2"><Label htmlFor="account-use">使用状态</Label>
              <Select value={status} onValueChange={setStatus}><SelectTrigger id="account-use" className="w-full"><SelectValue placeholder="选择使用状态" /></SelectTrigger>
                <SelectContent>{SEAT_USAGE_STATUSES.map(value => <SelectItem key={value} value={value}>{SEAT_USAGE_LABELS[value]}</SelectItem>)}</SelectContent>
              </Select></div>
            <div className="space-y-2"><Label htmlFor="account-contact">联系方式</Label><Input id="account-contact" value={contact} required={status === "rented"} onChange={event => setContact(event.target.value)} /></div>
            <div className="space-y-2"><Label htmlFor="account-joined">加入日期</Label><Input id="account-joined" type="date" value={joined} onChange={event => setJoined(event.target.value)} required={editor?.role === "child" || status === "rented"} /></div>
            <div className="space-y-2"><Label htmlFor="account-payment-day">付款日（1–31）</Label><Input id="account-payment-day" type="number" min={1} max={31} required={editor?.role === "child" || status === "rented"} value={paymentDay} onChange={event => setPaymentDay(event.target.value)} /></div>
            <div className="space-y-2"><Label htmlFor="account-amount">约定收费 / 每周期</Label><Input id="account-amount" inputMode="decimal" value={amount} disabled={status !== "rented"}
              onChange={event => setAmount(event.target.value)} placeholder="例如：70.00" /></div>
            <div className="space-y-2"><Label htmlFor="account-currency">币种</Label><Select value={code} onValueChange={setCode} disabled={status !== "rented"}>
              <SelectTrigger id="account-currency" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{currencies.map(c =>
                <SelectItem key={c.code} value={c.code}>{c.symbol} {c.code}</SelectItem>)}</SelectContent>
            </Select></div>
            <div className="space-y-2"><Label htmlFor="account-period">计费周期</Label><Select value={period} onValueChange={setPeriod} disabled={status !== "rented"}>
              <SelectTrigger id="account-period" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{PERIODS.map(option =>
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select></div>
            <div className="space-y-2 sm:col-span-2"><Label htmlFor="account-note">备注</Label><Input id="account-note" value={note} onChange={event => setNote(event.target.value)} /></div>
            <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="outline" onClick={() => setEditor(null)}>取消</Button>
              <Button type="submit">{pending ? "保存中…" : "保存全部修改"}</Button></div>
          </fieldset></form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmation !== null} onOpenChange={open => { if (!open && !pending) setConfirmation(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{confirmation?.action === "delete" ? "删除" + memberLabel : "确认续费"}</AlertDialogTitle>
          <AlertDialogDescription>{confirmation?.action === "delete" ? "将删除「" + confirmationEmail + "」这条成员记录。"
            : "将按约定周期推进「" + confirmationEmail + "」的下一付款日，约定收费保持原值。"}</AlertDialogDescription>
        </AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
          <Button disabled={pending} variant={confirmation?.action === "delete" ? "destructive" : "default"} onClick={confirmAction}>{pending ? "处理中…" : "确认"}</Button>
        </AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
