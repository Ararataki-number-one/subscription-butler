import { cnyText, usdText, type CnyDisplayRate } from "@/lib/money-display";
import { cn } from "@/lib/utils";

export function MoneyDisplay({ value, cnyRate, compact = false, className }: {
  value: number | null; cnyRate?: CnyDisplayRate | null; compact?: boolean; className?: string;
}) {
  const primary = value === null ? "待计算" : cnyText(value, cnyRate ?? null) ?? "人民币待换算";
  const usd = usdText(value);
  return <span className={cn(compact ? "inline-flex items-baseline gap-x-1.5" : "inline-flex flex-col gap-1", className)}>
    <span className="font-mono tabular-nums">{primary}</span>
    {usd && <span className="font-mono text-[11px] font-normal leading-normal text-muted-foreground">{compact ? "(" + usd + ")" : usd + " USD"}</span>}
  </span>;
}
