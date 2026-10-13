import { describe, expect, it } from "vitest";
import { parseCsv, previewCsv, writeCsv } from "./csv";
describe("CSV data exchange", () => {
  it("reads quoted multiline fields, BOM and escaped quotes", () => {
    expect(parseCsv('\uFEFFname,note\r\nExample,"line 1\nline 2, ""quoted"""')).toEqual([["name","note"],["Example",'line 1\nline 2, "quoted"']]);
  });
  it("reports invalid rows and detects duplicate imports before commit", () => {
    expect(previewCsv("name,contact\nA,a\nA,a\n,b\nC\n",["name"])).toEqual({rows:[{name:"A",contact:"a"}],duplicates:1,errors:[{line:4,message:"未填写 name"},{line:5,message:"列数与标题不一致。"}]});
  });
  it("rejects malformed quotes and neutralizes spreadsheet formulas", () => {
    expect(() => parseCsv('name\n"open')).toThrow();
    expect(() => parseCsv('name\n"closed"oops')).toThrow();
    expect(parseCsv(writeCsv([["=HYPERLINK(\"evil\")","normal"]]))[0][0]).toBe("'=HYPERLINK(\"evil\")");
  });
});
