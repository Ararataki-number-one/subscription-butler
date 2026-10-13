import { refreshFromApi } from "./frankfurter";
import { FX_REFRESH_INTERVAL_MS } from "./constants";

const shared = globalThis as unknown as { fxRefreshTimer?: NodeJS.Timeout };
export function startFxRefreshScheduler() {
  if (typeof window !== "undefined" || process.env.NODE_ENV === "test"
    || process.env.NEXT_PHASE === "phase-production-build" || process.env.npm_lifecycle_event === "build"
    || shared.fxRefreshTimer) return;
  const tick = () => { void refreshFromApi().catch(() => {}); };
  tick();
  shared.fxRefreshTimer = setInterval(tick, FX_REFRESH_INTERVAL_MS);
  shared.fxRefreshTimer.unref?.();
}
