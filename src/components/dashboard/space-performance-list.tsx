// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
import Link from "next/link";
import type { DashboardSpacePerformance } from "@/db/dashboard";
import { MoneyDisplay } from "@/components/money-display";
import type { CnyDisplayRate } from "@/lib/money-display";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

const statusLabel = {
  cost_uncovered: "成本覆盖不足",
  no_rental_income: "无出租收入",
  cost_covered: "已覆盖成本",
} as const;

export function SpacePerformanceList({
  items,
  cnyRate = null,
}: {
  items: DashboardSpacePerformance[];
  cnyRate?: CnyDisplayRate | null;
}) {
  const visibleItems = items.slice(0, 5);
  const attentionCount = items.filter(
    (item) => item.status !== "cost_covered",
  ).length;

  return (
    <Card size="sm" className="min-h-full">
      <CardHeader className="border-b border-border/70 pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle as="h3">空间经营表现</CardTitle>
            <CardDescription className="mt-1 leading-5">
              母号与子号约定收入减去 Business 成本，统一按月折算，优先展示需要核对的空间。
            </CardDescription>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-[11px] font-medium text-muted-foreground">
              待核对
            </p>
            <p className="font-mono text-sm font-semibold tabular-nums text-foreground">
              {attentionCount}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-2">
        <div className="hidden grid-cols-[minmax(10rem,1fr)_6rem_6rem_6.5rem] gap-3 border-b border-border/70 px-2 py-2 text-[11px] text-muted-foreground sm:grid">
          <span>空间</span>
          <span className="text-right">月成本</span>
          <span className="text-right">月约定收入</span>
          <span className="text-right">净贡献</span>
        </div>
        <div className="divide-y divide-border/60">
          {visibleItems.map((item) => (
            <div
              key={item.id}
              className="grid gap-3 px-2 py-3 sm:grid-cols-[minmax(10rem,1fr)_6rem_6rem_6.5rem] sm:items-center"
            >
              <div className="min-w-0">
                <Link
                  href={`/spaces/${item.id}`}
                  className="block truncate font-medium text-foreground underline-offset-4 hover:underline"
                >
                  {item.name}
                </Link>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <Badge
                    variant={
                      item.status === "cost_uncovered"
                        ? "destructive"
                        : item.status === "cost_covered"
                          ? "secondary"
                          : "outline"
                    }
                  >
                    {statusLabel[item.status]}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground">
                    {item.rentedChildAccounts} 个出租账号
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3 sm:contents">
                <div className="min-w-0 text-right">
                  <span className="block text-[10px] text-muted-foreground sm:hidden">
                    支出
                  </span>
                  <p className="truncate font-mono text-xs tabular-nums">
                    <MoneyDisplay value={item.spacePaymentUsdMinor} cnyRate={cnyRate} className="items-end" />
                  </p>
                </div>
                <div className="min-w-0 text-right">
                  <span className="block text-[10px] text-muted-foreground sm:hidden">
                    出租应收
                  </span>
                  <p className="truncate font-mono text-xs tabular-nums">
                    <MoneyDisplay value={item.rentedRevenueUsdMinor} cnyRate={cnyRate} className="items-end" />
                  </p>
                </div>
                <div className="min-w-0 text-right">
                  <span className="block text-[10px] text-muted-foreground sm:hidden">
                    净贡献
                  </span>
                  <p
                    className={cn(
                      "truncate font-mono text-xs font-semibold tabular-nums",
                      item.netUsdMinor < 0
                        ? "text-destructive"
                        : "text-primary",
                    )}
                  >
                    <MoneyDisplay value={item.netUsdMinor} cnyRate={cnyRate} className="items-end" />
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
      <CardFooter className="justify-between gap-3 text-xs text-muted-foreground">
        <span>
          {items.length > visibleItems.length
            ? `另有 ${items.length - visibleItems.length} 个空间`
            : `共 ${items.length} 个空间`}
        </span>
        <Link
          href="/spaces"
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          查看全部空间
        </Link>
      </CardFooter>
    </Card>
  );
}
