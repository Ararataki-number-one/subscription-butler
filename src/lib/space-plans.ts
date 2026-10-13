export const SPACE_PLAN_TYPES = ["team", "plus", "pro5x", "pro20x", "custom"] as const;
export type SpacePlanType = (typeof SPACE_PLAN_TYPES)[number];
export const SHARING_MODES = ["single", "shared"] as const;
export type SharingMode = (typeof SHARING_MODES)[number];
export function isProPlan(type: string): boolean {
  return type === "pro5x" || type === "pro20x";
}
export function supportsMembers(type: string, mode: string): boolean {
  return type === "team" || (isProPlan(type) && (mode === "single" || mode === "shared"));
}

export const SPACE_PLAN_OPTIONS: { value: SpacePlanType; label: string }[] = [
  { value: "team", label: "Business" },
  { value: "plus", label: "Plus" },
  { value: "pro5x", label: "Pro 5x" },
  { value: "pro20x", label: "Pro 20x" },
  { value: "custom", label: "其他订阅" },
];

export function spacePlanLabel(type: string, customName = ""): string {
  if (type === "custom" && customName) return customName;
  return SPACE_PLAN_OPTIONS.find(option => option.value === type)?.label ?? type;
}

export function isIndependentPlan(type: string): boolean {
  return type !== "team";
}
