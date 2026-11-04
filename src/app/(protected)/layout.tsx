// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
// Modified for 订阅管家: mobile product header.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppSidebar } from "@/components/nav/sidebar";
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { WorkspaceHeader, WorkspaceHeaderProvider } from "@/components/layout/workspace-header";
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
        <WorkspaceHeaderProvider>
        <WorkspaceHeader />
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
        </WorkspaceHeaderProvider>
      </SidebarInset>
    </SidebarProvider>
  );
}
