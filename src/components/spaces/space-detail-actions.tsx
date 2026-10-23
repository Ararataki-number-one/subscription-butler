// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RefreshCcw, Pencil, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { renewSpace } from "@/actions/spaces";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SpaceDeleteDialog } from "./space-delete-dialog";
import type { SpaceFormValue } from "./space-form";
import { addPeriod } from "@/lib/expiry";

type SpaceDetailActionsProps = {
  space: SpaceFormValue;
  expiryDate?: string | null;
  childCount: number;
  isEditing?: boolean;
  editFormId?: string;
  renewalCost: string;
};

export function SpaceDetailActions({
  space,
  expiryDate,
  childCount,
  isEditing = false,
  editFormId,
  renewalCost,
}: SpaceDetailActionsProps) {
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renewOpen, setRenewOpen] = useState(false);
  const [isRenewing, startRenewTransition] = useTransition();
  const renewalBase = expiryDate || space.currentPeriodStartDate || space.openingDate;
  const nextExpiry = renewalBase ? addPeriod(renewalBase, { unit: space.periodUnit ?? "month", count: space.periodCount ?? 1 }) : "—";

  function onRenew() {
    if (!space.id) return;

    startRenewTransition(async () => {
      try {
        const res = await renewSpace(space.id!, expiryDate ?? undefined);
        if (res.ok) {
          toast.success("已续费并更新到期日");
          setRenewOpen(false);
          router.refresh();
        } else {
          toast.error(res.error);
        }
      } catch {
        toast.error("续费失败，请重试。");
      }
    });
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            onClick={() => setRenewOpen(true)}
            disabled={isRenewing || isEditing || !space.id}
          >
            <RefreshCcw className="size-4" />
            {isRenewing ? "续费中" : "续费"}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {isEditing ? "编辑时暂不可续费" : "按当前周期推进到期日"}
        </TooltipContent>
      </Tooltip>
      <AlertDialog open={renewOpen} onOpenChange={setRenewOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认续费空间</AlertDialogTitle>
            <AlertDialogDescription>
              按原周期延长到期日，并保留本期续费记录。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 border-y py-4 text-sm">
            <dt className="text-muted-foreground">续费对象</dt><dd className="min-w-0 break-words font-medium">{space.name}</dd>
            <dt className="text-muted-foreground">当前到期日</dt><dd className="font-mono">{expiryDate || "—"}</dd>
            <dt className="text-muted-foreground">续费后到期日</dt><dd className="font-mono font-semibold text-primary">{nextExpiry}</dd>
            <dt className="text-muted-foreground">含手续费成本</dt><dd className="font-mono">{renewalCost}</dd>
          </dl>
          <p className="text-xs text-muted-foreground">人民币与美元金额按确认时的汇率折算。</p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRenewing}>取消</AlertDialogCancel>
            <Button onClick={onRenew} disabled={isRenewing || !space.id}>
              {isRenewing ? "续费中..." : "确认续费"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {isEditing ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="submit" form={editFormId}>
              保存
            </Button>
          </TooltipTrigger>
          <TooltipContent>保存空间修改</TooltipContent>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          {isEditing ? (
            <Button asChild variant="outline">
              <Link href={`/spaces/${space.id}`}>
                <X className="size-4" />
                取消编辑
              </Link>
            </Button>
          ) : (
            <Button asChild variant="outline">
              <Link href={`/spaces/${space.id}?edit=1`}>
                <Pencil className="size-4" />
                编辑
              </Link>
            </Button>
          )}
        </TooltipTrigger>
        <TooltipContent>
          {isEditing ? "返回只读详情" : "在页面内编辑空间"}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="destructive"
            size="icon"
            className="size-8"
            aria-label={`删除 ${space.name}`}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>删除空间</TooltipContent>
      </Tooltip>
      {space.id ? (
        <SpaceDeleteDialog
          open={deleteOpen}
          space={{ id: space.id, name: space.name }}
          childCount={childCount}
          onOpenChange={setDeleteOpen}
        />
      ) : null}
    </>
  );
}
