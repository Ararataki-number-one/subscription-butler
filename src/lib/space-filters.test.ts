import { describe, expect, it } from "vitest";
import { parseChannelFilter } from "./space-filters";

describe("payment channel URL filter", () => {
  it("keeps the all-channel view for zero, blank and malformed queries", () => {
    for (const value of [undefined, "", " ", "0", "-1", "1.5", "1e2", "all", "Infinity", "9007199254740992", ["1", "2"]]) {
      expect(parseChannelFilter(value)).toBeUndefined();
    }
  });
  it("accepts a positive channel ID", () => {
    expect(parseChannelFilter("1")).toBe(1);
    expect(parseChannelFilter(" 12 ")).toBe(12);
  });
});
