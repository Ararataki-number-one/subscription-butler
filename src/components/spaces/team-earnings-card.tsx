"use client";

import Link from "next/link";
import { CircleAlert } from "lucide-react";
import type { TeamEarnings } from "@/db/teamEarnings";
import { SEAT_USAGE_LABELS } from "@/lib/seat-usage";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MoneyDisplay } from "@/components/money-display";
import { dualMoneyText, type CnyDisplayRate } from "@/lib/money-display";

export function earningsMoney(value: number | null) {
  return value === null ? "待计算" : (value < 0 ? "-$" : "$") + formatMinor(Math.abs(value), 2);
}
export function TeamEarningsSummary({ earnings, cnyRate = null }: { earnings: TeamEarnings; cnyRate?: CnyDisplayRate | null }) {
  const business = earnings.planType === "team";
  const roles = business ? ["mother", "child"] as const : ["child"] as const;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link href={`/spaces/${earnings.spaceId}#team-earnings`}
          aria-label="查看账号状态与收益明细"
          className="block min-w-0 space-y-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
          <div className="flex items-start gap-1">
            <span className={cn("min-w-0 font-mono text-sm font-semibold tabular-nums",
              earnings.monthlyNetUsd === null ? "text-muted-foreground" : earnings.monthlyNetUsd < 0 ? "text-destructive" : "text-primary")}>
              <MoneyDisplay value={earnings.monthlyNetUsd} cnyRate={cnyRate} compact className="gap-x-1.5 gap-y-0" />
            </span>
            {earnings.unmarkedCount > 0 && <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-label="含待标记账号，收益为已知收入估算" />}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {roles.map(role => {
        const seats = earnings.seats.filter(seat => seat.role === role);
        const states = Array.from(new Set(seats.map(seat => SEAT_USAGE_LABELS[seat.usageStatus]))).join(" / ") || "暂无成员";
        return <span key={role} className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1">
          <span className="text-muted-foreground">{role === "mother" ? "母号" : business ? "子账号" : `拼车 ${seats.length}人`}</span>
          <Badge variant="outline" className="h-auto min-h-5 whitespace-normal px-1.5 py-0 text-xs font-normal">{states}</Badge>
        </span>;
      })}
          </div>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={8} className="max-w-sm whitespace-normal">
        <div className="space-y-1 text-xs">
          <p>月约定收入 {dualMoneyText(earnings.monthlyIncomeUsd, cnyRate)} · 月成本 {dualMoneyText(earnings.monthlyCostUsd, cnyRate)}</p>
          {roles.map(role => {
            const seats = earnings.seats.filter(seat => seat.role === role);
            const income = seats.reduce((sum, seat) => sum + seat.monthlyIncomeUsd, 0);
            const states = Array.from(new Set(seats.map(seat => SEAT_USAGE_LABELS[seat.usageStatus]))).join(" / ") || "暂无成员";
            return <p key={role}>{role === "mother" ? "母号" : business ? "子账号" : "拼车成员"}：{states} · 月收入 {dualMoneyText(income, cnyRate)}</p>;
          })}
          {earnings.unmarkedCount > 0 && <p>有账号尚未标记，当前净收益仅按已知收入估算。</p>}
          <p className="opacity-75">点击查看明细和设置</p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
