"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import { saveAccountReceipt, deleteAccountReceipt } from "@/actions/accountReceipts";
import type { AccountReceiptListRow, AccountReceiptRow } from "@/db/accountReceipts";
import type { CurrencyRow } from "@/db/currencies";
import { formatCurrencyMinor } from "@/lib/currencies";
import { formatMinor, parseToMinor } from "@/lib/money";
import { MoneyDisplay } from "@/components/money-display";
import { dualMoneyText, type CnyDisplayRate } from "@/lib/money-display";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function AccountReceipts({ spaceId, rows, currencies, contact, cnyRate = null }: {
  spaceId: number; rows: AccountReceiptListRow[]; currencies: CurrencyRow[]; contact: string; cnyRate?: CnyDisplayRate | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editor, setEditor] = useState<{ id?: number } | null>(null);
  const [date, setDate] = useState("");
  const [amount, setAmount] = useState("");
  const [code, setCode] = useState("CNY");
  const [payer, setPayer] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<{ date?: string; amount?: string; currency?: string }>({});
  const [saveError, setSaveError] = useState("");
  const [expandedNotes, setExpandedNotes] = useState<Record<number, boolean>>({});
  const [expandedPayers, setExpandedPayers] = useState<Record<number, boolean>>({});
  const [deleteTarget, setDeleteTarget] = useState<AccountReceiptRow | null>(null);

  function openEditor(row?: AccountReceiptListRow) {
    setEditor({ id: row?.receipt.id });
    setDate(row?.receipt.receivedDate ?? format(new Date(), "yyyy-MM-dd"));
    setAmount(row ? formatMinor(row.receipt.amountMinor, row.currency.minorUnit) : "");
    setCode(row?.receipt.currencyCode ?? (currencies.some(c => c.code === "CNY") ? "CNY" : currencies[0]?.code ?? "USD"));
    setPayer(row?.receipt.payer ?? contact);
    setNote(row?.receipt.note ?? "");
    setErrors({});
    setSaveError("");
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const currency = currencies.find(c => c.code === code);
    const nextErrors: typeof errors = {};
    const receivedDate = new Date(date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(receivedDate.getTime()) || receivedDate.toISOString().slice(0, 10) !== date) {
      nextErrors.date = "请输入有效的收款日期。";
    }
    if (!currency) nextErrors.currency = "请选择币种。";
    let amountMinor = 0;
    if (currency) {
      try {
        amountMinor = parseToMinor(amount, currency.minorUnit);
        if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error();
      } catch {
        const fractionalPart = /^-?\d+\.(\d+)$/.exec(amount.trim())?.[1];
        nextErrors.amount = fractionalPart && fractionalPart.length > currency.minorUnit
          ? `${currency.code}${currency.minorUnit ? `最多支持 ${currency.minorUnit} 位小数` : "仅支持整数"}。`
          : /^-?\d+(?:\.\d+)?$/.test(amount.trim()) && Number(amount) <= 0
            ? "请输入大于 0 的实收金额。"
            : "请输入有效的实收金额。";
      }
    }
    setErrors(nextErrors);
    setSaveError("");
    if (Object.keys(nextErrors).length) {
      event.currentTarget.querySelector<HTMLInputElement>(nextErrors.date ? "#receipt-date" : nextErrors.amount ? "#receipt-amount" : "#receipt-currency")?.focus();
      return;
    }
    startTransition(async () => {
      try {
        const result = await saveAccountReceipt({
          id: editor?.id, spaceId, receivedDate: date, amountMinor, currencyCode: code, payer, note,
        });
        if (!result.ok) { setSaveError(result.error); return; }
        setEditor(null);
        toast.success("收款记录已保存");
        router.refresh();
      } catch { setSaveError("保存失败，输入已保留。"); }
    });
  }

  function remove() {
    if (!deleteTarget) return;
    startTransition(async () => {
      try {
        const result = await deleteAccountReceipt(deleteTarget.id);
        if (!result.ok) { toast.error(result.error); return; }
        setDeleteTarget(null);
        toast.success("收款记录已删除");
        router.refresh();
      } catch { toast.error("删除失败，请重试。"); }
    });
  }

  const totalUsd = rows.reduce((sum, { receipt }) => sum + receipt.amountUsd, 0);
  const selectedCurrency = currencies.find(c => c.code === code);
  return (
    <Card className="min-w-0">
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>收款记录</CardTitle>
          <Button onClick={() => openEditor()} disabled={pending || !!editor}>登记收款</Button>
        </div>
        <CardDescription className="space-y-1 text-[13px] leading-5">
          <p>共 <span className="font-medium text-foreground">{rows.length}</span> 笔 · 累计参考折合 <span className="font-mono text-foreground">{dualMoneyText(totalUsd, cnyRate)}</span></p>
          <p>实收以原币金额为准；美元保留收款汇率快照，人民币按缓存汇率参考折算。账号续费后保留全部记录。</p>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {editor && (
          <form onSubmit={save} noValidate aria-labelledby="receipt-editor-title" className="overflow-hidden rounded-lg border border-primary/25 bg-card">
            <div className="flex items-center justify-between gap-4 border-b border-primary/15 bg-background px-4 py-3">
              <div>
                <h3 id="receipt-editor-title" className="text-sm font-semibold text-primary">{editor.id ? "编辑收款" : "登记收款"}</h3>
                <p className="mt-1 text-[13px] text-muted-foreground">按实际到账填写，金额与币种一起保存。</p>
              </div>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setEditor(null)}>取消</Button>
            </div>
            <fieldset disabled={pending} className="min-w-0 space-y-4 p-4">
              <legend className="sr-only">收款信息</legend>
              <div className="grid items-start gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,0.8fr)]">
                <div className="min-w-0 space-y-2"><Label htmlFor="receipt-date">收款日期 <span className="text-[13px] font-normal text-muted-foreground">必填</span></Label>
                  <Input id="receipt-date" type="date" required value={date} aria-invalid={!!errors.date} aria-describedby={errors.date ? "receipt-date-error" : undefined} onChange={e => { setDate(e.target.value); setErrors(current => ({ ...current, date: undefined })); }} />
                  {errors.date && <p id="receipt-date-error" role="alert" className="text-[13px] text-destructive">{errors.date}</p>}</div>
                <div className="min-w-0 space-y-2"><Label htmlFor="receipt-amount">实收原币金额 <span className="text-[13px] font-normal text-muted-foreground">必填</span></Label>
                  <Input id="receipt-amount" inputMode="decimal" required placeholder="例如 100.00" className="font-mono tabular-nums" value={amount} aria-invalid={!!errors.amount} aria-describedby={errors.amount ? "receipt-amount-error" : "receipt-amount-hint"} onChange={e => { setAmount(e.target.value); setErrors(current => ({ ...current, amount: undefined })); }} />
                  {errors.amount ? <p id="receipt-amount-error" role="alert" className="text-[13px] text-destructive">{errors.amount}</p> : <p id="receipt-amount-hint" className="text-[13px] text-muted-foreground">{selectedCurrency?.minorUnit === 0 ? "所选币种仅支持整数" : `最多 ${selectedCurrency?.minorUnit ?? 2} 位小数`}，填写实际到账金额</p>}</div>
                <div className="min-w-0 space-y-2"><Label htmlFor="receipt-currency">收款币种 <span className="text-[13px] font-normal text-muted-foreground">必填</span></Label>
                  <Select value={code} onValueChange={value => { setCode(value); setErrors(current => ({ ...current, currency: undefined, amount: undefined })); }}><SelectTrigger id="receipt-currency" className="w-full" aria-invalid={!!errors.currency} aria-describedby={errors.currency ? "receipt-currency-error" : undefined}><SelectValue /></SelectTrigger>
                    <SelectContent>{currencies.map(c => <SelectItem key={c.code} value={c.code}>{c.symbol} {c.code}</SelectItem>)}</SelectContent>
                  </Select>
                  {errors.currency && <p id="receipt-currency-error" role="alert" className="text-[13px] text-destructive">{errors.currency}</p>}</div>
              </div>
              <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
                <div className="min-w-0 space-y-2"><Label htmlFor="receipt-payer">付款人 / 联系方式 <span className="text-[13px] font-normal text-muted-foreground">选填</span></Label>
                  <Input id="receipt-payer" maxLength={200} value={payer} onChange={e => setPayer(e.target.value)} /></div>
                <div className="min-w-0 space-y-2"><Label htmlFor="receipt-note">备注 <span className="text-[13px] font-normal text-muted-foreground">选填</span></Label>
                  <textarea id="receipt-note" maxLength={1000} rows={2} placeholder="例如：9 月订阅费用" value={note} onChange={e => setNote(e.target.value)} className="flex min-h-20 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50" /></div>
              </div>
              {saveError && <div role="alert" className="rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive">{saveError} <span className="font-normal">请检查后重试。</span></div>}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                <p className="text-[13px] text-muted-foreground">仅登记收款，不改变账号续费日期。</p>
                <Button type="submit">{pending ? "保存中…" : "保存收款"}</Button>
              </div>
            </fieldset>
          </form>
        )}
        {rows.length ? (
          <div className="@container min-w-0 space-y-2">
          <p className="text-[13px] text-muted-foreground @[1042px]:hidden">横向滚动查看完整记录，操作固定在右侧。</p>
          <div className="overflow-hidden rounded-md border">
          <Table className="min-w-[1040px] table-fixed text-sm">
            <colgroup><col className="w-[116px]" /><col className="w-[180px]" /><col className="w-[150px]" /><col className="w-[190px]" /><col /><col className="w-[128px]" /></colgroup>
            <TableHeader><TableRow>
              <TableHead className="text-[13px]">收款日期</TableHead><TableHead className="text-[13px]">付款人</TableHead>
              <TableHead className="text-right text-[13px]">实收原币金额</TableHead><TableHead className="text-right text-[13px]">参考折算</TableHead>
              <TableHead className="text-[13px]">备注</TableHead><TableHead className="sticky right-0 z-10 bg-background text-right text-[13px] shadow-[-1px_0_0_0_var(--border)]">操作</TableHead>
            </TableRow></TableHeader>
            <TableBody>{rows.map(({ receipt, currency }) => (
              <TableRow key={receipt.id}>
                <TableCell className="align-top font-mono text-[13px] tabular-nums">{receipt.receivedDate}</TableCell>
                <TableCell className="align-top whitespace-normal break-all leading-6">
                  <div id={`receipt-payer-${receipt.id}`} className={expandedPayers[receipt.id] ? "" : "line-clamp-2"}>{receipt.payer || "—"}</div>
                  {(receipt.payer.length > 20 || receipt.payer.includes("\n")) && <Button type="button" variant="ghost" size="sm" className="mt-1 h-auto px-0 py-1 text-[13px] text-primary" aria-expanded={!!expandedPayers[receipt.id]} aria-controls={`receipt-payer-${receipt.id}`} onClick={() => setExpandedPayers(current => ({ ...current, [receipt.id]: !current[receipt.id] }))}>{expandedPayers[receipt.id] ? "收起付款人" : "展开付款人"}</Button>}
                </TableCell>
                <TableCell className="align-top text-right font-mono text-sm font-semibold tabular-nums">{formatCurrencyMinor(receipt.amountMinor, currency)}</TableCell>
                <TableCell className="align-top text-right text-[13px] text-muted-foreground" title={`美元汇率快照日期：${receipt.rateAsOf}`}><MoneyDisplay value={receipt.amountUsd} cnyRate={cnyRate} className="text-[13px] text-muted-foreground [&>span:last-child]:text-[13px]" /><p className="mt-1 whitespace-normal text-[13px] leading-5 text-muted-foreground">汇率快照：{receipt.rateAsOf}</p></TableCell>
                <TableCell className="align-top whitespace-pre-wrap break-words leading-6 [overflow-wrap:anywhere]">
                  <div id={`receipt-note-${receipt.id}`} className={expandedNotes[receipt.id] ? "" : "line-clamp-2"}>{receipt.note || "—"}</div>
                  {(receipt.note.length > 36 || receipt.note.includes("\n")) && <Button type="button" variant="ghost" size="sm" className="mt-1 h-auto px-0 py-1 text-[13px] text-primary" aria-expanded={!!expandedNotes[receipt.id]} aria-controls={`receipt-note-${receipt.id}`} onClick={() => setExpandedNotes(current => ({ ...current, [receipt.id]: !current[receipt.id] }))}>{expandedNotes[receipt.id] ? "收起备注" : "展开备注"}</Button>}
                </TableCell>
                <TableCell className="sticky right-0 z-10 bg-card align-top text-right shadow-[-1px_0_0_0_var(--border)]">
                  <div className="flex justify-end gap-1"><Button variant="ghost" size="sm" disabled={pending || !!editor} onClick={() => openEditor({ receipt, currency })}>编辑</Button>
                  <Button variant="ghost" size="sm" disabled={pending || !!editor} onClick={() => setDeleteTarget(receipt)}>删除</Button></div>
                </TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
          </div>
          </div>
        ) : !editor && <p className="py-8 text-center text-sm text-muted-foreground">暂无收款记录。收到款项后点击“登记收款”。</p>}
      </CardContent>
      <AlertDialog open={!!deleteTarget} onOpenChange={open => { if (!open && !pending) setDeleteTarget(null); }}>
        <AlertDialogContent><AlertDialogHeader>
          <AlertDialogTitle>删除收款记录</AlertDialogTitle>
          <AlertDialogDescription>将删除 {deleteTarget?.receivedDate} 的这笔收款记录，此操作不可撤销。</AlertDialogDescription>
        </AlertDialogHeader><AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
          <Button variant="destructive" disabled={pending} onClick={remove}>{pending ? "删除中…" : "确认删除"}</Button>
        </AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
