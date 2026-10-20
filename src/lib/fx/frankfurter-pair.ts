import { z } from "zod";
import { requestFx } from "./request";

// Non-ECB currencies use a USD pair, independent of the user's display base.
export const V2_CURRENCIES = ["EGP", "CLP"] as const;
type PairCurrency = (typeof V2_CURRENCIES)[number];
const quoteSchema = z.object({
  base: z.literal("USD"), quote: z.enum(V2_CURRENCIES),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }),
  rate: z.number().finite().positive(),
});
export async function fetchPairQuote(currency: PairCurrency) {
  const response = await requestFx(`https://api.frankfurter.dev/v2/rate/USD/${currency}`);
  if (!response.ok) throw new Error(`Frankfurter ${currency} ${response.status}`);
  const quote = quoteSchema.parse(await response.json());
  if (quote.quote !== currency) throw new Error("Frankfurter pair currency mismatch");
  return { usdToQuote: quote.rate, date: quote.date };
}
