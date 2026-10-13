// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
import Link from "next/link";
import { db } from "@/db";
import { getDashboardOverview } from "@/db/dashboard";
import { getCnyDisplayRate } from "@/db/fxRates";
import { MoneyDisplay } from "@/components/money-display";
import { DistributionList } from "@/components/dashboard/distribution-list";
import { ExpiringChildAccountTable } from "@/components/dashboard/expiring-child-account-table";
import { ExpiringSpaceTable } from "@/components/dashboard/expiring-space-table";
import { MetricCard } from "@/components/dashboard/metric-card";
import { SpacePerformanceList } from "@/components/dashboard/space-performance-list";
import { Button } from "@/components/ui/button";

// better-sqlite3 is a native module - keep this RSC on the Node runtime.
export const dynamic = "force-dynamic";

export default function DashboardPage() {
  const overview = getDashboardOverview(db);
  const { totals, counts, distributions, spacePerformance, thresholds } =
    overview;
  const cnyRate = getCnyDisplayRate(db);
  const money = (value: number | null) => <MoneyDisplay value={value} cnyRate={cnyRate} />;
  const totalTeamRevenue = totals.childMonthlyRevenueUsdMinor + totals.motherMonthlyRevenueUsdMinor;
  const hasAnyRisk =
    totals.renewalRiskSpaces > 0 || totals.renewalRiskChildAccounts > 0;

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-7 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-5 border-b border-border/80 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          <h1 className="text-3xl font-semibold tracking-tight">
            仪表盘
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            先处理续费风险，再核对本期成本与应收。
          </p>
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          {hasAnyRisk ? (
            <Button asChild className="w-fit">
              <a href="#renewal-risk">查看到期风险</a>
            </Button>
          ) : null}
          <Button asChild variant="outline" className="w-fit">
            <Link href="/spaces">管理空间</Link>
          </Button>
        </div>
      </header>

      {totals.totalSpaces === 0 ? (
        <div className="mt-8 flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-muted/20 px-6 py-14 text-center">
          <h2 className="text-base font-semibold">还没有空间数据</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            先到空间列表新增空间。仪表盘会在有数据后显示空间支出、出租账号收入和到期风险。
          </p>
          <Button asChild variant="outline">
            <Link href="/spaces">前往空间列表</Link>
          </Button>
        </div>
      ) : (
        <main className="space-y-9 py-8">
          <section
            aria-labelledby="dashboard-summary"
            className="grid gap-8 border-b border-border/75 pb-8 xl:grid-cols-[minmax(0,1.05fr)_minmax(22rem,0.95fr)]"
          >
            <div>
              <div>
                <h2
                  id="dashboard-summary"
                  className="text-lg font-semibold tracking-tight"
                >
                  续费风险
                </h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  已过期、今日到期和近期到期的项目会优先出现在下方工作台。
                </p>
              </div>
              <div className="mt-6 grid gap-x-7 gap-y-6 sm:grid-cols-2">
                <MetricCard
                  label="空间到期风险"
                  value={String(totals.renewalRiskSpaces)}
                  tone={
                    counts.spacesByExpiryStatus.expired > 0
                      ? "risk"
                      : counts.spacesByExpiryStatus.soon > 0
                        ? "warning"
                        : "default"
                  }
                  description={
                    <>
                      已过期 {counts.spacesByExpiryStatus.expired}，{thresholds.spaceSoonDays} 天内{" "}
                      {counts.spacesByExpiryStatus.soon}
                    </>
                  }
                />
                <MetricCard
                  label="出租账号到期风险"
                  value={String(totals.renewalRiskChildAccounts)}
                  tone={
                    counts.childAccountsByExpiryStatus.expired > 0 ||
                    counts.childAccountsByExpiryStatus.due > 0
                      ? "risk"
                      : counts.childAccountsByExpiryStatus.soon > 0
                        ? "warning"
                        : "default"
                  }
                  description={
                    <>
                      逾期 {counts.childAccountsByExpiryStatus.expired}，今日{" "}
                      {counts.childAccountsByExpiryStatus.due}，{thresholds.childAccountSoonDays} 天内{" "}
                      {counts.childAccountsByExpiryStatus.soon}
                    </>
                  }
                />
              </div>
            </div>

            <div className="rounded-lg border border-primary/15 bg-accent/30 p-5 sm:p-6">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">Business 每月预计收益</h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  汇总母号与子账号的约定收入，收入和成本均按月折算。
                </p>
                {overview.incompleteTeamEarnings > 0 && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                  {overview.incompleteTeamEarnings} 个 Business 有待标记位置或缺少成本，当前汇总仅包含已知数据。
                </p>}
              </div>
              <div className="mt-6 grid gap-x-7 gap-y-6 sm:grid-cols-2">
                <MetricCard
                  label="Business 支出"
                  value={money(totals.spacePaymentUsdMinor)}
                  tone="expense"
                  description="Business 订阅成本按月折算"
                />
                <MetricCard
                  label="出租账号应收"
                  value={money(totalTeamRevenue)}
                  tone="income"
                  description="约定收入按月折算，人民币按缓存汇率展示"
                />
              </div>
              <div className="mt-5 border-t border-primary/15 pt-4">
                <p className="text-xs text-muted-foreground">预计净收入</p>
                <p className="mt-2 font-mono text-xl font-semibold tabular-nums">
                  {money(totals.netMonthlyUsdMinor)}
                </p>
              </div>
            </div>
          </section>

          {overview.proAccounts.count > 0 && (
            <section className="rounded-lg border bg-card p-5 sm:p-6">
              <h2 className="text-lg font-semibold">Pro 每月预计收益</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                共 {overview.proAccounts.count} 个 Pro，其中 {overview.proAccounts.sharedCount} 个多人拼车。Pro 的收入、成本和净收益单独汇总。
              </p>
              <div className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard label="Pro 约定收入 / 月" value={money(overview.proAccounts.monthlyIncomeUsdMinor)} tone="income" />
                <MetricCard label="Pro 成本 / 月" value={money(overview.proAccounts.monthlyCostUsdMinor)} tone="expense" />
                <MetricCard label="Pro 预计净收益 / 月" value={overview.proAccounts.monthlyNetUsdMinor === null ? "待完善成本" : money(overview.proAccounts.monthlyNetUsdMinor)} />
                <MetricCard label="Pro 本自然月实收" value={money(overview.proAccounts.receivedThisMonthUsdMinor)} tone="income" />
              </div>
            </section>
          )}
          {overview.independentAccounts.count > 0 && (
            <section className="rounded-lg border bg-card p-5 sm:p-6">
              <h2 className="text-lg font-semibold">独立订阅</h2>
              <p className="mt-1 text-sm text-muted-foreground">Plus 和其他订阅的成本与实收。收款按实际日期统计，续费历史保留在账号详情中。</p>
              <div className="mt-5 grid gap-5 sm:grid-cols-3">
                <MetricCard label="独立账号" value={String(overview.independentAccounts.count)} />
                <MetricCard label="当前周期订阅成本" value={money(overview.independentAccounts.costUsdMinor)} tone="expense" />
                <MetricCard label="本自然月实收" value={money(overview.independentAccounts.receivedThisMonthUsdMinor)} tone="income" />
              </div>
            </section>
          )}
          <section id="renewal-risk" className="scroll-mt-20">
            <div className="mb-5">
              <h2 className="text-xl font-semibold tracking-tight">续费工作台</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                先处理空间成本，再处理出租账号的收款风险。
              </p>
            </div>
            <div className="grid gap-8 xl:grid-cols-2">
              <div className="min-w-0 space-y-3">
                <div className="flex items-baseline justify-between gap-4">
                  <h3 className="text-sm font-semibold">空间续费</h3>
                  <span className="text-xs text-muted-foreground">
                    未来 {thresholds.spaceSoonDays} 天
                  </span>
                </div>
                <ExpiringSpaceTable
                  spaces={overview.expiringSpaces}
                  cnyRate={cnyRate}
                  soonDays={thresholds.spaceSoonDays}
                />
              </div>
              <div className="min-w-0 space-y-3">
                <div className="flex items-baseline justify-between gap-4">
                  <h3 className="text-sm font-semibold">出租账号收款</h3>
                  <span className="text-xs text-muted-foreground">
                    未来 {thresholds.childAccountSoonDays} 天
                  </span>
                </div>
                <ExpiringChildAccountTable
                  accounts={overview.expiringChildAccounts}
                  cnyRate={cnyRate}
                  soonDays={thresholds.childAccountSoonDays}
                />
              </div>
            </div>
          </section>

          <section className="border-t border-border/75 pt-8">
            <div>
              <h2 className="text-xl font-semibold tracking-tight">运营规模</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                自用账号只计规模，出租账号同时进入应收计算。
              </p>
            </div>
            <dl className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <div className="border-l-2 border-primary/45 pl-4">
                <dt className="text-xs text-muted-foreground">空间与账号总数</dt>
                <dd className="mt-2 font-mono text-2xl font-semibold tabular-nums">
                  {totals.totalSpaces}
                </dd>
              </div>
              <div className="border-l-2 border-primary/45 pl-4">
                <dt className="text-xs text-muted-foreground">出租账号</dt>
                <dd className="mt-2 font-mono text-2xl font-semibold tabular-nums">
                  {totals.rentedChildAccounts}
                </dd>
              </div>
              <div className="border-l-2 border-primary/45 pl-4">
                <dt className="text-xs text-muted-foreground">自用账号</dt>
                <dd className="mt-2 font-mono text-2xl font-semibold tabular-nums">
                  {totals.selfUseChildAccounts}
                </dd>
              </div>
              <div className="border-l-2 border-primary/45 pl-4">
                <dt className="text-xs text-muted-foreground">子账号总数</dt>
                <dd className="mt-2 font-mono text-2xl font-semibold tabular-nums">
                  {totals.totalChildAccounts}
                </dd>
              </div>
            </dl>
            <div className="mt-7 grid gap-4 border-t border-border/70 pt-5 text-sm sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">Business 账号合计</p>
                <p className="mt-2 font-mono tabular-nums">
                  {counts.allAccountsBySeatType.codex + counts.allAccountsBySeatType.chatgpt} 个
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">母号</p>
                <p className="mt-2 font-mono tabular-nums">
                  {counts.motherAccountsBySeatType.codex + counts.motherAccountsBySeatType.chatgpt} 个
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">子账号</p>
                <p className="mt-2 font-mono tabular-nums">
                  {counts.childAccountsBySeatType.codex + counts.childAccountsBySeatType.chatgpt} 个
                </p>
              </div>
            </div>
          </section>

          <section className="border-t border-border/75 pt-8">
            <div className="mb-5">
              <h2 className="text-xl font-semibold tracking-tight">Business 支出分布</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                按支付渠道查看资金去向，并核对各空间的成本覆盖情况。
              </p>
            </div>
            {totals.spacePaymentUsdMinor === 0 ? (
              <div className="rounded-lg border border-dashed bg-muted/20 p-5 text-sm text-muted-foreground">
                暂无空间支出分布。新增带有订阅成本的空间后，这里会按渠道和空间汇总。
              </div>
            ) : (
              <div className="grid items-stretch gap-5 xl:grid-cols-2">
                <DistributionList
                  title="按支付渠道"
                  description="空间付款归属到对应的支付渠道。"
                  buckets={distributions.spendingByPaymentChannel}
                  totalUsdMinor={totals.spacePaymentUsdMinor}
                  cnyRate={cnyRate}
                />
                <SpacePerformanceList items={spacePerformance} cnyRate={cnyRate} />
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}
