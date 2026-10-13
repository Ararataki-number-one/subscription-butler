export const CHANNEL_TYPES = ["card", "wallet", "transfer", "platform", "reseller", "other"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export const CHANNEL_TYPE_OPTIONS: { value: ChannelType; label: string }[] = [
  { value: "card", label: "银行卡 / 虚拟卡" },
  { value: "wallet", label: "电子钱包" },
  { value: "transfer", label: "银行转账" },
  { value: "platform", label: "平台购买" },
  { value: "reseller", label: "代付 / 服务商" },
  { value: "other", label: "其他 / 未分类" },
];
export function channelTypeLabel(type: string): string {
  return CHANNEL_TYPE_OPTIONS.find(option => option.value === type)?.label ?? "其他 / 未分类";
}
