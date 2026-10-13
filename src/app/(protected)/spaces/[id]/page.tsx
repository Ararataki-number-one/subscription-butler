// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import { listChildAccounts } from "@/db/childAccounts";
import { listChannels } from "@/db/channels";
import { listCurrencies } from "@/db/currencies";
import { getCnyDisplayRate, getRate } from "@/db/fxRates";
import { getStatusThresholds } from "@/db/settings";
import { getSpaceDetail } from "@/db/spaces";
import { listAccountReceipts } from "@/db/accountReceipts";
import { AccountReceipts } from "@/components/spaces/account-receipts";
import { isIndependentPlan, isProPlan, spacePlanLabel } from "@/lib/space-plans";
import { getAccountEarnings } from "@/db/teamEarnings";
import { AccountManagementCard } from "@/components/spaces/account-management-card";
import { formatCountryLabel } from "@/lib/countries";
import { formatCurrencyMinor } from "@/lib/currencies";
import { MoneyDisplay } from "@/components/money-display";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ExpiryBadge } from "@/components/spaces/expiry-badge";
import { FrozenAmountHelp } from "@/components/spaces/frozen-amount-help";
import { SpaceDetailActions } from "@/components/spaces/space-detail-actions";
import { SpaceInlineEditor } from "@/components/spaces/space-form";

// better-sqlite3 is a native module — keep this RSC on the Node runtime.
export const dynamic = "force-dynamic";

function formatAsOf(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function DetailItem({
  label,
  children,
  className,
  action,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <div
      className={[
        "flex min-w-0 items-baseline gap-2 border-b border-border/40 py-2",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex w-24 shrink-0 items-center gap-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        {action}
      </div>
      <div className="min-w-0 break-all text-sm font-medium">{children}</div>
    </div>
  );
}

function formatPeriodLabel(unit: string | null, count: number | null): string {
  const label =
    unit === "year" ? "年" : unit === "quarter" ? "季度" : "月";
  return `${count ?? 1} ${label}`;
}

export default async function SpaceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ edit?: string; editMotherSeat?: string }>;
}) {
  const [{ id }, query] = await Promise.all([
    params,
    searchParams ?? Promise.resolve<{ edit?: string; editMotherSeat?: string }>({}),
  ]);
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) notFound();
  const isEditing = query.edit === "1";
  const isMotherSeatEditing = query.editMotherSeat === "1";

  const detail = getSpaceDetail(db, numericId);
  if (!detail) notFound();

  const channels = listChannels(db, true);
  const currencies = listCurrencies(db);
  const childAccounts = listChildAccounts(db, numericId);
  const thresholds = getStatusThresholds(db);
  const cnyDisplayRate = getCnyDisplayRate(db);
  const { space, motherAccount, paymentChannel, currency } = detail;
  const currentRate = getRate(db, space.currencyCode);
  const independent = isIndependentPlan(space.planType);
  const accountEarnings = getAccountEarnings(db)[space.id];
  const formValue = {
    id: space.id,
    name: space.name,
    planType: space.planType,
    sharingMode: space.sharingMode,
    customPlanName: space.customPlanName,
    contact: space.contact,
    country: space.country,
    paymentChannelId: space.paymentChannelId,
    currencyCode: space.currencyCode,
    amountMinor: space.amountMinor,
    openingDate: space.openingDate ?? "",
    currentPeriodStartDate:
      space.currentPeriodStartDate ?? space.openingDate ?? "",
    periodUnit: (space.periodUnit ?? "month") as "month" | "quarter" | "year",
    periodCount: space.periodCount ?? 1,
    motherEmail: motherAccount.email,
  };
  const editFormId = `space-${space.id}-detail-edit-form`;

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4 px-4 py-7 sm:px-6 lg:px-8">
      <div className="sticky top-14 z-20 -mx-4 -mt-7 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b bg-background/95 px-4 py-4 backdrop-blur-lg sm:relative sm:top-0 sm:mx-0 sm:mt-0 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:rounded-lg sm:border sm:bg-card">
        <Button asChild variant="outline" className="h-9 gap-2 px-3">
          <Link href="/spaces">
            <ArrowLeft aria-hidden="true" className="size-4" />
            返回列表
          </Link>
        </Button>
        <h1 className="col-span-2 row-start-2 min-w-0 truncate text-center text-xl font-semibold tracking-tight sm:absolute sm:left-1/2 sm:col-span-1 sm:row-start-1 sm:max-w-[52vw] sm:-translate-x-1/2 sm:text-2xl">
          {space.name}
        </h1>
        <div className="col-start-2 row-start-1 flex items-center gap-2 justify-self-end sm:col-start-3">
          <SpaceDetailActions
            space={formValue}
            childCount={childAccounts.length}
            isEditing={isEditing}
            editFormId={editFormId}
          />
        </div>
      </div>

      <Card size="sm">
        <CardHeader className="border-b">
          <CardTitle>{isEditing ? "编辑订阅" : `${spacePlanLabel(space.planType, space.customPlanName)} · ${independent ? "账号详情" : "空间详情"}`}</CardTitle>
          {isEditing && <CardDescription>
            修改空间资料后会重新计算到期日；金额或币种变化会重新计算记账成本。
          </CardDescription>}
          <CardAction>
            <ExpiryBadge
              expiryDate={space.expiryDate}
              soonDays={thresholds.spaceSoonDays}
            />
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          {isEditing ? (
            <SpaceInlineEditor
              space={formValue}
              channels={channels}
              currencies={currencies}
              cancelHref={`/spaces/${space.id}`}
              formId={editFormId}
            />
          ) : (
            <div className="grid gap-x-6 md:grid-cols-2 xl:grid-cols-3">
              {isProPlan(space.planType) && <DetailItem label="Pro 使用方式"><span>拼车</span></DetailItem>}
              <DetailItem label={independent ? "账号邮箱 / 登录名" : "母号"}>
                <span>{motherAccount.email}</span>
              </DetailItem>
              {independent && <DetailItem label="联系方式"><span>{space.contact || "—"}</span></DetailItem>}
              <DetailItem label="国家/地区">
                <span>{formatCountryLabel(space.country)}</span>
              </DetailItem>
              <DetailItem label="支付渠道">
                <span>{paymentChannel.name}</span>
              </DetailItem>
              <DetailItem label="订阅成本（原币）">
                <span className="font-mono">
                  {formatCurrencyMinor(space.amountMinor, currency)}
                </span>
              </DetailItem>
              <DetailItem label="首次开通日">
                <span className="font-mono">{space.openingDate ?? "-"}</span>
              </DetailItem>
              <DetailItem label="当前周期开始日">
                <span className="font-mono">
                  {space.currentPeriodStartDate ?? space.openingDate ?? "-"}
                </span>
              </DetailItem>
              <DetailItem label="订阅周期">
                <span>{formatPeriodLabel(space.periodUnit, space.periodCount)}</span>
              </DetailItem>
              <DetailItem label="支付手续费">
                <span className="font-mono">{space.feePercent}% · {formatCurrencyMinor(space.feeAmountMinor, currency)}</span>
              </DetailItem>
              <DetailItem label="含手续费合计">
                <span className="font-mono">{formatCurrencyMinor(space.amountMinor + space.feeAmountMinor, currency)}</span>
              </DetailItem>
              <DetailItem label="到期日">
                <span className="font-mono">{space.expiryDate ?? "-"}</span>
              </DetailItem>
              <DetailItem label="记账金额" action={<FrozenAmountHelp className="-my-1" />}>
                <MoneyDisplay compact value={space.amountUsd} cnyRate={cnyDisplayRate} />
              </DetailItem>
            </div>
          )}

          {isEditing && <div className="grid gap-x-6 md:grid-cols-2">
              <DetailItem label="到期日">
                <span className="font-mono">{space.expiryDate ?? "-"}</span>
              </DetailItem>
              <DetailItem
                label="记账金额"
                action={<FrozenAmountHelp className="-my-1" />}
              >
                <MoneyDisplay compact value={space.amountUsd} cnyRate={cnyDisplayRate} />
              </DetailItem>
          </div>}
          <details className="text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer py-1">汇率更新信息</summary>
            <p className="mt-1 leading-5">
                  每 5 分钟更新汇率，重算当前成本和预计收益。
                  报价日期 {currentRate?.quoteDate ?? "—"} · 最近检查 {formatAsOf(currentRate?.fetchedAt ?? null)}
            </p>
          </details>
        </CardContent>
      </Card>

      {accountEarnings && <AccountManagementCard
        earnings={accountEarnings} mother={motherAccount} accounts={childAccounts}
        currencies={currencies} soonDays={thresholds.childAccountSoonDays} initiallyEditMother={isMotherSeatEditing} cnyRate={cnyDisplayRate}
      />}
      {independent && (
        <AccountReceipts spaceId={space.id} rows={listAccountReceipts(db, space.id)}
          currencies={currencies} contact={space.contact} cnyRate={cnyDisplayRate} />
      )}
    </div>
  );
}
