// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
import { db } from "@/db";
import { getChannelUsage, listChannels } from "@/db/channels";
import { getStatusThresholds } from "@/db/settings";
import { getCnyDisplayRate } from "@/db/fxRates";
import { ChannelTable } from "@/components/channels/channel-table";

// better-sqlite3 is a native module — keep this RSC on the Node runtime.
export const dynamic = "force-dynamic";

export default async function ChannelsPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  const { archived } = await searchParams;
  const showArchived = archived === "1";

  // Fetch all rows once so the client-side name/status filters can switch
  // instantly while the archived URL param still controls the initial view.
  const channels = listChannels(db, true);
  const { spaceSoonDays } = getStatusThresholds(db);
  const usage = getChannelUsage(db, new Date(), spaceSoonDays);

  return (
    <ChannelTable
      channels={channels}
      showArchived={showArchived}
      usage={usage}
      soonDays={spaceSoonDays}
      cnyRate={getCnyDisplayRate(db)}
    />
  );
}
