import { redirect } from "next/navigation";
import { hasAdminSession } from "@/lib/action-auth";
import { db } from "@/db";
import { listSpaceDetails } from "@/db/spaces";
import { getStatusThresholds } from "@/db/settings";
import { getOperationsContext } from "@/lib/operations/http";
import { shanghaiToday } from "@/lib/workspace/view-model";
import { RenewalCalendar } from "@/components/dashboard/renewal-calendar";

export const dynamic = "force-dynamic";
export default async function CalendarPage() {
  if (!(await hasAdminSession())) redirect("/login");
  const { store } = await getOperationsContext();
  return <RenewalCalendar initialSnapshot={store.snapshot()} initialQuotes={store.quotes()}
    classicSpaceIds={listSpaceDetails(db).map(row => row.space.id)} initialToday={shanghaiToday()}
    soonDays={getStatusThresholds(db).spaceSoonDays} />;
}
