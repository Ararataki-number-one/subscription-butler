import { expiryStatus } from "@/lib/expiry";
import { Badge } from "@/components/ui/badge";
import { statusTone } from "@/components/ui/status-tone";

type ExpiryBadgeProps = {
  expiryDate: string | null;
  soonDays?: number;
  displayStatus?: "self";
  expireOnDate?: boolean;
};

const STATUS_BADGE = {
  expired: { label: "已逾期", className: statusTone("danger") },
  due: { label: "今日到期", className: statusTone("warning") },
  soon: { label: "即将到期", className: statusTone("warning") },
  normal: { label: "正常", className: statusTone("neutral") },
  self: { label: "自用", className: statusTone("info") },
  unknown: { label: "信息缺失", className: statusTone("neutral") },
} as const;

export function ExpiryBadge({
  expiryDate,
  soonDays = 7,
  displayStatus,
  expireOnDate = false,
}: ExpiryBadgeProps) {
  if (displayStatus) {
    const badge = STATUS_BADGE[displayStatus];
    return <Badge className={badge.className}>{badge.label}</Badge>;
  }

  if (!expiryDate) {
    const unknown = STATUS_BADGE.unknown;
    return <Badge className={unknown.className}>{unknown.label}</Badge>;
  }

  const status = expiryStatus(expiryDate, new Date(), soonDays, expireOnDate);
  const badge = STATUS_BADGE[status];
  return <Badge className={badge.className}>{badge.label}</Badge>;
}
