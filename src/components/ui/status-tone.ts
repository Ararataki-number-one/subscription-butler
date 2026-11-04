/** Presentation only. Status decisions stay with each feature's existing rules. */
const tones = {
  neutral: "border-border bg-muted/50 text-muted-foreground",
  success: "border-primary/20 bg-primary/10 text-primary",
  warning: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
  danger: "border-destructive/25 bg-destructive/10 text-destructive",
  info: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200",
  draft: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
} as const;

export type StatusTone = keyof typeof tones;

export function statusTone(tone: StatusTone): string {
  return tones[tone];
}
