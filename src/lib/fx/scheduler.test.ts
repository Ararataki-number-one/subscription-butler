import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ refresh: vi.fn().mockResolvedValue({ stale: false }) }));
vi.mock("./frankfurter", () => ({ refreshFromApi: mocks.refresh }));
import { startFxRefreshScheduler } from "./scheduler";
import { FX_REFRESH_INTERVAL_MS } from "./constants";
const shared = globalThis as unknown as { fxRefreshTimer?: NodeJS.Timeout };

describe("global five-minute FX scheduler", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubEnv("NODE_ENV", "production"); mocks.refresh.mockClear(); });
  afterEach(() => { if (shared.fxRefreshTimer) clearInterval(shared.fxRefreshTimer); delete shared.fxRefreshTimer; vi.useRealTimers(); vi.unstubAllEnvs(); });
  it("refreshes at startup and every five minutes, with one timer across repeated layout renders", async () => {
    startFxRefreshScheduler(); startFxRefreshScheduler();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FX_REFRESH_INTERVAL_MS - 1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(FX_REFRESH_INTERVAL_MS);
    expect(mocks.refresh).toHaveBeenCalledTimes(3);
  });
  it("does not start a background task during builds or ordinary tests", () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build"); startFxRefreshScheduler();
    expect(mocks.refresh).not.toHaveBeenCalled();
    vi.stubEnv("NEXT_PHASE", ""); vi.stubEnv("NODE_ENV", "test"); startFxRefreshScheduler();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
