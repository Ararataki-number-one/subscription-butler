import { afterEach, describe, expect, it, vi } from "vitest";
import { requestFx } from "./request";
describe("bounded FX network retry", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("recovers once from a transient connection error", async () => {
    const response = { ok: true } as Response;
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetcher);
    expect(await requestFx("https://api.frankfurter.dev/v1/latest")).toBe(response);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("stops after the second failure instead of creating an unbounded loop", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetcher);
    await expect(requestFx("https://api.frankfurter.dev/v1/latest")).rejects.toThrow("offline");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
