// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
"use client";

import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type FrozenAmountHelpProps = {
  className?: string;
};

export function FrozenAmountHelp({ className }: FrozenAmountHelpProps) {
  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={className}
              aria-label="查看金额折算说明"
            >
              <Info className="size-3.5" />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>查看说明</TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>金额折算说明</DialogTitle>
          <DialogDescription>
            当前成本和预计收益会随汇率更新重新计算。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            系统每 5 分钟联网检查汇率，将订阅金额与手续费折算为当前成本。
          </p>
          <p>
            母号和拼车成员的约定收入也会重新折算，原币收费和付款日期保持原值。
          </p>
          <p>
            已登记的实际收款保留原有记录，不随预计收益重新折算。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
