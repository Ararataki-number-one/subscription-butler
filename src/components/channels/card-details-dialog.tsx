"use client";

import { useEffect, useState } from "react";
import { Copy, Eye, EyeOff, LockKeyhole, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { EMPTY_CARD, type CardDetails } from "@/lib/card-details";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const FIELDS: { key: keyof CardDetails; label: string; placeholder?: string; mode?: "numeric"; wide?: boolean }[] = [
  { key: "cardNumber", label: "完整卡号", placeholder: "支持空格分组", mode: "numeric", wide: true },
  { key: "expiryMonth", label: "到期月份", placeholder: "MM，例如 08", mode: "numeric" },
  { key: "expiryYear", label: "到期年份", placeholder: "YYYY，例如 2028", mode: "numeric" },
  { key: "cvc", label: "CVC / CVV", placeholder: "3 或 4 位数字", mode: "numeric" },
  { key: "cardholder", label: "持卡人姓名" },
  { key: "country", label: "账单国家 / 地区" },
  { key: "postalCode", label: "账单邮编" },
  { key: "billingAddress", label: "账单地址", wide: true },
  { key: "note", label: "卡片私密备注", wide: true },
];
export function CardDetailsDialog({ channel, onClose, onChanged }: {
  channel: { id: number; name: string }; onClose: () => void; onChanged: () => void;
}) {
  const [details, setDetails] = useState<CardDetails>({ ...EMPTY_CARD });
  const [revision, setRevision] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  useEffect(() => {
    let cancelled = false;
    const api = window.teamAccountManagerDesktop?.cardVault;
    const read = api ? api.get(channel.id) : Promise.reject(new Error("卡片敏感资料仅支持在订阅管家桌面版中管理。"));
    void read.then(row => {
      if (cancelled) return;
      setDetails(row?.details ?? { ...EMPTY_CARD }); setRevision(row?.revision ?? null); setUpdatedAt(row?.updatedAt ?? "");
    }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "读取卡片资料失败。"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [channel.id]);
  useEffect(() => {
    const hide = () => setRevealed(false);
    window.addEventListener("blur", hide); document.addEventListener("visibilitychange", hide);
    const timer = revealed ? window.setTimeout(hide, 30000) : undefined;
    return () => { window.removeEventListener("blur", hide); document.removeEventListener("visibilitychange", hide); clearTimeout(timer); };
  }, [revealed]);
  async function save() {
    setPending(true); setError("");
    try {
      const api = window.teamAccountManagerDesktop!.cardVault;
      await api.save(channel.id, details, revision);
      const row = await api.get(channel.id);
      setDetails(row?.details ?? { ...EMPTY_CARD }); setRevision(row?.revision ?? null); setUpdatedAt(row?.updatedAt ?? ""); setDirty(false); setRevealed(false);
      onChanged(); toast.success("卡片资料已加密保存");
    } catch (e) { setError(e instanceof Error ? e.message : "保存未完成。"); }
    finally { setPending(false); }
  }
  async function remove() {
    if (!revision) return;
    setPending(true); setError("");
    try {
      await window.teamAccountManagerDesktop!.cardVault.remove(channel.id, revision);
      setDetails({ ...EMPTY_CARD }); setRevision(null); setUpdatedAt(""); setConfirmDelete(false); setDirty(false); setRevealed(false);
      onChanged(); toast.success("已删除卡片资料");
    } catch (e) { setError(e instanceof Error ? e.message : "删除未完成。"); }
    finally { setPending(false); }
  }
  async function copy(field: keyof CardDetails) {
    try { await window.teamAccountManagerDesktop!.cardVault.copy(channel.id, field); toast.success("已复制，30 秒后自动清除未被替换的剪贴板内容"); }
    catch { toast.error("复制失败，请重试。"); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }}>
    <DialogContent className="sm:max-w-2xl" onInteractOutside={event => { if (dirty || pending) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>{channel.name} · 卡片资料</DialogTitle>
        <DialogDescription>Windows 本机加密保存，包含在本机加密备份中。默认隐藏；显示 30 秒后或切换窗口时自动隐藏。</DialogDescription>
      </DialogHeader>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><LockKeyhole className="size-3.5" />{revision ? "已加密保存" : "尚未保存卡片资料"}{dirty ? " · 有未保存修改" : ""}</span>
        <Button type="button" size="sm" variant="outline" disabled={loading || pending} onClick={() => setRevealed(value => !value)}>
          {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}{revealed ? "隐藏资料" : "显示资料"}
        </Button>
      </div>
      <form autoComplete="off" onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset disabled={loading || pending || !!error && !window.teamAccountManagerDesktop?.cardVault} className="grid gap-3 sm:grid-cols-2">
          {FIELDS.map(field => <div key={field.key} className={field.wide ? "sm:col-span-2" : ""}>
            <label htmlFor={`card-${field.key}`} className="mb-1.5 block text-sm font-medium">{field.label}</label>
            <div className="flex gap-1.5">
              <Input id={`card-${field.key}`} name={field.key} type={revealed ? "text" : "password"} autoComplete="off" spellCheck={false}
                inputMode={field.mode} maxLength={field.key === "billingAddress" || field.key === "note" ? 2000 : 200}
                placeholder={loading ? "读取中…" : field.placeholder ?? "可选"} value={details[field.key]}
                onChange={event => { setDetails(current => ({ ...current, [field.key]: event.target.value })); setDirty(true); setConfirmDelete(false); }} />
              <Button type="button" variant="outline" size="icon" aria-label={`复制${field.label}`} title={dirty ? "保存修改后再复制" : `复制${field.label}`}
                disabled={!revision || dirty || !details[field.key]} onClick={() => void copy(field.key)}><Copy className="size-4" /></Button>
            </div>
          </div>)}
        </fieldset>
        {error && <p role="alert" className="mt-3 break-words text-sm text-destructive">{error}</p>}
        {updatedAt && <p className="mt-3 text-xs text-muted-foreground">最近保存：{new Date(updatedAt).toLocaleString("zh-CN")}</p>}
        {confirmDelete && <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 p-3 text-sm">
          <p>确认删除此渠道的全部卡片资料？</p><div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>保留</Button>
            <Button type="button" size="sm" variant="destructive" disabled={pending} onClick={() => void remove()}>确认删除卡片资料</Button>
          </div>
        </div>}
        <DialogFooter className="mt-5">
          {revision && <Button type="button" variant="ghost" className="text-destructive sm:mr-auto" disabled={pending} onClick={() => setConfirmDelete(true)}><Trash2 className="size-4" />删除卡片资料</Button>}
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>关闭</Button>
          <Button type="submit" disabled={loading || pending || !dirty}>{pending ? "保存中…" : "加密保存"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
