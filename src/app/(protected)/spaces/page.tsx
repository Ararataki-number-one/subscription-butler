// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
import { db } from "@/db";
import { listChannels } from "@/db/channels";
import { listCurrencies } from "@/db/currencies";
import { getCnyDisplayRate } from "@/db/fxRates";
import { getStatusThresholds } from "@/db/settings";
import { listSpaceDetails } from "@/db/spaces";
import { SpaceTable } from "@/components/spaces/space-table";
import { SPACE_PLAN_TYPES } from "@/lib/space-plans";
import { getAccountEarnings } from "@/db/teamEarnings";
import { parseChannelFilter } from "@/lib/space-filters";

// better-sqlite3 is a native module — keep this RSC on the Node runtime.
export const dynamic = "force-dynamic";

export default async function SpacesPage({
  searchParams,
}: {
  searchParams: Promise<{ country?: string; channel?: string; plan?: string }>;
}) {
  const { country, channel, plan } = await searchParams;
  const selectedPlan = SPACE_PLAN_TYPES.find(type => type === plan);
  const channelId = parseChannelFilter(channel);
  const allSpaces = listSpaceDetails(db);
  const spaces = allSpaces.filter(({ space }) => {
    if (selectedPlan && space.planType !== selectedPlan) return false;
    if (country && space.country !== country) return false;
    if (
      channelId !== undefined &&
      space.paymentChannelId !== channelId
    ) {
      return false;
    }
    return true;
  });
  const channels = listChannels(db, true);
  const currencies = listCurrencies(db);
  const thresholds = getStatusThresholds(db);

  return (
    <SpaceTable
      spaces={spaces}
      filterSpaces={selectedPlan ? allSpaces.filter(row => row.space.planType === selectedPlan) : allSpaces}
      channels={channels}
      currencies={currencies}
      cnyRate={getCnyDisplayRate(db)}
      teamEarnings={getAccountEarnings(db)}
      selectedCountry={country || undefined}
      selectedPlan={selectedPlan}
      selectedChannel={channelId}
      spaceSoonDays={thresholds.spaceSoonDays}
    />
  );
}
