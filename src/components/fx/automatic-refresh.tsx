"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { refreshAutomaticRates } from "@/actions/fx";
import { FX_REFRESH_INTERVAL_MS } from "@/lib/fx/constants";

export function AutomaticFxRefresh() {
  const router = useRouter();
  const running = useRef(false);
  const lastAttempt = useRef(0);
  const alive = useRef(true);
  const [status, setStatus] = useState<{ fetchedAt: string | null; failed: boolean } | null>(null);
  const refresh = useCallback(async () => {
    if (running.current || Date.now() - lastAttempt.current < FX_REFRESH_INTERVAL_MS) return;
    running.current = true; lastAttempt.current = Date.now();
    try {
      const result = await refreshAutomaticRates();
      if (!alive.current) return;
      setStatus({ fetchedAt: result.ok ? result.fetchedAt : null,
        failed: !result.ok || result.stale || !result.fetchedAt });
      const active = document.activeElement;
      const editing = active instanceof HTMLElement && active.matches("input,textarea,select,[contenteditable=true]")
        || document.querySelector('[role="dialog"][data-state="open"]');
      if (!editing) router.refresh();
    } catch {
      if (alive.current) setStatus(value => ({ fetchedAt: value?.fetchedAt ?? null, failed: true }));
    } finally { running.current = false; }
  }, [router]);

  useEffect(() => {
    alive.current = true;
    const initial = window.setTimeout(() => { void refresh(); }, 0);
    const timer = window.setInterval(() => { void refresh(); }, FX_REFRESH_INTERVAL_MS);
    const onResume = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("online", onResume);
    return () => {
      alive.current = false; window.clearTimeout(initial); window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("online", onResume);
    };
  }, [refresh]);
  const time = status?.fetchedAt
    ? new Date(status.fetchedAt).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })
    : null;
  return <span className="ml-auto text-[11px] text-muted-foreground" role="status">
    汇率每 5 分钟更新{status?.failed ? " · 更新失败，保留上次数据" : time ? " · 最近检查 " + time : ""}
  </span>;
}
