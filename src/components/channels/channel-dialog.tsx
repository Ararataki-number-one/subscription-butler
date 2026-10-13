// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { channelSchema, type ChannelInput } from "@/lib/validation/channel";
import { CHANNEL_TYPE_OPTIONS } from "@/lib/payment-channels";
import { addChannel, updateChannel } from "@/actions/channels";
import type { ChannelRow } from "@/db/channels";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";

type Props = {
  open: boolean;
  mode: "add" | "edit";
  channel?: ChannelRow;
  onOpenChange: (open: boolean) => void;
};

export function ChannelDialog({ open, mode, channel, onOpenChange }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const form = useForm<ChannelInput>({
    resolver: zodResolver(channelSchema),
    defaultValues: { name: "", channelType: "other", provider: "", identifier: "", note: "", isFavorite: false, feePercent: "0" },
  });
  useEffect(() => {
    if (!open) return;
    form.reset({
      name: channel?.name ?? "", channelType: channel?.channelType ?? "other",
      provider: channel?.provider ?? "", identifier: channel?.identifier ?? "",
      note: channel?.note ?? "", isFavorite: channel?.isFavorite ?? false,
      feePercent: channel?.feePercent ?? "0",
    });
  }, [open, channel, form]);

  function save(values: ChannelInput) {
    startTransition(async () => {
      try {
        const result = mode === "add" ? await addChannel(values) : await updateChannel(channel!.id, values);
        if (!result.ok) { form.setError("root", { message: result.error }); return; }
        toast.success(mode === "add" ? "已添加渠道" : "渠道资料已更新");
        onOpenChange(false);
        router.refresh();
      } catch { toast.error("保存失败，请重试。"); }
    });
  }

  return (
    <Dialog open={open} onOpenChange={value => { if (!pending) onOpenChange(value); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "新增支付渠道" : "编辑支付渠道"}</DialogTitle>
          <DialogDescription>手续费修改后会重算关联订阅成本；汇率每 5 分钟更新，成本和预计收益随之重算。</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(save)} className="space-y-5">
            <fieldset disabled={pending} className="grid gap-4 sm:grid-cols-2">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>渠道名称</FormLabel>
                  <FormControl><Input autoFocus maxLength={80} placeholder="例如：roogoo 主力卡" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="channelType" render={({ field }) => (
                <FormItem><FormLabel>渠道类型</FormLabel>
                  <Select value={field.value ?? "other"} onValueChange={field.onChange}>
                    <FormControl><SelectTrigger className="w-full"><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>{CHANNEL_TYPE_OPTIONS.map(option =>
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                  </Select><FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="provider" render={({ field }) => (
                <FormItem><FormLabel>机构 / 平台（可选）</FormLabel>
                  <FormControl><Input {...field} value={field.value ?? ""} maxLength={80} placeholder="例如：roogoo、Bybit、银行名称" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="identifier" render={({ field }) => (
                <FormItem><FormLabel>尾号 / 辨认标记（可选）</FormLabel>
                  <FormControl><Input {...field} value={field.value ?? ""} maxLength={80} placeholder="例如：尾号 1234、工作专用" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="note" render={({ field }) => (
                <FormItem className="sm:col-span-2"><FormLabel>备注（可选）</FormLabel>
                  <FormControl><textarea {...field} value={field.value ?? ""} rows={3} maxLength={1000}
                    placeholder="例如：适用地区、充值方式、续费前需检查余额"
                    className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="feePercent" render={({ field }) => (
                <FormItem className="sm:col-span-2"><FormLabel>手续费（%）</FormLabel>
                  <FormControl><Input {...field} value={field.value ?? "0"} inputMode="decimal" placeholder="例如：2.5" /></FormControl>
                  <p className="text-xs text-muted-foreground">填写 0–100，最多两位小数；0 表示没有手续费。</p>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="isFavorite" render={({ field }) => (
                <FormItem className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 p-3 sm:col-span-2">
                  <div><FormLabel>设为常用渠道</FormLabel>
                    <p className="mt-1 text-xs text-muted-foreground">在渠道列表和订阅选择框中优先显示。</p></div>
                  <FormControl><Switch checked={field.value ?? false} onCheckedChange={field.onChange} disabled={pending} /></FormControl>
                </FormItem>
              )} />
            </fieldset>
            {form.formState.errors.root && <p role="alert" className="text-sm text-destructive">{form.formState.errors.root.message}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>取消</Button>
              <Button type="submit" disabled={pending}>{pending ? "保存中…" : "保存渠道"}</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
