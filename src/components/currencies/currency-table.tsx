// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
"use client";

import { WorkspacePageHeading } from "@/components/layout/workspace-header";
import { useState } from "react";
import { Pencil, Plus, Trash2, Search, X } from "lucide-react";
import type { CurrencyRow } from "@/db/currencies";
import type { CurrencyMeta } from "@/lib/currencies";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CurrencyDialog } from "./currency-dialog";
import { CurrencyDeleteDialog } from "./currency-delete-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type CurrencyTableProps = {
  currencies: CurrencyRow[];
  rateCurrencies: readonly CurrencyMeta[];
};

type DialogState =
  | { mode: "add" }
  | { mode: "edit"; currency: CurrencyRow }
  | null;

export function CurrencyTable({
  currencies,
  rateCurrencies,
}: CurrencyTableProps) {
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deleteTarget, setDeleteTarget] = useState<CurrencyRow | null>(null);
  const [countryQuery, setCountryQuery] = useState("");
  const existingCodes = currencies.map((currency) => currency.code);
  const normalizedCountryQuery = countryQuery.trim().toLowerCase();
  const filteredCurrencies = normalizedCountryQuery
    ? currencies.filter((currency) =>
        [
          currency.countryName,
          currency.countryCode,
          currency.name,
          currency.code,
        ].some((value) =>
          value.toLowerCase().includes(normalizedCountryQuery),
        ),
      )
    : currencies;

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b bg-background/95 px-4 py-4 sm:px-6 lg:px-8">
        <WorkspacePageHeading title="币种" actions={<Button onClick={() => setDialog({ mode: "add" })}><Plus className="size-4" />新增币种</Button>} />
        <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3"><div className="relative w-full max-w-sm">
          <Label htmlFor="currency-country-filter" className="sr-only">搜索币种</Label>
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
          <Input
            id="currency-country-filter"
            className="pl-9 pr-10"
            value={countryQuery}
            onChange={(event) => setCountryQuery(event.target.value)}
            placeholder="国家、币种名称或代码"
          />
          {countryQuery && <Button variant="ghost" size="icon-sm" className="absolute right-1 top-0.5" aria-label="清除币种搜索" onClick={() => setCountryQuery("")}><X /></Button>}
        </div><span data-currency-count role="status" aria-live="polite" className="shrink-0 text-xs text-muted-foreground">{normalizedCountryQuery ? "匹配" : "共"} <strong className="font-mono text-foreground">{filteredCurrencies.length}</strong>{normalizedCountryQuery ? ` / 全部 ${currencies.length} 个` : " 个币种"}</span></div>
        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">金额精度与报价</summary><div className="mt-2 max-w-md space-y-1 leading-5"><p>小数位数决定金额精度，例如人民币为 2 位。</p><p>新增币种随定时刷新获取报价；缺少汇率时，请先刷新汇率再创建订阅。</p></div></details>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4 sm:px-6 lg:px-8">
      <table data-slot="table" className="w-full min-w-[720px] table-fixed caption-bottom bg-card text-sm">
        <colgroup>
          <col className="w-[26%]" />
          <col className="w-[11%]" />
          <col className="w-[10%]" />
          <col />
          <col className="w-[14%]" />
          <col className="w-32" />
        </colgroup>
        <TableHeader className="sticky top-0 z-20 bg-background shadow-sm [&_th]:bg-background">
          <TableRow>
            <TableHead scope="col">国家/地区</TableHead>
            <TableHead scope="col">代码</TableHead>
            <TableHead scope="col">符号</TableHead>
            <TableHead scope="col">名称</TableHead>
            <TableHead scope="col" className="text-right">
              小数位数
            </TableHead>
            <TableHead scope="col" className="text-right">
              操作
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredCurrencies.map((row) => (
            <TableRow key={row.code}>
              <TableCell>{row.countryName}</TableCell>
              <TableCell className="font-mono font-medium">{row.code}</TableCell>
              <TableCell className="font-mono text-muted-foreground">{row.symbol}</TableCell>
              <TableCell>{row.name}</TableCell>
              <TableCell className="text-right font-mono">
                {row.minorUnit} <span className="text-xs text-muted-foreground">位</span>
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label={`编辑 ${row.code}`}
                        onClick={() => setDialog({ mode: "edit", currency: row })}
                      >
                        <Pencil className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>编辑</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label={`删除 ${row.code}`}
                        onClick={() => setDeleteTarget(row)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>删除</TooltipContent>
                  </Tooltip>
                </div>
              </TableCell>
            </TableRow>
          ))}
          {filteredCurrencies.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={6}
                className="py-8 text-center text-sm text-muted-foreground"
              >
                没有匹配的币种。可清除搜索查看全部国家、名称与代码。
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </table>
      </div>

      <CurrencyDialog
        open={dialog !== null}
        mode={dialog?.mode ?? "add"}
        currency={dialog?.mode === "edit" ? dialog.currency : undefined}
        rateCurrencies={rateCurrencies}
        existingCodes={existingCodes}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      />
      <CurrencyDeleteDialog
        currency={deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      />
    </div>
  );
}
