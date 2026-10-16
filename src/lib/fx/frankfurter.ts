// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
import { db } from "@/db";
import { listCurrencies } from "@/db/currencies";
import { listRates, upsertRates, getMostRecentFetchedAt } from "@/db/fxRates";
import type { FxRateListRow } from "@/db/fxRates";
import { DEFAULT_RATE_BASE, type RateBase } from "@/lib/fx/base";
import { frankfurterResponseSchema } from "@/lib/validation/fx";
import { fetchBcbQuote } from "./bcb";
import { fetchEgpQuote } from "./egp";
import { FX_REFRESH_INTERVAL_MS } from "./constants";
import { revalueCurrentAccounts } from "@/db/currentValuation";
import { requestFx } from "./request";

/**
 * FX-01 / FX-03 — anti-corruption Frankfurter service (T-02-01..03, T-02-09).
 *
 * This is the ONLY module that talks to Frankfurter. Everything else in the app
 * reads the local `fx_rate` cache. The fetch is time-bounded (D-09) and the
 * untrusted response is Zod-validated (ASVS V5) BEFORE being inverted and
 * atomically upserted. On ANY failure (timeout, non-ok, malformed, poisoned
 * rate) the service writes nothing and falls back to the last good cache,
 * flagging it stale only when a non-empty cache exists (D-04 / Pitfalls 1+5).
 *
 * better-sqlite3 is a native module — this module must run on the Node runtime,
 * never Edge.
 */

const FRANKFURTER_URL = "https://api.frankfurter.dev/v1/latest";
const CACHE_TTL_MS = FX_REFRESH_INTERVAL_MS;
let inFlight: Promise<FxResult> | null = null;

export type FxResult = {
  rates: FxRateListRow[];
  fetchedAt: string | null;
  stale: boolean;
};

function toSignificantDecimal(value: number): string {
  if (!Number.isFinite(value) || value <= 0) throw new Error("bad rate");
  return String(Number(value.toPrecision(12)));
}

/**
 * 1 USD = `usdToX` units of X → 1 X = (1 / usdToX) USD, as a fixed-precision
 * decimal STRING (never a float column). Rejects non-finite/non-positive input
 * so a 0/negative/Infinity rate can never poison Phase 3 USD math (T-02-03).
 */
export function invertToUsd(usdToX: number): string {
  return toSignificantDecimal(1 / usdToX);
}

function rateToUsdFromBase(
  code: string,
  base: RateBase,
  rates: Record<string, number>,
): string {
  if (code === "USD") return "1";

  const baseToUsd = base === "USD" ? 1 : rates.USD;
  if (!Number.isFinite(baseToUsd) || baseToUsd <= 0) throw new Error("bad rate");

  if (code === base) {
    return toSignificantDecimal(baseToUsd);
  }

  const baseToCode = rates[code];
  if (!Number.isFinite(baseToCode) || baseToCode <= 0) throw new Error("bad rate");
  return toSignificantDecimal(baseToUsd / baseToCode);
}

/** Snapshot the current cache as the stale-fallback result (writes nothing). */
function fallbackToCache(): FxResult {
  const cached = listRates(db);
  return {
    rates: cached,
    fetchedAt: getMostRecentFetchedAt(db),
    stale: cached.length > 0, // empty cache is not "stale" — nothing to be stale (Pitfall 5)
  };
}

/**
 * Always attempt a live fetch (the manual "refresh rates" path, D-06). On
 * success: validate → invert → atomic upsert → return fresh rows with
 * stale:false (a successful fetch is never stale, regardless of age — D-04).
 * On any throw: fall back to cache, write nothing.
 */
async function fetchAndRefresh(
  base: RateBase = DEFAULT_RATE_BASE,
): Promise<FxResult> {
  try {
    const currencyCodes = listCurrencies(db).map((currency) => currency.code);
    const needsBob = currencyCodes.includes("BOB");
    const needsEgp = currencyCodes.includes("EGP");
    const symbols = Array.from(
      new Set(
        [...currencyCodes.filter((code) => code !== base && code !== "BOB" && code !== "EGP"), "USD"].filter(
          (code) => code !== base,
        ),
      ),
    );

    if (symbols.length === 0 && !needsBob && !needsEgp) {
      const fetchedAt = new Date().toISOString();
      db.transaction(tx => {
        upsertRates(tx, [{ currencyCode: "USD", rateToUsd: "1", fetchedAt }]);
        revalueCurrentAccounts(tx);
      });
      return { rates: listRates(db), fetchedAt, stale: false };
    }

    const url = `${FRANKFURTER_URL}?base=${base}&symbols=${symbols.join(",")}`;
    const [data, bob, egp] = await Promise.all([
      (async () => {
        if (!symbols.length) {
          return { amount: 1, base, date: new Date().toISOString().slice(0, 10), rates: {} as Record<string, number> };
        }
        const res = await requestFx(url);
        if (!res.ok) throw new Error(`Frankfurter ${res.status}`);
        return frankfurterResponseSchema.parse(await res.json());
      })(),
      needsBob ? fetchBcbQuote() : Promise.resolve(null),
      needsEgp ? fetchEgpQuote() : Promise.resolve(null),
    ]);
    if (data.base !== base) {
      throw new Error(`Frankfurter response base mismatch: ${data.base}`);
    }
    const missing = symbols.filter((code) => data.rates[code] === undefined);
    if (missing.length > 0) {
      throw new Error(`Frankfurter response missing rates: ${missing.join(",")}`);
    }

    const fetchedAt = new Date().toISOString();
    const rows = currencyCodes.map((code) => ({
      currencyCode: code,
      rateToUsd: code === "BOB" && bob
        ? invertToUsd(bob.usdToBob)
        : code === "EGP" && egp ? invertToUsd(egp.usdToEgp)
        : rateToUsdFromBase(code, base, data.rates),
      fetchedAt,
      quoteDate: code === "BOB" && bob ? bob.date : code === "EGP" && egp ? egp.date : data.date,
      source: code === "BOB" ? "bcb" : code === "EGP" ? "frankfurter-v2" : "frankfurter",
    }));
    db.transaction(tx => {
      upsertRates(tx, rows);
      revalueCurrentAccounts(tx);
    });

    return { rates: listRates(db), fetchedAt, stale: false };
  } catch {
    // FX-03 / Success Criterion 3: never write 0/NULL; serve last good cache.
    return fallbackToCache();
  }
}

/** Share concurrent background, page and manual refreshes. */
export function refreshFromApi(base: RateBase = DEFAULT_RATE_BASE): Promise<FxResult> {
  if (inFlight) return inFlight;
  inFlight = fetchAndRefresh(base).finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * Lazy age-gated refresh used by the Rates screen RSC (D-07/D-08): if the cache
 * is younger than five minutes, serve it as-is (stale:false — age does NOT drive the
 * stale flag, D-04). If the cache is empty or older, attempt a refresh (which
 * may itself fall back to cache on failure).
 */
export async function ensureFreshRates(
  base: RateBase = DEFAULT_RATE_BASE,
): Promise<FxResult> {
  if (inFlight) return inFlight;
  const fetchedAt = getMostRecentFetchedAt(db);
  const cached = listRates(db);
  const codes = listCurrencies(db).map(({ code }) => code);
  const isFresh =
    codes.length > 0 && codes.every((code) => cached.some(({ rate }) =>
      rate.currencyCode === code &&
      new Date(rate.fetchedAt).getTime() > Date.now() - CACHE_TTL_MS
    ));

  if (isFresh) {
    try { revalueCurrentAccounts(db); } catch { return fallbackToCache(); }
    return { rates: cached, fetchedAt, stale: false };
  }
  return refreshFromApi(base);
}
