import {expect,it} from "vitest";
import {IdentityScope,StaleIdentityError} from "./identity";
it("never restores the previous owner's data when their request completes after a member switch",async()=>{
  const scope=new IdentityScope();let release!:(value:string)=>void;let visible="owner";
  const delayed=scope.guard(()=>new Promise<string>(resolve=>{release=resolve;})).then(value=>{visible=value;});
  scope.advance();visible="customer";release("owner ledger");
  await expect(delayed).rejects.toBeInstanceOf(StaleIdentityError);expect(visible).toBe("customer");
});
it("does not apply an old authorization error to the new identity",async()=>{
  const scope=new IdentityScope();let reject!:(error:Error)=>void;
  const delayed=scope.guard(()=>new Promise<void>((_resolve,fail)=>{reject=fail;}));
  scope.advance();reject(Object.assign(new Error("401"),{status:401}));
  await expect(delayed).rejects.toBeInstanceOf(StaleIdentityError);
  await expect(scope.guard(async()=>"new identity")).resolves.toBe("new identity");
});
