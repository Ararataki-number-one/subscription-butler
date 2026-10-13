// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
// Modified for 订阅管家: mobile product header.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppSidebar } from "@/components/nav/sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { AutomaticFxRefresh } from "@/components/fx/automatic-refresh";
import { startFxRefreshScheduler } from "@/lib/fx/scheduler";

export default async function ProtectedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const authenticated = await verifySessionToken(
    cookieStore.get(AUTH_COOKIE_NAME)?.value,
  );

  if (!authenticated) redirect("/login");
  startFxRefreshScheduler();

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/92 px-4 backdrop-blur-lg">
          <SidebarTrigger aria-label="切换侧边栏" />
          <div className="h-4 w-px bg-border" aria-hidden="true" />
          <span className="text-sm font-medium text-muted-foreground md:hidden">
            订阅管家
          </span>
          <AutomaticFxRefresh />
        </header>
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
