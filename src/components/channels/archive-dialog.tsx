// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { archiveChannel } from "@/actions/channels";
import type { ChannelRow } from "@/db/channels";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

type ArchiveDialogProps = {
  /** The channel pending archive, or null when the dialog is closed. */
  channel: Pick<ChannelRow, "id" | "name"> | null;
  linkedCount?: number;
  onOpenChange: (open: boolean) => void;
};

export function ArchiveDialog({ channel, linkedCount = 0, onOpenChange }: ArchiveDialogProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onConfirm() {
    if (!channel) return;
    startTransition(async () => {
      try {
        const res = await archiveChannel(channel.id);
        if (res.ok) {
          toast.success("已归档渠道");
          onOpenChange(false);
          router.refresh();
        } else {
          toast.error(res.error);
        }
      } catch {
        toast.error("保存失败，请重试。");
      }
    });
  }

  return (
    <AlertDialog open={channel !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>归档此渠道?</AlertDialogTitle>
          <AlertDialogDescription>
            当前关联 {linkedCount} 个订阅。归档后不能用于新建订阅，已有记录仍保留关联并可继续编辑。你可以随时恢复渠道。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>取消</AlertDialogCancel>
          {/* Reversible soft-delete (D-06) → NEUTRAL confirm, not destructive/red. */}
          <Button variant="secondary" onClick={onConfirm} disabled={isPending}>
            {isPending ? "归档中…" : "归档"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
