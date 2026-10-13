import { describe, expect, it } from "vitest";
import { parseBcbQuote } from "./bcb";
import { BCB_HTML } from "@/test/bcb-fixture";

describe("Bolivia official quotation", () => {
  it("reads the dated official Bs/USD quotation", () => {
    expect(parseBcbQuote(BCB_HTML)).toEqual({ usdToBob: 12.05, date: "2026-09-27" });
  });
  it.each([
    BCB_HTML.replace("12.05", "0"),
    BCB_HTML.replace("<td>USD</td>", "<td>EUR</td>"),
    BCB_HTML.replace("27 de Septiembre", "31 de Septiembre"),
    BCB_HTML.replace("Tipo de Cambio Oficial (TCO)", "Other quotation"),
    "<html>unavailable</html>",
  ])("rejects missing, invalid or unrelated quotations", (html) => {
    expect(() => parseBcbQuote(html)).toThrow();
  });
});
