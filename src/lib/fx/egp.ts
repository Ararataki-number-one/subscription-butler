import { z } from "zod";
import { requestFx } from "./request";

// Frankfurter v1 covers ECB currencies; EGP is supplied by its v2 pair endpoint.
export const EGP_URL = "https://api.frankfurter.dev/v2/rate/USD/EGP";
const quoteSchema = z.object({
  base: z.literal("USD"), quote: z.literal("EGP"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }),
  rate: z.number().finite().positive(),
});
export async function fetchEgpQuote() {
  const response = await requestFx(EGP_URL);
  if (!response.ok) throw new Error(`Frankfurter EGP ${response.status}`);
  const quote = quoteSchema.parse(await response.json());
  return { usdToEgp: quote.rate, date: quote.date };
}
