import { expect,it } from "vitest";
import {calendarDays,dueCategory,shanghaiToday} from "./view-model";
it("uses Shanghai dates across UTC day boundaries",()=>expect(shanghaiToday(new Date("2026-10-12T20:00:00Z"))).toBe("2026-10-13"));
it("shows payment risk and leap-year calendars",()=>{
  expect(dueCategory("2026-10-12","2026-10-13")).toBe("逾期");
  expect(dueCategory("2026-10-13","2026-10-13")).toBe("今日到期");
  expect(dueCategory("2026-10-20","2026-10-13")).toBe("近期到期");
  expect(calendarDays("2028-02")).toHaveLength(29);
  expect(calendarDays("2026-13")).toEqual([]);
});
