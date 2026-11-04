"use client";

// Modified for 订阅管家: product branding and subscription navigation label.

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Boxes,
  CreditCard,
  Coins,
  Banknote,
  Settings,
  LogOut,
  Layers3,
  CalendarDays,
  Users,
} from "lucide-react";

import { logout } from "@/actions/auth";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

const topLevel = [
  { label: "续费日历", href: "/", icon: CalendarDays },
  { label: "订阅", href: "/spaces", icon: Boxes },
  { label: "客户", href: "/customers", icon: Users },
  { label: "设置", href: "/settings", icon: Settings },
] as const;

const referenceChildren = [
  { label: "支付渠道", href: "/reference-data/channels", icon: CreditCard },
  { label: "币种", href: "/reference-data/currencies", icon: Coins },
  { label: "汇率", href: "/reference-data/rates", icon: Banknote },
] as const;

const activeClasses =
  "relative before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-primary before:opacity-0 data-[active=true]:before:opacity-100 data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground data-[active=true]:font-semibold";

export function AppSidebar() {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();

  return (
    <Sidebar collapsible="icon" className="border-r">
      <SidebarHeader className="h-14 justify-center border-b px-3">
        <div className="flex items-center gap-2.5 overflow-hidden">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Layers3 aria-hidden="true" className="size-4" />
          </div>
          <div className="min-w-0 group-data-[collapsible=icon]:hidden">
            <p className="truncate text-sm font-semibold">订阅管家</p>
            <p className="truncate text-xs text-muted-foreground">订阅与收款管理</p>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent role="navigation" aria-label="主导航">
        <SidebarGroup>
          <SidebarGroupLabel>工作区</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {topLevel.map((item) => {
                const Icon = item.icon;
                const isActive = pathname === item.href || (item.href === "/spaces" && pathname.startsWith("/spaces/"));
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={item.label}
                      className={activeClasses}
                    >
                      <Link
                        href={item.href}
                        aria-label={item.label}
                        aria-current={isActive ? "page" : undefined}
                        onClick={() => setOpenMobile(false)}
                      >
                        <Icon aria-hidden="true" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}

            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>基础数据</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
                  {referenceChildren.map((child) => {
                    const Icon = child.icon;
                    const isActive = pathname === child.href;
                    return (
                      <SidebarMenuItem key={child.href}>
                        <SidebarMenuButton
                          asChild
                          isActive={isActive}
                          tooltip={child.label}
                          className={activeClasses}
                        >
                          <Link
                            href={child.href}
                            aria-label={child.label}
                            aria-current={isActive ? "page" : undefined}
                            onClick={() => setOpenMobile(false)}
                          >
                            <Icon aria-hidden="true" />
                            <span>{child.label}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t p-2">
        <form action={logout}>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton type="submit" tooltip="退出登录">
                <LogOut aria-hidden="true" />
                <span>退出登录</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </form>
      </SidebarFooter>
    </Sidebar>
  );
}
