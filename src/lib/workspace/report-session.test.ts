import {expect,it} from "vitest";
import {ReportSession} from "./report-session";

it("refreshes with the last computed filters and preserves them after failed edits",()=>{
  const scope=new ReportSession(),draft={customerId:"a",from:"2026-10-01"};
  const first=scope.begin(draft);expect(scope.refreshFilters()).toBeNull();
  expect(first.commit()).toBe(true);first.finish();draft.customerId="not-submitted";
  expect(scope.refreshFilters()).toEqual({customerId:"a",from:"2026-10-01"});
  const failed=scope.begin({customerId:"b"});failed.finish();
  expect(scope.refreshFilters()).toEqual({customerId:"a",from:"2026-10-01"});
});
it("prevents an older automatic refresh from replacing a newer manual calculation",()=>{
  const scope=new ReportSession();
  const old=scope.begin({customerId:"a"}),manual=scope.begin({customerId:"b"});
  expect(old.commit()).toBe(false);old.finish();expect(scope.refreshFilters()).toBeNull();
  expect(manual.commit()).toBe(true);manual.finish();expect(scope.refreshFilters()).toEqual({customerId:"b"});
});
it("clears applied filters and rejects late completions across identity changes",()=>{
  const scope=new ReportSession(),old=scope.begin({customerId:"private-owner"});
  scope.reset();expect(old.commit()).toBe(false);old.finish();expect(scope.refreshFilters()).toBeNull();
});
