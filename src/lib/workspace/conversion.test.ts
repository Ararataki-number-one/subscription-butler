import {expect,it} from "vitest";
import {convertCurrencyMinor} from "../money";
it("keeps same-currency estimates exact without intermediate USD rounding",()=>{
  expect(convertCurrencyMinor(8000,2,"0.14942448",2,"0.14942448")).toBe(8000);
  expect(convertCurrencyMinor(-8000,2,"0.14942448",2,"0.14942448")).toBe(-8000);
  expect(convertCurrencyMinor(1000,0,"0.007",2,"0.14")).toBe(5000);
});
