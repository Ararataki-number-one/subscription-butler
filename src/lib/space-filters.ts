/** URL query values must agree with the channel selector's "all" state. */
export function parseChannelFilter(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return undefined;
  const id = Number(value.trim());
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
