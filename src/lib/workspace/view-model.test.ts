import { expect,it } from "vitest";
import type { OperationsSnapshot } from "../operations/types";
import {calendarDays,dueCategory,shanghaiToday,workbench} from "./view-model";
it("uses Shanghai dates across UTC day boundaries",()=>expect(shanghaiToday(new Date("2026-10-12T20:00:00Z"))).toBe("2026-10-13"));
it("shows payment risk and leap-year calendars",()=>{
  expect(dueCategory("2026-10-12","2026-10-13")).toBe("逾期");
  expect(dueCategory("2026-10-13","2026-10-13")).toBe("今日到期");
  expect(dueCategory("2026-10-20","2026-10-13")).toBe("近期到期");
  expect(calendarDays("2028-02")).toHaveLength(29);
  expect(calendarDays("2026-13")).toEqual([]);
});
it.each([
  {status:"active",expected:1},
  {status:"disabled",expected:0},
  {status:undefined,expected:0},
] as const)("only offers vacant positions belonging to an active subscription ($status)",({status,expected})=>{
  const snapshot:OperationsSnapshot = {
    version:1,changeSeq:0,channels:[],customers:[],templates:[],plans:[],rentals:[],bills:[],entries:[],
    subscriptions:status ? [{
      id:"subscription",kind:"subscription",revision:1,updatedAt:"2026-10-13T00:00:00Z",
      data:{name:"Synthetic service",service:"Any SaaS",planName:"",account:"",currency:"CNY",amountMinor:0,feePercent:"0",period:{unit:"month",count:1},startDate:"2026-10-01",endDate:"2026-11-01",status,allocation:"daily",tags:[],group:"",note:""},
    }] : [],
    slots:[{
      id:"slot",kind:"slot",revision:1,updatedAt:"2026-10-13T00:00:00Z",
      data:{subscriptionId:"subscription",label:"Synthetic position",account:"",kind:"generic",weight:1,status:"available",tags:[],group:"",note:""},
    }],
  };
  const before=structuredClone(snapshot);
  expect(workbench(snapshot,"2026-10-13").vacant).toHaveLength(expected);
  expect(snapshot).toEqual(before);
});
