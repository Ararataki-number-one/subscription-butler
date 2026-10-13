import { requestFx } from "./request";

/** Bolivia's official Bs/USD quote. Fail closed if the bank changes the table. */
export const BCB_URL =
  "https://www.bcb.gob.bo/librerias/indicadores/otras/anteriores.php";

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

export function parseBcbQuote(html: string): { usdToBob: number; date: string } {
  const text = html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ");
  const dateMatch = text.match(/FECHA DE LA COTIZACI(?:Ó|&Oacute;)N:\s*(\d{1,2}) de ([a-z]+) (\d{4})/i);
  const officialTable = html.match(/Tipo de Cambio Oficial \(TCO\)[\s\S]*?<\/table>/i)?.[0];
  const rateMatch = officialTable?.match(/<td\b[^>]*>\s*USD\s*<\/td>\s*<td\b[^>]*>\s*(\d+(?:\.\d+)?)\s*<\/td>/i);
  if (!dateMatch || !rateMatch) throw new Error("BCB quotation table unavailable");
  const month = MONTHS.indexOf(dateMatch[2].toLowerCase()) + 1;
  const date = `${dateMatch[3]}-${String(month).padStart(2, "0")}-${dateMatch[1].padStart(2, "0")}`;
  const parsed = new Date(date);
  const usdToBob = Number(rateMatch[1]);
  if (!month || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ||
      !Number.isFinite(usdToBob) || usdToBob <= 0) throw new Error("Invalid BCB quotation");
  return { usdToBob, date };
}

export async function fetchBcbQuote() {
  const response = await requestFx(BCB_URL);
  if (!response.ok) throw new Error(`BCB ${response.status}`);
  return parseBcbQuote(await response.text());
}
