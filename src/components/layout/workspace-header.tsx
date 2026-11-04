"use client";

import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { AutomaticFxRefresh } from "@/components/fx/automatic-refresh";

type Heading = { id: string; pathname: string; title: string; actions?: ReactNode };
type HeaderContext = {
  heading: Heading | null;
  register: (heading: Heading) => void;
  unregister: (id: string) => void;
};
const Context = createContext<HeaderContext | null>(null);

export function WorkspaceHeaderProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [heading, setHeading] = useState<Heading | null>(null);
  const register = useCallback((next: Heading) => setHeading(current =>
    current?.id === next.id && current.pathname === next.pathname && current.title === next.title && current.actions === next.actions ? current : next), []);
  const unregister = useCallback((id: string) => setHeading(current => current?.id === id ? null : current), []);
  const value = useMemo(() => ({ heading: heading?.pathname === pathname ? heading : null, register, unregister }), [heading, pathname, register, unregister]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

function locationLabel(pathname: string) {
  if (pathname.startsWith("/spaces/")) return "订阅 / 账号详情";
  const labels: Record<string, string> = { "/": "续费日历", "/spaces": "订阅", "/customers": "客户", "/settings": "设置", "/reference-data/channels": "支付渠道", "/reference-data/currencies": "币种", "/reference-data/rates": "汇率" };
  return labels[pathname] ?? "工作区";
}

export function WorkspaceHeader() {
  const context = useContext(Context);
  const pathname = usePathname();
  const heading = context?.heading;
  return <header data-workspace-header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b bg-card px-4 sm:px-6 lg:px-8">
    <SidebarTrigger aria-label="切换侧边栏" />
    <div className="h-4 w-px bg-border" aria-hidden="true" />
    {heading ? <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight" title={heading.title}>{heading.title}</h1>
      : <span className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">{locationLabel(pathname)}</span>}
    {heading?.actions && <div data-workspace-actions className="flex shrink-0 items-center gap-2">{heading.actions}</div>}
    <AutomaticFxRefresh />
  </header>;
}

/** Keeps the server-rendered heading available until the shared header attaches. */
export function WorkspacePageHeading({ title, actions }: { title: string; actions?: ReactNode }) {
  const context = useContext(Context);
  const id = useId();
  const pathname = usePathname();
  const register = context?.register;
  const unregister = context?.unregister;
  useLayoutEffect(() => {
    if (!register || !unregister) return;
    register({ id, pathname, title, actions });
    return () => unregister(id);
  }, [id, pathname, title, actions, register, unregister]);
  if (context?.heading?.id === id) return null;
  return <div className="mb-4 flex items-center justify-between gap-4"><h1 className="text-xl font-semibold tracking-tight">{title}</h1>{actions}</div>;
}
