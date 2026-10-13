import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoneyDisplay } from "./money-display";

describe("dual-currency presentation", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("keeps CNY first and USD supplemental in the compact row layout", () => {
    vi.stubGlobal("React", React);
    const html = renderToStaticMarkup(React.createElement(MoneyDisplay, {
      value: -939, cnyRate: { minorUnit: 2, rateToUsd: "0.2" }, compact: true,
    }));
    expect(html.indexOf("-¥46.95")).toBeLessThan(html.indexOf("-$9.39"));
    expect(html).toContain("text-[11px]");
    expect(html).toContain("inline-flex items-baseline");
    expect(html).not.toContain("flex-col");
  });
});
