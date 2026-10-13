import { describe, expect, it } from "vitest";
import { parseCsv, previewCsv, writeCsv } from "./csv";
describe("CSV data exchange", () => {
  it("reads quoted multiline fields, BOM and escaped quotes", () => {
    expect(parseCsv('\uFEFFname,note\r\nExample,"line 1\nline 2, ""quoted"""')).toEqual([["name","note"],["Example",'line 1\nline 2, "quoted"']]);
  });
  it("reports invalid rows and detects duplicate imports before commit", () => {
    expect(previewCsv("name,contact\nA,a\nA,a\n,b\nC\n",["name"])).toEqual({rows:[{name:"A",contact:"a"}],sourceLines:[2],duplicates:1,errors:[{line:4,message:"未填写 name"},{line:5,message:"列数与标题不一致。"}]});
  });
  it("keeps the original line for later validation after duplicate rows are removed", () => {
    const preview = previewCsv("billId,currency,amount,date\nbill:a,CNY,10,2026-01-01\nbill:a,CNY,10,2026-01-01\nbill:b,CNY,-1,2026-01-02", ["billId", "currency", "amount", "date"]);
    const errors = preview.rows.flatMap((row, index) => Number(row.amount) < 0 ? [{ line: preview.sourceLines[index], message: "金额格式无效或为负数。" }] : []);
    expect(preview.sourceLines).toEqual([2, 4]);
    expect(preview.duplicates).toBe(1);
    expect(errors).toEqual([{ line: 4, message: "金额格式无效或为负数。" }]);
    expect(parseCsv(writeCsv([["行号", "错误"], ...errors.map(row => [row.line, row.message])]))[1][0]).toBe("4");
  });
  it("retains physical source lines across empty, rejected and quoted multiline rows", () => {
    const source = '\uFEFF\r\nname,note\r\n\r\nA,"one\r\ntwo"\r\nA,"one\r\ntwo"\r\n,bad\r\nC\r\nD,end';
    const preview = previewCsv(source, ["name"]);
    expect(preview.rows).toEqual([{ name: "A", note: "one\r\ntwo" }, { name: "D", note: "end" }]);
    expect(preview.sourceLines).toEqual([4, 10]);
    expect(preview.duplicates).toBe(1);
    expect(preview.errors).toEqual([{ line: 8, message: "未填写 name" }, { line: 9, message: "列数与标题不一致。" }]);
  });
  it("rejects malformed quotes and neutralizes spreadsheet formulas", () => {
    expect(() => parseCsv('name\n"open')).toThrow();
    expect(() => parseCsv('name\n"closed"oops')).toThrow();
    expect(parseCsv(writeCsv([["=HYPERLINK(\"evil\")","normal"]]))[0][0]).toBe("'=HYPERLINK(\"evil\")");
  });
});
