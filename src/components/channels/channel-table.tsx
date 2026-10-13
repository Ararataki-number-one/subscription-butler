// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, ArrowUpRight, Pencil, Plus, RotateCcw, Search, Star, Wallet } from "lucide-react";
import { reactivateChannel, setChannelFavorite, type ChannelActionResult } from "@/actions/channels";
import type { ChannelRow, ChannelUsage } from "@/db/channels";
import { CHANNEL_TYPE_OPTIONS, channelTypeLabel } from "@/lib/payment-channels";
import { spacePlanLabel } from "@/lib/space-plans";
import { MoneyDisplay } from "@/components/money-display";
import { dualMoneyText, type CnyDisplayRate } from "@/lib/money-display";
import { cn } from "@/lib/utils";
import { ChannelDialog } from "./channel-dialog";
import { ArchiveDialog } from "./archive-dialog";
import { ExpiryBadge } from "@/components/spaces/expiry-badge";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Props = {
  channels: ChannelRow[];
  showArchived: boolean;
  usage: Record<number, ChannelUsage>;
  soonDays: number;
  cnyRate?: CnyDisplayRate | null;
};
type Status = "active" | "archived" | "all";
const EMPTY_USAGE: ChannelUsage = {
  subscriptions: [], total: 0, teamCount: 0, independentCount: 0,
  costUsdMinor: 0, missingCostCount: 0, overdueCount: 0, soonCount: 0, nextExpiryDate: null,
};

export function ChannelTable({ channels, showArchived, usage, soonDays, cnyRate = null }: Props) {
  const router = useRouter();
  const [dialog, setDialog] = useState<{ mode: "add" | "edit"; channel?: ChannelRow } | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ChannelRow | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>(showArchived ? "all" : "active");
  const [type, setType] = useState("all");
  const [useFilter, setUseFilter] = useState("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [pending, startTransition] = useTransition();

  const activeCount = channels.filter(channel => channel.isActive).length;
  const favoriteCount = channels.filter(channel => channel.isActive && channel.isFavorite).length;
  const allUsage = Object.values(usage);
  const subscriptionCount = allUsage.reduce((sum, item) => sum + item.total, 0);
  const attentionCount = allUsage.reduce((sum, item) => sum + item.overdueCount + item.soonCount, 0);
  const visible = useMemo(() => {
    const search = query.trim().toLowerCase();
    return channels.filter(channel => {
      const stats = usage[channel.id] ?? EMPTY_USAGE;
      if (status === "active" && !channel.isActive) return false;
      if (status === "archived" && channel.isActive) return false;
      if (type !== "all" && channel.channelType !== type) return false;
      if (favoritesOnly && !channel.isFavorite) return false;
      if (useFilter === "used" && stats.total === 0) return false;
      if (useFilter === "unused" && stats.total !== 0) return false;
      if (useFilter === "attention" && stats.overdueCount + stats.soonCount === 0) return false;
      return !search || [channel.name, channel.provider, channel.identifier, channel.note, channelTypeLabel(channel.channelType)]
        .some(value => value.toLowerCase().includes(search));
    }).sort((a, b) => Number(b.isActive) - Number(a.isActive) || Number(b.isFavorite) - Number(a.isFavorite) || a.id - b.id);
  }, [channels, usage, query, status, type, useFilter, favoritesOnly]);
  const hasFilters = query.trim() || type !== "all" || useFilter !== "all" || favoritesOnly || status !== "active";
  const detail = channels.find(channel => channel.id === detailId);
  const detailUsage = detail ? usage[detail.id] ?? EMPTY_USAGE : EMPTY_USAGE;

  function mutate(action: () => Promise<ChannelActionResult>, message: string) {
    startTransition(async () => {
      try {
        const result = await action();
        if (!result.ok) { toast.error(result.error); return; }
        toast.success(message);
        router.refresh();
      } catch { toast.error("操作失败，请重试。"); }
    });
  }
  function clearFilters() {
    setQuery(""); setType("all"); setUseFilter("all"); setFavoritesOnly(false); setStatus("active");
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-6 px-4 py-7 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">支付渠道</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">区分每张卡和每个平台，查看关联订阅，提前准备续费。</p>
        </div>
        <Button onClick={() => setDialog({ mode: "add" })}><Plus className="size-4" />新增渠道</Button>
      </header>

      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "可用渠道", value: activeCount, hint: (channels.length - activeCount) + " 个已归档" },
          { label: "常用渠道", value: favoriteCount, hint: "在订阅选择框中优先显示" },
          { label: "关联订阅", value: subscriptionCount, hint: "包含 Business 与独立账号" },
          { label: "需要关注的订阅", value: attentionCount, hint: "已过期或 " + soonDays + " 天内到期" },
        ].map(item => (
          <div key={item.label} className="rounded-lg border bg-card px-5 py-4">
            <dt className="text-sm text-muted-foreground">{item.label}</dt>
            <dd className="mt-2 font-mono text-3xl font-semibold tabular-nums">{item.value}</dd>
            <p className="mt-1 text-xs text-muted-foreground">{item.hint}</p>
          </div>
        ))}
      </dl>

      <section aria-label="渠道筛选" className="space-y-4 rounded-lg border bg-muted/20 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1" aria-label="渠道状态">
            {([{ value: "active", label: "可用", count: activeCount },
              { value: "archived", label: "已归档", count: channels.length - activeCount },
              { value: "all", label: "全部", count: channels.length }] as const).map(item => (
              <Button key={item.value} size="sm" variant={status === item.value ? "default" : "ghost"}
                aria-pressed={status === item.value} onClick={() => setStatus(item.value)}>
                {item.label}<span className="ml-1 font-mono text-xs opacity-75">{item.count}</span>
              </Button>
            ))}
          </div>
          <Button size="sm" variant={favoritesOnly ? "secondary" : "ghost"} aria-pressed={favoritesOnly}
            onClick={() => setFavoritesOnly(value => !value)}>
            <Star className={cn("size-4", favoritesOnly && "fill-current")} />只看常用
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-52 flex-1">
            <Search aria-hidden="true" className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="搜索渠道" type="search" value={query} onChange={e => setQuery(e.target.value)}
              className="pl-9" placeholder="搜索名称、平台、尾号或备注" />
          </div>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="w-44" aria-label="渠道类型"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">全部渠道类型</SelectItem>
              {CHANNEL_TYPE_OPTIONS.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={useFilter} onValueChange={setUseFilter}>
            <SelectTrigger className="w-40" aria-label="使用情况"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">全部使用情况</SelectItem>
              <SelectItem value="used">有关联订阅</SelectItem><SelectItem value="unused">暂未使用</SelectItem>
              <SelectItem value="attention">有订阅需关注</SelectItem>
            </SelectContent>
          </Select>
          {hasFilters ? <Button variant="ghost" size="sm" onClick={clearFilters}>重置筛选</Button> : null}
        </div>
      </section>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <p>显示 {visible.length} 个渠道 · 常用优先</p>
        <p>成本为关联订阅当前周期的合计</p>
      </div>
      {visible.length ? (
        <div className="overflow-x-auto rounded-md border">
          <Table className="min-w-[880px]">
            <TableHeader><TableRow>
              <TableHead>支付渠道</TableHead><TableHead>手续费</TableHead>
              <TableHead>关联订阅</TableHead><TableHead>当前周期成本</TableHead>
              <TableHead>到期情况</TableHead><TableHead className="text-right">操作</TableHead>
            </TableRow></TableHeader>
            <TableBody>{visible.map(channel => {
              const stats = usage[channel.id] ?? EMPTY_USAGE;
              return <TableRow key={channel.id} className={cn(!channel.isActive && "bg-muted/30")}>
                <TableCell className="max-w-xs">
                  <div className="flex items-center gap-2"><span className="font-medium">{channel.name}</span>
                    {!channel.isActive && <Badge variant="secondary">已归档</Badge>}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground" title={channel.note}>
                    {[channelTypeLabel(channel.channelType), channel.provider, channel.identifier, channel.note].filter(Boolean).join(" · ")}
                  </p>
                </TableCell>
                <TableCell className="font-mono">{channel.feePercent}%</TableCell>
                <TableCell><p className="font-mono">{stats.total} 个</p>
                  <p className="text-[11px] text-muted-foreground">Business {stats.teamCount} · 其他 {stats.independentCount}</p>
                </TableCell>
                <TableCell><MoneyDisplay compact value={stats.costUsdMinor} cnyRate={cnyRate} className="font-medium" />
                  {stats.missingCostCount > 0 && <p className="text-[11px] text-muted-foreground">{stats.missingCostCount} 笔待换算</p>}
                </TableCell>
                <TableCell><p className="font-mono text-xs">{stats.nextExpiryDate ?? "—"}</p>
                  <div className="mt-1 flex gap-1">
                    {stats.overdueCount > 0 && <Badge variant="destructive">{stats.overdueCount} 个已过期</Badge>}
                    {stats.soonCount > 0 && <Badge variant="outline">{stats.soonCount} 个近期到期</Badge>}
                  </div>
                </TableCell>
                <TableCell><div className="flex justify-end gap-1">
                  {channel.isActive && <Button size="icon" variant="ghost" className="size-8" disabled={pending}
                    aria-label={(channel.isFavorite ? "取消常用 " : "设为常用 ") + channel.name}
                    aria-pressed={channel.isFavorite}
                    onClick={() => mutate(() => setChannelFavorite(channel.id, !channel.isFavorite), channel.isFavorite ? "已取消常用" : "已设为常用")}>
                    <Star className={cn("size-4", channel.isFavorite && "fill-amber-400 text-amber-500")} />
                  </Button>}
                  <Button size="sm" variant="ghost" onClick={() => setDetailId(channel.id)}>查看关联</Button>
                  <Button size="sm" variant="ghost" onClick={() => setDialog({ mode: "edit", channel })}><Pencil className="size-3.5" />编辑</Button>
                  {channel.isActive
                    ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => setArchiveTarget(channel)}><Archive className="size-3.5" />归档</Button>
                    : <Button size="sm" variant="ghost" disabled={pending} onClick={() => mutate(() => reactivateChannel(channel.id), "已恢复渠道")}><RotateCcw className="size-3.5" />恢复</Button>}
                </div></TableCell>
              </TableRow>;
            })}</TableBody>
          </Table>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-muted/20 px-6 py-14 text-center">
          <Wallet aria-hidden="true" className="size-8 text-muted-foreground" />
          <h2 className="font-semibold">{channels.length ? "没有符合条件的渠道" : "添加第一个支付渠道"}</h2>
          <p className="text-sm text-muted-foreground">{channels.length ? "试试搜索其他平台、尾号，或重置筛选。" : "先记录你常用的银行卡、钱包或购买平台，再为订阅选择支付方式。"}</p>
          {channels.length ? <Button variant="outline" onClick={clearFilters}>重置筛选</Button> : <Button onClick={() => setDialog({ mode: "add" })}>新增渠道</Button>}
        </div>
      )}

      <ChannelDialog open={!!dialog} mode={dialog?.mode ?? "add"} channel={dialog?.channel}
        onOpenChange={open => { if (!open) setDialog(null); }} />
      <ArchiveDialog channel={archiveTarget} linkedCount={archiveTarget ? usage[archiveTarget.id]?.total ?? 0 : 0}
        onOpenChange={open => { if (!open) setArchiveTarget(null); }} />
      <Dialog open={!!detail} onOpenChange={open => { if (!open) setDetailId(null); }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader><DialogTitle>{detail?.name} · 关联订阅</DialogTitle>
            <DialogDescription>共 {detailUsage.total} 个订阅，当前周期成本合计 {dualMoneyText(detailUsage.costUsdMinor, cnyRate)}。点击名称可查看或维护订阅。</DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="space-y-4">
              <div className="rounded-md bg-muted/40 p-3 text-sm">
                <p>{channelTypeLabel(detail.channelType)}{detail.provider ? " · " + detail.provider : ""}{detail.identifier ? " · " + detail.identifier : ""}</p>
                {detail.note && <p className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">{detail.note}</p>}
                {!detail.isActive && <p className="mt-2 text-xs text-muted-foreground">此渠道已归档，已有订阅仍保留关联。</p>}
              </div>
              {detailUsage.total ? <div className="max-h-[45vh] overflow-auto">
                <Table><TableHeader><TableRow><TableHead>订阅</TableHead><TableHead>类型</TableHead>
                  <TableHead>到期日</TableHead><TableHead>状态</TableHead><TableHead className="text-right">成本 · 人民币 / 美元</TableHead></TableRow></TableHeader>
                  <TableBody>{detailUsage.subscriptions.map(subscription => <TableRow key={subscription.id}>
                    <TableCell><Link className="font-medium underline-offset-4 hover:underline" href={"/spaces/" + subscription.id}>{subscription.name}</Link></TableCell>
                    <TableCell>{spacePlanLabel(subscription.planType, subscription.customPlanName)}</TableCell>
                    <TableCell className="font-mono">{subscription.expiryDate ?? "—"}</TableCell>
                    <TableCell><ExpiryBadge expiryDate={subscription.expiryDate} soonDays={soonDays} /></TableCell>
                    <TableCell className="text-right"><MoneyDisplay value={subscription.amountUsd} cnyRate={cnyRate} className="items-end" /></TableCell>
                  </TableRow>)}</TableBody>
                </Table>
              </div> : <p className="py-6 text-center text-sm text-muted-foreground">暂无关联订阅。创建订阅时可选择此渠道。</p>}
              <div className="flex justify-end"><Button asChild variant="outline">
                <Link href={"/spaces?channel=" + detail.id}>打开订阅列表<ArrowUpRight className="size-4" /></Link>
              </Button></div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
