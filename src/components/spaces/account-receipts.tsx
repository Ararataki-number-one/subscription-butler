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
  const [deleteTarget, setDeleteTarget] = useState<AccountReceiptRow | null>(null);

  function openEditor(row?: AccountReceiptListRow) {
    setEditor({ id: row?.receipt.id });
    setDate(row?.receipt.receivedDate ?? format(new Date(), "yyyy-MM-dd"));
    setAmount(row ? formatMinor(row.receipt.amountMinor, row.currency.minorUnit) : "");
    setCode(row?.receipt.currencyCode ?? (currencies.some(c => c.code === "CNY") ? "CNY" : currencies[0]?.code ?? "USD"));
    setPayer(row?.receipt.payer ?? contact);
    setNote(row?.receipt.note ?? "");
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const currency = currencies.find(c => c.code === code);
    if (!currency) { toast.error("请选择币种。"); return; }
    let amountMinor: number;
    try {
      amountMinor = parseToMinor(amount, currency.minorUnit);
      if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error();
    } catch { toast.error("请输入有效的正数金额，并检查小数位数。"); return; }
    startTransition(async () => {
      try {
        const result = await saveAccountReceipt({
          id: editor?.id, spaceId, receivedDate: date, amountMinor, currencyCode: code, payer, note,
        });
        if (!result.ok) { toast.error(result.error); return; }
        setEditor(null);
        toast.success("收款记录已保存");
        router.refresh();
      } catch { toast.error("保存失败，请重试。"); }
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
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>收款记录</CardTitle>
          <Button onClick={() => openEditor()} disabled={pending}>登记收款</Button>
        </div>
        <CardDescription>
          共 {rows.length} 笔，累计折合 {dualMoneyText(totalUsd, cnyRate)}。人民币按缓存汇率折算；账号续费后保留全部记录。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {editor && (
          <form onSubmit={save} className="rounded-lg border bg-muted/20 p-4">
            <fieldset disabled={pending} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <legend className="mb-3 text-sm font-medium">{editor.id ? "编辑收款" : "登记收款"}</legend>
              <div className="space-y-2"><Label htmlFor="receipt-date">收款日期</Label>
                <Input id="receipt-date" type="date" required value={date} onChange={e => setDate(e.target.value)} /></div>
              <div className="space-y-2"><Label htmlFor="receipt-amount">实收金额</Label>
                <Input id="receipt-amount" inputMode="decimal" required placeholder="例如 100.00" value={amount} onChange={e => setAmount(e.target.value)} /></div>
              <div className="space-y-2"><Label htmlFor="receipt-currency">币种</Label>
                <Select value={code} onValueChange={setCode}><SelectTrigger id="receipt-currency" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{currencies.map(c => <SelectItem key={c.code} value={c.code}>{c.symbol} {c.code}</SelectItem>)}</SelectContent>
                </Select></div>
              <div className="space-y-2"><Label htmlFor="receipt-payer">付款人 / 联系方式</Label>
                <Input id="receipt-payer" maxLength={200} value={payer} onChange={e => setPayer(e.target.value)} /></div>
              <div className="space-y-2 sm:col-span-2"><Label htmlFor="receipt-note">备注</Label>
                <Input id="receipt-note" maxLength={1000} placeholder="例如：9 月订阅费用" value={note} onChange={e => setNote(e.target.value)} /></div>
              <div className="flex justify-end gap-2 sm:col-span-2 lg:col-span-3">
                <Button type="button" variant="outline" onClick={() => setEditor(null)}>取消</Button>
                <Button type="submit">{pending ? "保存中…" : "保存收款"}</Button>
              </div>
            </fieldset>
          </form>
        )}
        {rows.length ? (
          <Table>
            <TableHeader><TableRow>
              <TableHead>收款日期</TableHead><TableHead>付款人</TableHead>
              <TableHead className="text-right">实收原币金额</TableHead><TableHead className="text-right">人民币参考 / 美元</TableHead>
              <TableHead>备注</TableHead><TableHead className="text-right">操作</TableHead>
            </TableRow></TableHeader>
            <TableBody>{rows.map(({ receipt, currency }) => (
              <TableRow key={receipt.id}>
                <TableCell className="font-mono">{receipt.receivedDate}</TableCell>
                <TableCell>{receipt.payer || "—"}</TableCell>
                <TableCell className="text-right font-mono">{formatCurrencyMinor(receipt.amountMinor, currency)}</TableCell>
                <TableCell className="text-right" title={`汇率日期：${receipt.rateAsOf}`}><MoneyDisplay value={receipt.amountUsd} cnyRate={cnyRate} compact /></TableCell>
                <TableCell className="max-w-sm whitespace-normal break-words">{receipt.note || "—"}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" disabled={pending} onClick={() => openEditor({ receipt, currency })}>编辑</Button>
                  <Button variant="ghost" size="sm" disabled={pending} onClick={() => setDeleteTarget(receipt)}>删除</Button>
                </TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        ) : <p className="py-8 text-center text-sm text-muted-foreground">暂无收款记录。收到款项后点击“登记收款”。</p>}
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
