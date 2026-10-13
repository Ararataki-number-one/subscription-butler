// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { TestDb } from "@/test/db-harness";

// `frankfurter.ts` imports the production `db` singleton. Point it at a fresh
// in-memory test DB per test (mirrors actions/channels.test.ts).
const dbHolder = vi.hoisted(() => ({ current: null as unknown as TestDb }));
vi.mock("@/db", () => ({
  get db() {
    return dbHolder.current;
  },
}));

import { createTestDb } from "@/test/db-harness";
import { refreshFromApi, ensureFreshRates } from "@/lib/fx/frankfurter";
import { listRates, upsertRates } from "@/db/fxRates";
import { CURRENCY_SEED, seedCurrencies } from "@/db/seed";
import { BCB_HTML } from "@/test/bcb-fixture";
import { eq } from "drizzle-orm";
import { fxRate, space } from "@/db/schema";
import { insertSpaceWithMother } from "@/db/spaces";
import { insertChannel } from "@/db/channels";

const FIXED_USD_RATES: Record<string, number> = {
  CNY: 6.7982,
  EUR: 0.87712,
  JPY: 161.65,
};

/** Verified Frankfurter v1 response shape (USD→X), USD not echoed in `rates`. */
const USD_RATES = Object.fromEntries(
  CURRENCY_SEED.filter((currency) => !["USD", "BOB"].includes(currency.code)).map(
    (currency, index) => [
      currency.code,
      FIXED_USD_RATES[currency.code] ?? 1.2 + index / 10,
    ],
  ),
);

const VALID_RESPONSE = {
  amount: 1.0,
  base: "USD",
  date: "2026-06-26",
  rates: USD_RATES,
};

const CNY_TO_USD = 1 / VALID_RESPONSE.rates.CNY;
const VALID_CNY_RESPONSE = {
  amount: 1.0,
  base: "CNY",
  date: "2026-06-26",
  rates: Object.fromEntries(
    Object.entries({ ...VALID_RESPONSE.rates, USD: 1 })
      .filter(([code]) => code !== "CNY")
      .map(([code, usdToCode]) => [code, CNY_TO_USD * usdToCode]),
  ),
};

function okFetch(body: unknown) {
  return vi.fn().mockImplementation(async (url: string) => url.includes("bcb.gob.bo")
    ? { ok: true, text: async () => BCB_HTML }
    : { ok: true, json: async () => body });
}

/** Pre-populate a non-empty cache so fallback tests have something to fall back to. */
function seedCache(db: TestDb, fetchedAt: string) {
  upsertRates(
    db,
    CURRENCY_SEED.map((currency) => ({
      currencyCode: currency.code,
      rateToUsd: currency.code === "USD" ? "1" : "0.14000",
      fetchedAt,
    })),
  );
}

describe("frankfurter FX service (FX-01 / FX-03)", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    ctx = createTestDb();
    dbHolder.current = ctx.db;
    // FK enforcement is ON — currencies must exist before any fx_rate write.
    seedCurrencies(ctx.db);
  });

  afterEach(() => {
    ctx.sqlite.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("valid response → inverts USD→X to X→USD rows, USD pinned to '1', stale:false (D-02/D-03/D-04)", async () => {
    vi.stubGlobal("fetch", okFetch(VALID_RESPONSE));

    const result = await refreshFromApi();

    expect(result.stale).toBe(false);
    expect(result.fetchedAt).toBeTypeOf("string");

    const rows = listRates(ctx.db);
    expect(rows).toHaveLength(CURRENCY_SEED.length);
    expect(rows.find(({ rate }) => rate.currencyCode === "USD")?.rate.rateToUsd).toBe("1");
    // every cached rate is a positive finite decimal string (no 0/NULL/NaN)
    for (const { rate } of rows) {
      expect(Number(rate.rateToUsd)).toBeGreaterThan(0);
      expect(Number.isFinite(Number(rate.rateToUsd))).toBe(true);
    }
  });

  it("inversion precision: CNY 6.7982 → ~0.147098, JPY 161.65 → ~0.006186 (Pitfall 2)", async () => {
    vi.stubGlobal("fetch", okFetch(VALID_RESPONSE));

    await refreshFromApi();
    const rows = listRates(ctx.db);

    const cny = rows.find(({ rate }) => rate.currencyCode === "CNY")!.rate;
    const jpy = rows.find(({ rate }) => rate.currencyCode === "JPY")!.rate;
    expect(Number(cny.rateToUsd)).toBeCloseTo(1 / 6.7982, 8);
    expect(Number(jpy.rateToUsd)).toBeCloseTo(1 / 161.65, 8);
    // decimal string, not full float noise — bounded significant figures
    expect(cny.rateToUsd.replace(/[-.]/g, "").replace(/^0+/, "").length).toBeLessThanOrEqual(12);
  });

  it("CNY base response → normalizes back to X→USD rows", async () => {
    const fetchSpy = okFetch(VALID_CNY_RESPONSE);
    vi.stubGlobal("fetch", fetchSpy);

    await refreshFromApi("CNY");
    const rows = listRates(ctx.db);

    const usd = rows.find(({ rate }) => rate.currencyCode === "USD")!.rate;
    const cny = rows.find(({ rate }) => rate.currencyCode === "CNY")!.rate;
    const jpy = rows.find(({ rate }) => rate.currencyCode === "JPY")!.rate;
    expect(usd.rateToUsd).toBe("1");
    expect(Number(cny.rateToUsd)).toBeCloseTo(1 / 6.7982, 8);
    expect(Number(jpy.rateToUsd)).toBeCloseTo(1 / 161.65, 8);

    const calledUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("base=CNY");
    expect(calledUrl).toContain("USD");
  });

  it("fetch throws/times out → returns last cache + stale:true, DB unchanged (FX-03)", async () => {
    seedCache(ctx.db, "2026-06-20T00:00:00.000Z");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError")),
    );

    const before = listRates(ctx.db);
    const result = await refreshFromApi();

    expect(result.stale).toBe(true);
    expect(result.rates).toHaveLength(CURRENCY_SEED.length);
    expect(result.fetchedAt).toBe("2026-06-20T00:00:00.000Z");
    // DB untouched — the failed fetch wrote nothing.
    expect(listRates(ctx.db)).toEqual(before);
  });

  it("non-ok HTTP status → falls back to cache + stale:true, no write", async () => {
    seedCache(ctx.db, "2026-06-20T00:00:00.000Z");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }),
    );

    const before = listRates(ctx.db);
    const result = await refreshFromApi();

    expect(result.stale).toBe(true);
    expect(listRates(ctx.db)).toEqual(before);
  });

  it("malformed / 0 / negative rate → Zod rejects, NO write, falls back to cache (Pitfall 1)", async () => {
    seedCache(ctx.db, "2026-06-20T00:00:00.000Z");
    const POISONED = {
      ...VALID_RESPONSE,
      rates: { ...VALID_RESPONSE.rates, CNY: 0, EUR: -1 },
    };
    vi.stubGlobal("fetch", okFetch(POISONED));

    const before = listRates(ctx.db);
    const result = await refreshFromApi();

    expect(result.stale).toBe(true);
    // nothing poisoned — CNY still the cached value, never 0
    expect(listRates(ctx.db)).toEqual(before);
    expect(listRates(ctx.db).find(({ rate }) => rate.currencyCode === "CNY")?.rate.rateToUsd).toBe("0.14000");
  });

  it("empty cache + failed fetch → rates:[], no crash, no fake zeros (Pitfall 5)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await refreshFromApi();

    expect(result.rates).toEqual([]);
    expect(result.stale).toBe(false); // empty cache is not "stale" — there is nothing to be stale
    expect(result.fetchedAt).toBeNull();
    expect(listRates(ctx.db)).toEqual([]);
  });

  it("ensureFreshRates: fresh cache is served without fetching", async () => {
    seedCache(ctx.db, new Date().toISOString());
    const fetchSpy = okFetch(VALID_RESPONSE);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await ensureFreshRates();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.stale).toBe(false);
    expect(result.rates).toHaveLength(CURRENCY_SEED.length);
  });

  it("ensureFreshRates: stale-by-age cache (>~1 day) triggers a refresh (D-07)", async () => {
    seedCache(ctx.db, "2026-06-20T00:00:00.000Z"); // ~8 days before the 06-28 'today'
    const fetchSpy = okFetch(VALID_RESPONSE);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await ensureFreshRates();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.stale).toBe(false);
    // refreshed CNY now reflects the inverted live rate, not the old cached 0.14000
    expect(Number(result.rates.find(({ rate }) => rate.currencyCode === "CNY")!.rate.rateToUsd)).toBeCloseTo(
      1 / 6.7982,
      8,
    );
  });

  it("ensureFreshRates: empty cache triggers a refresh", async () => {
    const fetchSpy = okFetch(VALID_RESPONSE);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await ensureFreshRates();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.rates).toHaveLength(CURRENCY_SEED.length);
  });

  it("only frankfurter.ts calls the Frankfurter URL (anti-corruption boundary)", async () => {
    const fetchSpy = okFetch(VALID_RESPONSE);
    vi.stubGlobal("fetch", fetchSpy);

    await refreshFromApi();

    const calledUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("api.frankfurter.dev");
    expect(calledUrl).toContain("base=USD");
  });

  it("refreshes at the five-minute boundary while reusing younger cached quotes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-12T02:00:00Z"));
    try {
      seedCache(ctx.db, new Date(Date.now() - 299999).toISOString());
      const spy = okFetch(VALID_RESPONSE); vi.stubGlobal("fetch", spy);
      await ensureFreshRates();
      expect(spy).not.toHaveBeenCalled();
      vi.setSystemTime(new Date(Date.now() + 1));
      await ensureFreshRates();
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("shares simultaneous automatic and manual refresh requests", async () => {
    const spy = okFetch(VALID_RESPONSE); vi.stubGlobal("fetch", spy);
    await Promise.all([refreshFromApi(), refreshFromApi(), ensureFreshRates()]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("keeps quotes and current costs unchanged if revaluation fails", async () => {
    seedCache(ctx.db, "2026-06-20T00:00:00Z");
    insertSpaceWithMother(ctx.db, { name: "Overflow", country: "US",
      paymentChannelId: insertChannel(ctx.db, "Card").id, currencyCode: "USD",
      amountMinor: Number.MAX_SAFE_INTEGER, amountUsd: 1, feePercent: "100" }, "owner@example.com");
    const beforeRates = listRates(ctx.db); const beforeSpaces = ctx.db.select().from(space).all();
    vi.stubGlobal("fetch", okFetch(VALID_RESPONSE));
    expect((await refreshFromApi()).stale).toBe(true);
    expect(listRates(ctx.db)).toEqual(beforeRates);
    expect(ctx.db.select().from(space).all()).toEqual(beforeSpaces);
  });

  it("stores BOB official provenance and excludes BOB from the ECB request", async () => {
    const spy = okFetch(VALID_RESPONSE);
    vi.stubGlobal("fetch", spy);
    const result = await refreshFromApi("USD");
    const bob = result.rates.find(({ rate }) => rate.currencyCode === "BOB")!.rate;
    expect(Number(bob.rateToUsd)).toBeCloseTo(1 / 12.05, 12);
    expect(bob.quoteDate).toBe("2026-09-27");
    expect(bob.source).toBe("bcb");
    expect(String(spy.mock.calls[0][0])).not.toContain("BOB");
    expect(result.rates.find(({ rate }) => rate.currencyCode === "CNY")!.rate.quoteDate).toBe("2026-06-26");
  });

  it("refreshes a missing currency even when the other cached rows are fresh", async () => {
    seedCache(ctx.db, new Date().toISOString());
    ctx.db.delete(fxRate).where(eq(fxRate.currencyCode, "BOB")).run();
    const spy = okFetch(VALID_RESPONSE);
    vi.stubGlobal("fetch", spy);
    const result = await ensureFreshRates();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.rates).toHaveLength(CURRENCY_SEED.length);
  });

  it("an old row cannot be masked by another recently updated row", async () => {
    seedCache(ctx.db, new Date().toISOString());
    upsertRates(ctx.db, [{ currencyCode: "BOB", rateToUsd: "0.14", fetchedAt: "2020-01-01T00:00:00Z" }]);
    const spy = okFetch(VALID_RESPONSE);
    vi.stubGlobal("fetch", spy);
    await ensureFreshRates();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("BCB failure keeps the entire previous cache unchanged", async () => {
    seedCache(ctx.db, "2026-06-20T00:00:00Z");
    const before = listRates(ctx.db);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) =>
      url.includes("bcb.gob.bo") ? { ok: true, text: async () => "unavailable" }
        : { ok: true, json: async () => VALID_RESPONSE }));
    expect((await refreshFromApi()).stale).toBe(true);
    expect(listRates(ctx.db)).toEqual(before);
  });

  it("rejects an unexpected quote amount before updating the cache", async () => {
    seedCache(ctx.db, "2026-06-20T00:00:00Z");
    const before = listRates(ctx.db);
    vi.stubGlobal("fetch", okFetch({ ...VALID_RESPONSE, amount: 100 }));
    expect((await refreshFromApi()).stale).toBe(true);
    expect(listRates(ctx.db)).toEqual(before);
  });
});
